import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { encoder, decoder } from './backup-crypto.cjs';
import { TG_ACCOUNT_ID, TG_PROFILE_MAX_BYTES, tgProfileDataName, tgHostingSettings, tgDiskReserve, tgMemoryBudget, tgCpuTotal, tgBrowserGrowthMb, tgRetryDelay, tgRuntimeAccount, tgDiskNeedsParking, tgHostIsolationBlock, tgBrowserLimitError, tgContainerHealth, tgCrashAttempts } from './shared/tg-hosting.js';
import { createTgDockerClient } from './shared/tg-docker.js';
import { createTgCpuGroup } from './shared/tg-cpu-group.js';
import { relayTgFrame } from './shared/tg-frame-relay.js';
import { createProfileStorage, scanProfile } from './shared/tg-profile-storage.js';
import { tgLoginStatus } from './shared/tg-login-state.js';
import { readLoginFile } from './shared/tg-login-monitor.js';

const socket = process.env.TG_HOSTING_SOCKET || '/control/runner.sock';
const dockerSocket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const image = process.env.TG_BROWSER_IMAGE || 'nurossh-tg-browser:local';
const runtimeName = process.env.TG_RUNNER_CONTAINER || 'nurossh-tg-runner';
const profiles = '/profiles', snapshots = '/snapshots';
// Use this release's validator even when the installed Chromium image is pinned.
const archiveSource = fs.readFileSync(new URL('./profile-archive.py', import.meta.url), 'utf8');
const verifiedSnapshots = new Map();
const rows = new Map(), attached = new Set();
const memorySamples = new Map();
let settings = tgHostingSettings(), key = null, hostProfiles, namespace, backupLease = null, closed = false, mutating = false;
let resourceCache = null, resourceCacheAt = 0, resourceReading = null;
let dockerCapacity = null, capacityAt = 0;
let migrationHold = false;
let configured = false;
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const idCheck = id => { if (!TG_ACCOUNT_ID.test(id)) fail('账号标识无效'); return id; };
const label = () => ({ 'nurossh.tg.owner': namespace });
const name = id => `nurossh-tg-${namespace}-${id}`;
const activeMarker = id => path.join(profiles, `.active-${id}`);
const profileMarker = id => path.join(snapshots, `${id}.profile-known`);
async function markProfileKnown(id) {
  const row = rows.get(id);
  if (!fs.existsSync(profileMarker(id))) {
    const stage = `${profileMarker(id)}.partial`;
    await fsp.rm(stage, { force: true });
    try {
      const handle = await fsp.open(stage, 'wx', 0o600);
      try { await handle.writeFile('profile-created\n'); await fsp.chown(stage, 10001, 10001); await handle.sync(); } finally { await handle.close(); }
      await fsp.rename(stage, profileMarker(id));
    } finally { await fsp.rm(stage, { force: true }); }
    const directory = await fsp.open(snapshots, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  if (row) row.profileExpected = true;
}
function requireSavedProfile(id) {
  if (rows.get(id)?.profileExpected || fs.existsSync(profileMarker(id)) || fs.existsSync(activeMarker(id))) {
    fail('已有账号的登录目录和快照均缺失，已停止启动或备份；请恢复原资料，不会创建空白会话', 503);
  }
}
const active = () => [...rows.values()].filter(row => ['starting', 'running', 'stopping', 'saving'].includes(row.state));
function retryResourceWaiters() {
  for (const row of rows.values()) if (row.state === 'queued' && row.resourceAttempts) { row.retryAt = 0; row.resourceAttempts = 0; }
}

async function markProfileActive(id) {
  // Persist before Chromium can write. This survives both worker and Docker
  // restarts, so a later backup cannot mistake an unclean profile for a clean one.
  const file = await fsp.open(activeMarker(id), 'w', 0o600);
  try { await file.writeFile('active\n'); await file.sync(); } finally { await file.close(); }
  const directory = await fsp.open(profiles, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

const docker = createTgDockerClient(dockerSocket);
const cpuGroup = createTgCpuGroup({ docker });
let cpuSyncRetryAt = 0;
const ownedContainers = () => docker('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`nurossh.tg.owner=${namespace}`] }))}`);
async function inspect(id, timeout) {
  try {
    const container = await docker('GET', `/containers/${name(id)}/json`, undefined, timeout);
    if (container.Config?.Labels?.['nurossh.tg.owner'] !== namespace) fail('容器归属校验失败');
    return container;
  } catch (error) { if (error.dockerStatus === 404) return null; throw error; }
}
async function ownedNetwork(id) {
  const networkName = `${name(id)}-net`;
  try {
    const network = await docker('GET', `/networks/${networkName}`);
    if (network.Labels?.['nurossh.tg.owner'] !== namespace) fail('网络归属校验失败');
  } catch (error) { if (error.dockerStatus !== 404) throw error; await docker('POST', '/networks/create', { Name: networkName, Driver: 'bridge', Labels: label() }); }
  try { await docker('POST', `/networks/${networkName}/connect`, { Container: runtimeName }); }
  catch (error) { if (error.dockerStatus !== 403 && error.dockerStatus !== 409) throw error; }
  return networkName;
}
async function assertImage() { try { return (await docker('GET', `/images/${encodeURIComponent(image)}/json`)).Id; } catch { fail('浏览器镜像尚未构建，请先完成 TG 托管组件安装', 503); } }

async function restoreProfile(id) {
  const directory = path.join(profiles, id), archive = path.join(snapshots, `${id}.tar.gz.enc`);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chown(directory, 10001, 10001);
  const entries = await fsp.readdir(directory);
  if (entries.length) {
    if (entries.some(tgProfileDataName)) { await markProfileKnown(id); return; }
    // Never let monitor/version files hide the loss of an existing profile.
    // Retain the directory and backup for an explicit restore; do not silently
    // open a new login or roll back an account's current files.
    if (fs.existsSync(archive)) fail('登录目录仅剩状态标记，已保留原目录和加密快照；请恢复备份，不会创建空白会话', 503);
    requireSavedProfile(id);
    return; // A never-started account may retry initialization without deletion.
  }
  if (!fs.existsSync(archive)) { requireSavedProfile(id); return; }
  // Authenticate the entire archive before extraction. The temporary archive is
  // private, removed on failure, and never part of a deployment backup.
  const temporary = path.join(profiles, `.restore-${id}.tar.gz`);
  const stagingName = `.restore-profile-${id}`, staging = path.join(profiles, stagingName);
  try {
    // These are uncommitted, reproducible files. The authenticated snapshot and
    // live profile are never removed here; reclaim old scratch space first.
    await fsp.rm(temporary, { force: true }); await fsp.rm(staging, { recursive: true, force: true });
    const resources = await readResources(true), archiveSize = (await fsp.stat(archive)).size;
    if (resources.error || archiveSize > resources.diskHeadroomBytes) fail('恢复空间不足，原加密会话未修改，请清理磁盘后重试', 503);
    let size = 0;
    const bounded = new Transform({ transform(chunk, _enc, callback) { size += chunk.length; callback(size > TG_PROFILE_MAX_BYTES + 256 * 1024 ** 2 ? Error('账号备份超过安全上限，原加密快照已保留') : null, chunk); } });
    await pipeline(fs.createReadStream(archive), decoder(key), bounded, fs.createWriteStream(temporary, { mode: 0o600 }));
    await fsp.chown(temporary, 10001, 10001);
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { mode: 0o700 }); await fsp.chown(staging, 10001, 10001);
    await helper(stagingName, ['node', '/opt/profile-archive.cjs', 'extract', '/archive/profile.tar.gz'], { archive: temporary });
    await fsp.rmdir(directory); // Must still be empty; never replace a live profile.
    await fsp.rename(staging, directory);
    await markProfileKnown(id);
  } finally { await fsp.rm(temporary, { force: true }); await fsp.rm(staging, { recursive: true, force: true }); }
}
async function profileUsage(id) {
  const usage = await scanProfile(path.join(profiles, id), { excludeCaches: true });
  if (usage.filesExceeded || usage.bytes > TG_PROFILE_MAX_BYTES) fail('账号配置超过备份安全上限（20 GB / 10 万文件），原快照和登录资料已保留');
  return usage;
}
const storage = createProfileStorage({ rows, profiles, snapshots,
  getLimit: () => settings.storageGb * 1024 ** 3,
  exclusive, blocked: () => !configured || backupLease || closed || migrationHold,
  stop, canClean: row => !row.uncleanStop && !fs.existsSync(activeMarker(row.id)),
});
async function helper(id, command, { archive } = {}) {
  if (command[0] === 'node' && command[1] === '/opt/profile-archive.cjs') command = ['python3', '-c', archiveSource, ...command.slice(2)];
  const binds = [`${hostProfiles}/${id}:/profile`];
  if (archive) binds.push(`${hostProfiles}/${path.basename(archive)}:/archive/profile.tar.gz:ro`);
  const created = await docker('POST', '/containers/create', { Image: image, User: '10001:10001', Env: [`TG_PROFILE_LIMIT_BYTES=${TG_PROFILE_MAX_BYTES}`], Entrypoint: command, Cmd: [], Healthcheck: { Test: ['NONE'] }, Labels: { ...label(), 'nurossh.tg.helper': '1' }, HostConfig: { Binds: binds, NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 384 * 1024 ** 2, MemorySwap: 384 * 1024 ** 2, NanoCpus: 5e8, CpuShares: 64, LogConfig: { Type: 'none' }, PidsLimit: 64 } });
  try {
    await docker('POST', `/containers/${created.Id}/start`);
    const result = await docker('POST', `/containers/${created.Id}/wait`, undefined, 900000);
    if (result.StatusCode !== 0) fail('账号配置归档或恢复失败，原快照未替换', 503);
  } finally { await docker('DELETE', `/containers/${created.Id}?force=true`).catch(() => {}); }
}

async function stop(id) {
  const row = rows.get(id); if (!row) return;
  memorySamples.delete(id);
  row.state = 'stopping';
  const container = await inspect(id);
  if (container?.State.Running) await docker('POST', `/containers/${container.Id}/stop?t=25`, undefined, 35000);
  const stopped = container?.State.Running ? await inspect(id) : container;
  if (stopped?.State.Running) fail('无法确认浏览器已经停止，已保留登录资料和活动标记', 503);
  if (stopped && Date.parse(stopped.State.StartedAt) > 0) {
    row.uncleanStop = Boolean(stopped.State.OOMKilled || stopped.State.ExitCode !== 0);
    if (!row.uncleanStop) {
      await fsp.rm(activeMarker(id), { force: true });
      const directory = await fsp.open(profiles, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    }
  } else row.uncleanStop = Boolean(row.uncleanStop || fs.existsSync(activeMarker(id)));
  if (container) await docker('DELETE', `/containers/${container.Id}`);
  await removeNetwork(id);
  row.containerPresent = false;
  row.state = 'stopped'; row.ip = ''; row.viewers = 0;
  retryResourceWaiters();
}
async function removeNetwork(id) {
  const networkName = `${name(id)}-net`;
  let network;
  try { network = await docker('GET', `/networks/${networkName}`); }
  catch (error) { if (error.dockerStatus === 404) return; throw error; }
  if (network.Labels?.['nurossh.tg.owner'] !== namespace) fail('网络归属校验失败');
  if (Object.values(network.Containers || {}).some(container => container.Name === runtimeName)) {
    await docker('POST', `/networks/${networkName}/disconnect`, { Container: runtimeName, Force: true });
  }
  await docker('DELETE', `/networks/${networkName}`);
}
async function verifySnapshot(file, expected) {
  const before = await fsp.lstat(file, { bigint: true });
  if (!before.isFile() || before.size > TG_PROFILE_MAX_BYTES + 256 * 1024 ** 2) fail('账号快照格式或大小异常，原文件和登录目录已保留', 503);
  const signature = stat => `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (!expected && verifiedSnapshots.get(file) === signature(before)) return;
  verifiedSnapshots.delete(file);
  const hash = crypto.createHash('sha256'); let bytes = 0;
  const sink = new Writable({ write(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > TG_PROFILE_MAX_BYTES + 256 * 1024 ** 2) return done(Error('账号快照超过安全上限'));
    hash.update(chunk); done();
  } });
  try {
    await pipeline(fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK }), decoder(key), sink, { signal: AbortSignal.timeout(900000) });
    const digest = hash.digest('hex');
    if (!bytes || expected && (expected.bytes !== bytes || expected.digest !== digest)) throw Error('snapshot mismatch');
    const after = await fsp.lstat(file, { bigint: true });
    if (signature(before) !== signature(after)) throw Error('snapshot changed');
    verifiedSnapshots.set(file, signature(after));
  } catch { fail('账号快照完整性校验失败，原快照和当前登录目录已保留，请重新保存快照或恢复备份', 503); }
}
async function reuseSnapshot(row, file) {
  try { await verifySnapshot(file); row.snapshotError = ''; }
  catch (error) { row.snapshotError = error.message; throw error; }
}
async function checkpoint(id) {
  const row = rows.get(id); if (!row) fail('账号不存在', 404);
  const resume = row.desired;
  const file = path.join(snapshots, `${id}.tar.gz.enc`);
  // A verified snapshot of a browser that has not restarted is immutable.
  // UI intents may already say "saving"/"stopping"; state alone cannot test this.
  if (!row.dirty && fs.existsSync(file)) { await reuseSnapshot(row, file); row.state = resume ? (row.storageBlocked ? 'error' : 'queued') : 'stopped'; return; }
  // Clean interrupted temporary archives without ever deleting browser data.
  const directory = path.join(profiles, id);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of await fsp.readdir(directory)) if (/^\.tg-snapshot-[a-f0-9-]+\.tar\.gz$/.test(file)) await fsp.rm(path.join(directory, file), { force: true });
  // A restored, unopened account has a snapshot and no live profile yet.
  // Never replace its only session copy with an empty archive.
  if (!(await fsp.readdir(directory)).length && (fs.existsSync(file) || row.containerPresent === false)) {
    if (!fs.existsSync(file)) requireSavedProfile(id);
    else await reuseSnapshot(row, file);
    if (row.containerPresent !== false) await stop(id);
    row.dirty = false; row.state = resume ? (row.storageBlocked ? 'error' : 'queued') : 'stopped'; return;
  }
  if (row.containerPresent !== false) await stop(id);
  else row.state = 'stopped';
  await fsp.mkdir(path.join(profiles, id), { recursive: true, mode: 0o700 });
  await fsp.chown(path.join(profiles, id), 10001, 10001);
  const stage = `${file}.partial`;
  const archive = path.join(profiles, id, `.tg-snapshot-${crypto.randomUUID()}.tar.gz`);
  try {
    if ((row.uncleanStop || fs.existsSync(activeMarker(id))) && fs.existsSync(file)) fail('浏览器未正常退出，已保留上次完整快照和当前登录目录；请重新打开后再保存快照', 503);
    // Cleaning is optional for a rescue backup: cache failures must not stop
    // us saving session databases. The archive independently excludes caches.
    let cachesCleaned = false;
    if (!row.uncleanStop && !fs.existsSync(activeMarker(id))) {
      try { await storage.cleanStopped(row); cachesCleaned = true; }
      catch { row.storageError = '备份前缓存未完全清理；备份仍排除缓存，登录资料保留'; }
    }
    const usage = await profileUsage(id), resources = await readResources(true);
    if (!usage.bytes) fail('未发现可备份的账号数据，已保留原快照和当前目录；不会用空资料覆盖登录会话', 503);
    if (cachesCleaned) {
      row.storageBytes = usage.bytes; row.storageCheckedAt = Date.now(); row.storageSample = (row.storageSample || 0) + 1;
      row.storageScanAfter = Date.now() + 30 * 60000;
    }
    if (resources.error || resources.diskHeadroomBytes < usage.bytes * 2) fail('磁盘空间不足，未覆盖原快照；完整登录资料仍保留在服务器', 503);
    await helper(id, ['node', '/opt/profile-archive.cjs', 'pack', `/profile/${path.basename(archive)}`]);
    await fsp.rm(stage, { force: true });
    const hash = crypto.createHash('sha256'); let bytes = 0;
    const hashing = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; if (bytes > TG_PROFILE_MAX_BYTES + 256 * 1024 ** 2) return done(Error('账号归档超过安全上限，原快照已保留')); hash.update(chunk); done(null, chunk); } });
    const encrypted = encoder(key), writer = fs.createWriteStream(stage, { flags: 'wx', mode: 0o600 });
    await pipeline(fs.createReadStream(archive), hashing, encrypted, writer);
    const fd = await fsp.open(stage, 'r'); try { await fd.sync(); } finally { await fd.close(); }
    // Read the entire encrypted result back, authenticate GCM and compare the
    // compressed bytes. The last good snapshot is untouched until this passes.
    await verifySnapshot(stage, { bytes, digest: hash.digest('hex') });
    await fsp.chown(stage, 10001, 10001); await fsp.rename(stage, file);
    verifiedSnapshots.delete(stage); verifiedSnapshots.delete(file);
    const directory = await fsp.open(snapshots, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    row.dirty = false; row.snapshotAt = new Date().toISOString(); row.snapshotError = '';
    row.snapshotBytes = (await fsp.stat(file)).size;
    await markProfileKnown(id);
  } catch (error) { row.snapshotError = error.message; throw error;
  } finally { verifiedSnapshots.delete(stage); await fsp.rm(archive, { force: true }); await fsp.rm(stage, { force: true }); if (resume) row.state = row.storageBlocked ? 'error' : 'queued'; }
}
async function start(id, cpu = settings.cpu, memoryMb = settings.memoryMb) {
  const row = rows.get(id); if (!row || !row.desired) return;
  row.state = 'starting'; row.error = ''; row.dirty = true; row.healthySince = null;
  try {
    const browserImage = await assertImage(); await restoreProfile(id);
    const previous = await inspect(id);
    await storage.prepare(row, { cleanAllowed: !previous?.State.Running && !row.uncleanStop && !fs.existsSync(activeMarker(id)) });
    const directory = path.join(profiles, id);
    await fsp.chown(directory, 10001, 10001); await fsp.chmod(directory, 0o700);
    const network = await ownedNetwork(id);
    let container = await inspect(id);
    if (!container?.State.Running) for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) await fsp.rm(path.join(directory, file), { force: true });
    if (container && !container.State.Running) { await docker('DELETE', `/containers/${container.Id}`); container = null; }
    if (!container) {
      row.monitorToken = crypto.randomBytes(16).toString('hex'); row.loginState = 'unknown'; row.loginReadAt = 0;
      // Restoration may take minutes. Reconfirm the parent immediately before
      // launch rather than trust an old cached quota after Docker disruption.
      const group = await cpuGroup.ensure(await readResources(), settings, true);
      if (!group.ready) fail(group.error, 503);
      const result = await docker('POST', `/containers/create?name=${name(id)}`, {
        Image: browserImage, User: '10001:10001', Env: [`TG_MONITOR_TOKEN=${row.monitorToken}`], Labels: { ...label(), 'nurossh.tg.account': id },
        HostConfig: { CgroupParent: cpuGroup.parent(), Binds: [`${hostProfiles}/${id}:/profile`], ReadonlyRootfs: true, NetworkMode: network, CapDrop: ['ALL'],
          // Chromium's user-namespace sandbox remains enabled. It needs the
          // namespace syscalls Docker's default seccomp policy denies.
          SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'],
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777', '/home/browser': 'rw,nosuid,nodev,size=16m,uid=10001,gid=10001' },
          Memory: memoryMb * 1024 ** 2, MemorySwap: memoryMb * 1024 ** 2, NanoCpus: Math.floor(cpu * 1e9), CpuShares: 128, PidsLimit: 256, ShmSize: 128 * 1024 ** 2,
          RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' } }
      });
      row.containerPresent = true;
      container = await inspect(id);
      const limitError = tgBrowserLimitError(container?.HostConfig, memoryMb, cpu);
      if (limitError) fail(limitError, 503);
      if (!cpuGroup.parent() || container.HostConfig.CgroupParent !== cpuGroup.parent()) fail('共享 CPU 分组校验失败，未启动账号；登录资料已保留', 503);
      await markProfileActive(id);
      await docker('POST', `/containers/${result.Id}/start`); container = await inspect(id);
      const applied = await cpuGroup.ensure(await readResources(), settings, true);
      if (!applied.ready) fail(applied.error, 503);
    }
    row.ip = container.NetworkSettings.Networks[network]?.IPAddress;
    for (let i = 0; i < 60; i++) {
      const current = await inspect(id);
      if (!current?.State.Running) throw Error('浏览器未能启动；请检查服务器是否允许 Chromium 用户命名空间 sandbox，以及内存预算');
      if (Date.now() - new Date(current.State.StartedAt).getTime() >= 3000 && await probeVnc(row.ip)) { await markProfileKnown(id); row.memoryMb = container.HostConfig.Memory / 1024 ** 2; row.cpu = container.HostConfig.NanoCpus / 1e9; row.cpuGrouped = container.HostConfig.CgroupParent === cpuGroup.parent(); row.state = 'running'; row.startedAt = new Date().toISOString(); row.retryAt = 0; row.resourceAttempts = 0; row.startAttempts = 0; return; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('浏览器启动超时，请检查服务器资源和 sandbox 支持');
  } catch (error) {
    const versionError = row.monitorToken ? await readLoginFile(path.join(profiles, id, '.nurossh-browser-error.json')) : null;
    if (row.monitorToken && versionError?.token === row.monitorToken) error = Object.assign(Error(versionError.code === 'browser-downgrade' ? '浏览器版本低于该账号已用版本，已阻止降级并保留登录资料；请升级浏览器组件' : '无法安全确认浏览器版本，已保留登录资料；请检查浏览器组件'), { browserBlocked: true });
    let stopped = true;
    try { await stop(id); } catch { stopped = false; }
    row.error = error.message;
    if (!stopped) {
      // Do not release a potentially live browser's memory/CPU reservation
      // after any startup failure if Docker cannot confirm it has stopped.
      row.storageBlocked = Boolean(error.storageBlocked); row.state = 'running'; row.storageScanAfter = Date.now() + 60000;
      row.memoryMb ||= memoryMb; row.cpu ||= cpu;
      row.error = `${error.storageBlocked ? '存储超限' : '启动未完成'}，暂时无法确认浏览器已停止；已保留资源名额和登录资料，稍后重试`;
      return;
    }
    if (error.storageBlocked) { row.storageBlocked = true; row.state = 'error'; row.retryAt = 0; return; }
    if (error.browserBlocked) { row.state = 'error'; row.retryAt = 0; return; }
    row.startAttempts = (row.startAttempts || 0) + 1;
    const delay = tgRetryDelay(row.startAttempts);
    row.state = row.desired && delay !== null ? 'queued' : 'error'; row.retryAt = delay === null ? 0 : Date.now() + delay;
    if (delay === null) row.error += '；已暂停自动重试，请调整后手动打开';
  }
}
function probeVnc(host) {
  return new Promise(resolve => { const connection = net.connect({ host, port: 5900 }); connection.setTimeout(1000); const finish = result => { connection.destroy(); resolve(result); }; connection.once('data', data => finish(data.toString().startsWith('RFB '))); connection.once('error', () => finish(false)); connection.once('timeout', () => finish(false)); });
}
async function readResources(force = false) {
  if (resourceReading) return resourceReading;
  if (!force && resourceCache && Date.now() - resourceCacheAt < 5000) return { ...resourceCache, reservedMb: active().reduce((sum, row) => sum + (row.memoryMb || settings.memoryMb), 0), reservedCpus: active().reduce((sum, row) => sum + (row.cpu || settings.cpu), 0) };
  resourceReading = (async () => {
    try {
      if (!dockerCapacity || Date.now() - capacityAt >= 60000) { dockerCapacity = await docker('GET', '/info'); capacityAt = Date.now(); }
      const info = dockerCapacity;
      const totalMb = Number(info.MemTotal) / 1024 ** 2;
      const availableMatch = (await fsp.readFile('/proc/meminfo', 'utf8')).match(/^MemAvailable:\s+(\d+)/m);
      const availableMb = availableMatch ? Number(availableMatch[1]) / 1024 : NaN;
      const disks = await Promise.all([fsp.statfs(profiles), fsp.statfs(snapshots)]);
      const spaces = disks.map(stat => ({ total: Number(stat.blocks) * Number(stat.bsize), available: Number(stat.bavail) * Number(stat.bsize) }));
      const diskTotal = Math.min(...spaces.map(disk => disk.total));
      const diskAvailable = Math.min(...spaces.map(disk => disk.available));
      const diskHeadroomBytes = Math.min(...spaces.map(disk => disk.available - tgDiskReserve(disk.total)));
      const reservedMb = active().reduce((sum, row) => sum + (row.memoryMb || settings.memoryMb), 0);
      const reserveBytes = tgDiskReserve(diskTotal);
      const resources = {
        totalMb, availableMb, reservedMb, totalCpus: Number(info.NCPU), reservedCpus: active().reduce((sum, row) => sum + (row.cpu || settings.cpu), 0),
        isolationError: tgHostIsolationBlock(info), cgroupDriver: info.CgroupDriver, cgroupVersion: String(info.CgroupVersion || '1'),
        diskTotalBytes: diskTotal, diskAvailableBytes: diskAvailable,
        diskReserveBytes: reserveBytes, diskHeadroomBytes, diskLow: diskHeadroomBytes < 0,
      };
      if (!Number.isFinite(totalMb) || totalMb <= 0 || !Number.isFinite(availableMb) || !Number.isFinite(resources.totalCpus) || resources.totalCpus <= 0 || !Number.isFinite(diskTotal) || !Number.isFinite(diskAvailable)) throw Error('无法读取服务器资源');
      resourceCache = resources; resourceCacheAt = Date.now(); return resources;
    } catch (error) {
      const resources = { totalMb: NaN, availableMb: NaN, reservedMb: NaN, diskTotalBytes: 0, diskAvailableBytes: 0, diskReserveBytes: 0, diskLow: true, error: error.message };
      resourceCache = resources; resourceCacheAt = Date.now(); return resources;
    } finally { resourceReading = null; }
  })();
  return resourceReading;
}
async function growthReserve() {
  const running = active(), deadline = Date.now() + 2000;
  let cursor = 0, growthMb = 0;
  // Only sample when admitting a new browser; list polling never starts N
  // Docker stats streams. Bound concurrency, cache briefly, and fail closed.
  await Promise.all(Array.from({ length: Math.min(4, running.length) }, async () => {
    while (cursor < running.length) {
      const row = running[cursor++], limitMb = row.memoryMb || settings.memoryMb;
      let sample = memorySamples.get(row.id);
      if (!sample || sample.limitMb !== limitMb || Date.now() - sample.at >= 5000) {
        let reserved = limitMb;
        if (row.state === 'running' && Date.now() < deadline) {
          try { reserved = tgBrowserGrowthMb(await docker('GET', `/containers/${name(row.id)}/stats?stream=false&one-shot=true`, undefined, Math.max(1, Math.min(1000, deadline - Date.now()))), limitMb); } catch {}
        }
        sample = { at: Date.now(), limitMb, growthMb: reserved };
        memorySamples.set(row.id, sample);
      }
      growthMb += sample.growthMb;
    }
  }));
  return growthMb;
}
async function cpuBudget(resources) {
  let cpu;
  try { cpu = Math.min(settings.cpu, tgCpuTotal(resources.totalCpus, settings.cpuTotal)); }
  catch (error) { return { cpu: 0, message: error.message }; }
  if (Date.now() < cpuSyncRetryAt && active().some(row => row.cpuUnconfirmed || row.cpu !== cpu)) return { cpu: 0, message: '单账号 CPU 上限待确认，稍后自动重试；已有账号继续运行' };
  async function syncLimits(decreasesOnly = false) {
    const changes = active().filter(row => decreasesOnly ? row.cpuGrouped && (row.cpuUnconfirmed || row.cpu > cpu) : row.cpuUnconfirmed || row.cpu !== cpu);
    if (!changes.length) return;
    const deadline = Date.now() + 10000;
    const remaining = () => {
      const time = deadline - Date.now();
      if (time <= 0) throw Error('CPU 调整超时');
      return Math.min(2000, time);
    };
    for (const row of changes) {
      if (row.state !== 'running' || row.pending || row.storageMaintaining || row.healthError) throw Error('账号正在处理');
      const container = await inspect(row.id, remaining());
      if (!container?.State.Running || !(container.HostConfig?.NanoCpus > 0)) throw Error('CPU 状态待确认');
      row.cpu = container.HostConfig.NanoCpus / 1e9;
      row.cpuUnconfirmed = true;
      // The account maximum is bounded by the overall maximum, never divided
      // by account count. cgroup v1 requires each child quota <= parent quota.
      if (row.cpu !== cpu) await docker('POST', `/containers/${name(row.id)}/update`, { NanoCpus: Math.floor(cpu * 1e9) }, remaining());
      const updated = await inspect(row.id, remaining());
      if (!updated?.State.Running || updated.HostConfig?.NanoCpus !== Math.floor(cpu * 1e9)) throw Error('CPU 更新待确认');
      row.cpu = cpu; row.cpuUnconfirmed = false;
    }
    cpuSyncRetryAt = 0;
  }
  try {
    // v1 rejects reducing a parent's quota below an existing child's quota.
    // Lower only those child caps first; an increase always changes parent first.
    if (resources.cgroupVersion === '1') await syncLimits(true);
    const group = await cpuGroup.ensure(resources, settings);
    if (!group.ready) return { cpu: 0, message: group.error };
    await syncLimits();
    return { cpu, message: '' };
  } catch {
    cpuSyncRetryAt = Date.now() + 30000;
    return { cpu: 0, message: '单账号 CPU 上限暂未确认，稍后自动重试；已有账号和登录资料保留' };
  }
}

async function startBudget() {
  const growthMb = await growthReserve();
  const resources = { ...await readResources(true), growthMb };
  const memory = tgMemoryBudget(resources, settings.memoryMb);
  if (memory.reason) return { resources, cpu: 0, memoryMb: memory.memoryMb, message: memory.reason };
  const budget = await cpuBudget(resources);
  return { resources, ...budget, memoryMb: memory.memoryMb };
}
let processing = false;
async function tick() {
  if (processing || mutating || backupLease || !configured || closed || migrationHold) return;
  processing = true;
  try { await exclusive(async () => {
    if (backupLease || closed) return;
    // One start per tick. Existing sessions are never evicted for a new account.
    const running = [...rows.values()].filter(row => row.state === 'running');
    const diskBudget = await readResources();
    if (tgDiskNeedsParking(diskBudget)) {
      // A long-running browser can keep growing its database. Stop before the
      // reserve is exhausted, keeping both its live profile and old snapshot.
      for (const row of running) {
        try { await stop(row.id); }
        catch { row.state = 'running'; row.error = '磁盘空间不足，浏览器暂停未完成；请检查 Docker 和磁盘'; continue; }
        row.state = row.desired ? 'queued' : 'stopped'; row.retryAt = Date.now() + 60000;
        row.error = '磁盘空间不足，已暂停浏览器保护登录资料；清理空间后自动恢复';
      }
      return;
    }
    if (active().length || [...rows.values()].some(row => row.state === 'queued' && row.desired)) await cpuBudget(diskBudget);
    const containers = running.length ? await ownedContainers() : [];
    const liveContainers = new Map(containers.filter(container => container.State === 'running' && container.Labels?.['nurossh.tg.owner'] === namespace).map(container => [container.Labels?.['nurossh.tg.account'], container]));
    const liveIds = new Set(liveContainers.keys());
    for (const row of running) {
      const live = liveContainers.get(row.id);
      if (live && tgContainerHealth(live) !== 'unhealthy') {
        row.healthError = '';
        if (tgContainerHealth(live) === 'healthy') row.healthySince ??= Date.now();
        row.crashAttempts = tgCrashAttempts(row);
        continue;
      }
      if (!liveIds.has(row.id)) {
        try {
          const container = await inspect(row.id);
          row.healthError = '';
          if (container?.State.Running) continue;
          const message = container?.State.OOMKilled ? '浏览器超出内存限制，配置已保留；稍后会退避重试' : '浏览器意外停止，配置已保留，稍后会退避重试';
          await stop(row.id).catch(() => {});
          row.error = message; row.ip = ''; row.crashAttempts = tgCrashAttempts(row) + 1; row.healthySince = null;
          const delay = tgRetryDelay(row.crashAttempts, Boolean(container?.State.OOMKilled));
          row.state = row.desired && delay !== null ? 'queued' : 'error'; row.retryAt = delay === null ? 0 : Date.now() + delay;
          if (delay === null) row.error = '浏览器多次意外停止，登录资料已保留；请调整资源后手动打开';
        } catch {
          // Keep this account's reservation until its state can be verified,
          // but never let one failed inspection skip the other accounts.
          row.healthError = '暂时无法确认浏览器状态，已保留资源名额和登录资料，稍后重试';
        }
      } else {
        try {
          const container = await inspect(row.id);
          if (container?.State.Running && tgContainerHealth(container) === 'unhealthy') {
            await stop(row.id);
            row.error = '浏览器健康检查连续失败，登录资料已保留，稍后自动恢复';
            row.crashAttempts = tgCrashAttempts(row) + 1; row.healthySince = null;
            const delay = tgRetryDelay(row.crashAttempts);
            row.state = row.desired && delay !== null ? 'queued' : 'error'; row.retryAt = delay === null ? 0 : Date.now() + delay;
            if (delay === null) row.error = '浏览器健康检查多次失败，登录资料已保留；请稍后手动打开';
          }
        } catch {
          if (row.state === 'stopping') row.state = 'running';
          row.healthError = '暂时无法确认浏览器健康状态，已保留资源名额和登录资料，稍后重试';
        }
      }
    }
    if (active().length < settings.maxRunning) {
      const next = [...rows.values()].find(row => row.state === 'queued' && row.desired && !row.storageBlocked && !row.storageMaintaining && (!row.retryAt || row.retryAt <= Date.now()));
      if (next && !next.pending) {
        const budget = await startBudget();
        if (budget.message) { next.error = budget.message; next.resourceAttempts = (next.resourceAttempts || 0) + 1; next.retryAt = Date.now() + Math.min(120000, 5000 * 2 ** Math.min(next.resourceAttempts - 1, 4)); }
        else await start(next.id, budget.cpu, budget.memoryMb);
      }
    }
  }); } finally { processing = false; }
}
let operation = Promise.resolve();
function exclusive(fn) { const result = operation.then(async () => { mutating = true; try { return await fn(); } finally { mutating = false; } }); operation = result.catch(() => {}); return result; }
async function configure(data) {
  configured = false;
  if (!/^[a-f0-9]{64}$/.test(data.key || '')) fail('配置密钥无效');
  if (key && !key.equals(Buffer.from(data.key, 'hex'))) fail('托管组件密钥发生变化，请先重启组件', 409);
  if (!Array.isArray(data.accounts) || data.accounts.length > 10000 || data.accounts.some(item => !TG_ACCOUNT_ID.test(item.id) || typeof item.desired !== 'boolean' || item.profileExpected !== undefined && typeof item.profileExpected !== 'boolean')) fail('账号配置无效');
  settings = tgHostingSettings(data.settings);
  const wasHeld = migrationHold;
  migrationHold = Boolean(data.migrationHold);
  key ||= Buffer.from(data.key, 'hex'); namespace ||= crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  const self = await docker('GET', `/containers/${runtimeName}/json`);
  hostProfiles = self.Mounts.find(mount => mount.Destination === profiles)?.Source;
  if (!hostProfiles || !hostProfiles.startsWith('/')) fail('浏览器持久目录未挂载', 503);
  cpuGroup.configure({ namespace, hostProfiles, image: self.Config.Image, mounted: self.Mounts.some(m => m.Source === '/sys/fs/cgroup' && m.Destination === '/host-cgroup' && m.RW === true) });
  // Non-secret ownership metadata lets full uninstall find empty orphan
  // networks even after Docker/the runner lost all container endpoints.
  await fsp.writeFile(path.join(profiles, '.tg-owner'), namespace + '\n', { mode: 0o600 });
  // A runner crash must not leave a previous archive/extraction helper writing
  // while a new browser opens the same account.
  const existing = await ownedContainers();
  const existingIds = new Set(existing.filter(container => TG_ACCOUNT_ID.test(container.Labels?.['nurossh.tg.account'] || '')).map(container => container.Labels['nurossh.tg.account']));
  for (const orphan of existing.filter(container => container.Labels?.['nurossh.tg.helper'] === '1')) {
    if (orphan.Labels?.['nurossh.tg.owner'] !== namespace || orphan.Labels?.['nurossh.tg.helper'] !== '1') fail('归档组件归属校验失败');
    await docker('DELETE', `/containers/${orphan.Id}?force=true`);
  }
  for (const item of data.accounts) {
    if (rows.has(item.id)) {
      if (item.profileExpected) rows.get(item.id).profileExpected = true;
      if (migrationHold) { const row = rows.get(item.id); row.desired = false; if (existingIds.has(item.id)) await stop(item.id); else { row.state = 'stopped'; row.containerPresent = false; } }
      else if (wasHeld) { const row = rows.get(item.id); row.desired = item.desired; if (row.desired && row.state === 'stopped') row.state = 'queued'; }
      continue;
    }
    const container = existingIds.has(item.id) ? await inspect(item.id) : null, running = Boolean(container?.State.Running);
    const network = `${name(item.id)}-net`;
    rows.set(item.id, { monitorToken: container?.Config?.Env?.find(value => value.startsWith('TG_MONITOR_TOKEN='))?.slice(17), loginState: 'unknown', dirty: true, profileExpected: Boolean(item.profileExpected || running), containerPresent: Boolean(container), memoryMb: container?.HostConfig?.Memory / 1024 ** 2, cpu: container?.HostConfig?.NanoCpus / 1e9, cpuGrouped: cpuGroup.includes(container?.HostConfig?.CgroupParent), id: item.id, desired: item.desired, state: running ? 'running' : item.desired ? 'queued' : 'stopped', ip: running ? container.NetworkSettings.Networks[network]?.IPAddress : '', error: '', viewers: 0, retryAt: 0, startAttempts: 0, resourceAttempts: 0 });
    if (migrationHold) { const row = rows.get(item.id); row.desired = false; if (container) await stop(item.id); else row.state = 'stopped'; }
    else if (running) {
      if (!item.desired) await stop(item.id);
      else await ownedNetwork(item.id);
    }
  }
  configured = true;
  return { ok: true };
}
async function readBody(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 2 * 1024 * 1024) fail('请求过大'); }
  try { return text ? JSON.parse(text) : {}; } catch { fail('请求格式无效'); }
}
async function handle(req) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/configure') return exclusive(() => { if (backupLease) fail('正在备份，请稍后重试', 409); return configureBody(req); });
  if (!configured) fail('托管组件尚未完成初始化，请查看面板连接错误或重新启用组件', 503);
  if (req.method === 'GET' && url.pathname === '/status') {
    // Docker may be stalled. Reading status must not queue behind its I/O or a
    // large archive; only admission decisions require a fresh resource sample.
    void readResources().catch(() => {});
    return { accounts: [...rows.values()].map(tgRuntimeAccount), backupBusy: Boolean(backupLease), resources: { ...resourceCache, cpuBudget: { ...cpuGroup.status(), legacyAccounts: active().filter(row => !row.cpuGrouped).length, limitsPending: active().filter(row => row.cpuUnconfirmed || row.cpu !== Math.min(settings.cpu, cpuGroup.status().total || settings.cpu)).length } } };
  }
  if (req.method === 'POST' && url.pathname === '/backup/end') {
    const input = await readBody(req); if (input.token !== backupLease?.token) fail('备份锁无效', 409);
    backupLease = null; return { ok: true };
  }
  if (req.method === 'POST' && url.pathname === '/backup/renew') {
    const input = await readBody(req); if (!backupLease || input.token !== backupLease.token) fail('备份锁无效', 409);
    backupLease.expires = Date.now() + 15 * 60000; return { ok: true };
  }
  if (backupLease) fail('正在保存完整备份，请稍后操作', 409);
  if (req.method === 'POST' && url.pathname === '/shutdown') return exclusive(async () => {
    closed = true;
    try {
      for (const row of rows.values()) {
        await checkpoint(row.id);
        if (row.containerPresent !== false) await stop(row.id);
      }
      await cpuGroup.release();
    } catch (error) { closed = false; throw error; }
    return { ok: true };
  });
  if (closed) fail('托管组件正在停止，请重启组件后再操作', 503);
  if (req.method === 'POST' && url.pathname === '/backup/start') return exclusive(async () => {
    if (backupLease) fail('另一个备份正在处理', 409);
    backupLease = { token: crypto.randomBytes(24).toString('hex'), expires: Infinity };
    try {
      for (const row of rows.values()) { if (req.socket.destroyed) fail('备份请求已中断，未清除会话资料', 503); await checkpoint(row.id); }
      if (req.socket.destroyed) fail('备份请求已中断，未清除会话资料', 503);
      backupLease.expires = Date.now() + 15 * 60000; return { token: backupLease.token };
    }
    catch (error) { backupLease = null; throw error; }
  });
  if (req.method === 'POST' && url.pathname === '/resume') return exclusive(async () => {
    const input = await readBody(req);
    if (!Array.isArray(input.ids) || input.ids.length > 10000 || input.ids.some(id => !TG_ACCOUNT_ID.test(id)) || new Set(input.ids).size !== input.ids.length) fail('迁移账号列表无效');
    if (backupLease) fail('正在备份，请稍后重试', 409);
    migrationHold = false; let accepted = 0;
    for (const id of input.ids) {
      const row = rows.get(id); if (!row) continue;
      row.desired = true; row.error = ''; row.retryAt = 0; row.startAttempts = 0; row.resourceAttempts = 0;
      if (!['running', 'starting', 'stopping', 'saving'].includes(row.state)) row.state = 'queued';
      accepted++;
    }
    return { ok: true, accepted };
  });
  if (req.method === 'PUT' && url.pathname === '/settings') {
    const input = tgHostingSettings(await readBody(req));
    return exclusive(() => {
      if (backupLease) fail('正在备份，请稍后重试', 409);
      if (input.maxRunning < active().length) fail('当前运行账号多于新上限，请先休眠部分账号', 409);
      const storageChanged = settings.storageGb !== input.storageGb;
      settings = input; cpuSyncRetryAt = 0;
      if (storageChanged) for (const row of rows.values()) row.storageScanAfter = 0;
      retryResourceWaiters();
      return { ok: true };
    });
  }
  const match = url.pathname.match(/^\/accounts\/([^/]+)(?:\/(wake|sleep|snapshot))?$/);
  if (!match) fail('操作不存在', 404);
  const id = idCheck(match[1]), action = match[2];
  if (req.method === 'DELETE') return exclusive(async () => {
    if (backupLease) fail('正在保存备份，请稍后操作', 409);
    const row = rows.get(id); if (row) row.desired = false;
    await stop(id);
    const container = await inspect(id); if (container) await docker('DELETE', `/containers/${container.Id}?force=true`);
    await removeNetwork(id);
    await fsp.rm(path.join(profiles, id), { recursive: true, force: true });
    await fsp.rm(path.join(snapshots, `${id}.tar.gz.enc`), { force: true });
    verifiedSnapshots.delete(path.join(snapshots, `${id}.tar.gz.enc`));
    await fsp.rm(profileMarker(id), { force: true });
    await fsp.rm(activeMarker(id), { force: true });
    await storage.forget(id);
    rows.delete(id); return { ok: true };
  });
  if (req.method !== 'POST' || !action) fail('操作不存在', 404);
  if (!rows.has(id)) rows.set(id, { id, state: 'stopped', desired: false, containerPresent: false, viewers: 0, error: '' });
  const row = rows.get(id);
  if (row.pending || row.storageMaintaining) fail('该账号正在保存资料或清理缓存，请稍后重试', 409);
  // Acknowledge promptly; heavy profile work stays outside panel HTTP requests.
  if (action === 'wake') {
    if (migrationHold) fail('请先确认旧机器已停止并完成迁移接管', 409);
    await assertImage();
    if (row.pending || row.storageMaintaining) fail('该账号正在保存资料或清理缓存，请稍后重试', 409);
    if (backupLease) fail('正在保存备份，请稍后操作', 409);
    row.desired = true;
    row.retryAt = 0; row.startAttempts = 0; row.crashAttempts = 0; row.resourceAttempts = 0; row.error = ''; row.storageBlocked = false;
    if (!['running', 'starting'].includes(row.state)) row.state = 'queued';
  } else {
    if (action === 'sleep') row.desired = false;
    row.pending = action;
    row.state = action === 'sleep' ? 'stopping' : 'saving';
    void exclusive(async () => {
      try { await checkpoint(id); row.error = ''; }
      catch (error) { row.state = row.desired ? 'queued' : 'error'; row.error = error.message; }
      finally { row.pending = ''; }
    });
  }
  return { ok: true, accepted: true, state: row.state };

}
async function configureBody(req) { return configure(await readBody(req)); }
await fsp.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
await fsp.chown(path.dirname(socket), 10001, 10001);
await fsp.mkdir(profiles, { recursive: true, mode: 0o700 }); await fsp.mkdir(snapshots, { recursive: true, mode: 0o700 });
await fsp.chown(snapshots, 10001, 10001);
await fsp.rm(socket, { force: true });
const server = http.createServer(async (req, res) => { try { const result = await handle(req); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); } catch (error) { res.writeHead(error.statusCode || 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); } });
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', (req, transport, head) => {
  const match = req.url?.match(/^\/view\/([a-f0-9-]+)$/), row = match && rows.get(match[1]);
  if (!row || row.state !== 'running' || !row.ip || attached.has(row.id) || backupLease || migrationHold) { transport.destroy(); return; }
  wss.handleUpgrade(req, transport, head, ws => {
    attached.add(row.id); row.viewers = 1;
    const vnc = net.connect({ host: row.ip, port: 5900, noDelay: true });
    vnc.setTimeout(30000);
    vnc.on('data', chunk => relayTgFrame(vnc, ws, chunk));
    ws.on('message', data => { if (!vnc.write(data)) ws._socket.pause(); });
    vnc.on('drain', () => ws._socket.resume());
    let finished = false;
    const finish = () => { if (finished) return; finished = true; attached.delete(row.id); row.viewers = 0; vnc.destroy(); if (ws.readyState === 1) ws.close(); };
    ws.once('close', finish); ws.once('error', finish); vnc.once('error', finish); vnc.once('close', finish);
    vnc.on('timeout', () => vnc.setTimeout(0));
  });
});
server.listen(socket, async () => { await fsp.chmod(socket, 0o600); await fsp.chown(socket, 10001, 10001); });
let loginReading = false;
async function readLoginStates() {
  if (loginReading || mutating || backupLease || closed || migrationHold || !configured) return;
  let row; const now = Date.now();
  // Pick the oldest due account. With 50 accounts and one read every 2s,
  // choosing the first due row would permanently starve accounts after #30.
  for (const item of rows.values()) if (item.state === 'running' && item.monitorToken && !item.pending && now >= (item.loginReadAt || 0) &&
      (!row || (item.loginReadAt || 0) < (row.loginReadAt || 0))) row = item;
  if (!row) return;
  loginReading = true; row.loginReadAt = Date.now() + 60000;
  const token = row.monitorToken;
  try {
    const status = tgLoginStatus(await readLoginFile(path.join(profiles, row.id, '.nurossh-login.json')), token);
    if (rows.get(row.id) === row && row.state === 'running' && row.monitorToken === token) Object.assign(row, status);
  } catch { row.loginState = 'unknown'; }
  finally { loginReading = false; }
}
const loginTimer = setInterval(() => { void readLoginStates(); }, 2000); loginTimer.unref();
const storageTimer = setInterval(() => { if (!mutating) void storage.tick().catch(() => {}); }, 1000); storageTimer.unref();
const timer = setInterval(() => { if (backupLease?.expires < Date.now()) backupLease = null; void tick().catch(() => {}); }, 5000); timer.unref();
process.on('SIGTERM', () => { closed = true; clearInterval(storageTimer); server.close(); for (const client of wss.clients) client.close(); setTimeout(() => process.exit(0), 100).unref(); });
