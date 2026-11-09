import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { encoder, decoder } from './backup-crypto.cjs';
import { TG_ACCOUNT_ID, tgHostingSettings, tgDiskReserve, tgResourceBlock, tgRetryDelay, tgRuntimeAccount, tgDiskNeedsParking, tgHostIsolationBlock, tgBrowserLimitError, tgContainerHealth, tgCrashAttempts } from './shared/tg-hosting.js';
import { createTgDockerClient } from './shared/tg-docker.js';

const socket = process.env.TG_HOSTING_SOCKET || '/control/runner.sock';
const dockerSocket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const image = process.env.TG_BROWSER_IMAGE || 'nurossh-tg-browser:local';
const runtimeName = process.env.TG_RUNNER_CONTAINER || 'nurossh-tg-runner';
const profiles = '/profiles', snapshots = '/snapshots';
const rows = new Map(), attached = new Set();
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
const active = () => [...rows.values()].filter(row => ['starting', 'running', 'stopping', 'saving'].includes(row.state));

async function markProfileActive(id) {
  // Persist before Chromium can write. This survives both worker and Docker
  // restarts, so a later backup cannot mistake an unclean profile for a clean one.
  const file = await fsp.open(activeMarker(id), 'w', 0o600);
  try { await file.writeFile('active\n'); await file.sync(); } finally { await file.close(); }
  const directory = await fsp.open(profiles, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

const docker = createTgDockerClient(dockerSocket);
const ownedContainers = () => docker('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`nurossh.tg.owner=${namespace}`] }))}`);
async function inspect(id) {
  try {
    const container = await docker('GET', `/containers/${name(id)}/json`);
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
async function assertImage() { try { await docker('GET', `/images/${encodeURIComponent(image)}/json`); } catch { fail('浏览器镜像尚未构建，请先完成 TG 托管组件安装', 503); } }

async function restoreProfile(id) {
  const directory = path.join(profiles, id), archive = path.join(snapshots, `${id}.tar.gz.enc`);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chown(directory, 10001, 10001);
  if ((await fsp.readdir(directory)).length || !fs.existsSync(archive)) return;
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
    const bounded = new Transform({ transform(chunk, _enc, callback) { size += chunk.length; callback(size > 2 * 1024 ** 3 ? Error('账号配置超过 2 GB') : null, chunk); } });
    await pipeline(fs.createReadStream(archive), decoder(key), bounded, fs.createWriteStream(temporary, { mode: 0o600 }));
    await fsp.chown(temporary, 10001, 10001);
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { mode: 0o700 }); await fsp.chown(staging, 10001, 10001);
    await helper(stagingName, ['node', '/opt/profile-archive.cjs', 'extract', '/archive/profile.tar.gz'], { archive: temporary });
    await fsp.rmdir(directory); // Must still be empty; never replace a live profile.
    await fsp.rename(staging, directory);
  } finally { await fsp.rm(temporary, { force: true }); await fsp.rm(staging, { recursive: true, force: true }); }
}
async function profileUsage(id, limitBytes = 2 * 1024 ** 3, limitFiles = 100000) {
  const root = path.join(profiles, id); let bytes = 0, files = 0;
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(entry.name)) continue;
      if (++files > limitFiles) fail('账号浏览器配置文件过多，已暂停启动以保护磁盘');
      if (entry.isSymbolicLink()) fail('账号配置包含不允许的符号链接');
      const current = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(current);
      else if (entry.isFile()) {
        const stat = await fsp.stat(current); bytes += stat.size;
        if (bytes > limitBytes || files > limitFiles) fail('账号浏览器配置过大，已暂停启动以保护磁盘');
      } else fail('账号配置包含不支持的文件类型');
    }
  }
  await walk(root); return { bytes, files };
}
async function helper(id, command, { archive } = {}) {
  const binds = [`${hostProfiles}/${id}:/profile`];
  if (archive) binds.push(`${hostProfiles}/${path.basename(archive)}:/archive/profile.tar.gz:ro`);
  const created = await docker('POST', '/containers/create', { Image: image, User: '10001:10001', Entrypoint: command, Cmd: [], Healthcheck: { Test: ['NONE'] }, Labels: { ...label(), 'nurossh.tg.helper': '1' }, HostConfig: { Binds: binds, NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 384 * 1024 ** 2, MemorySwap: 384 * 1024 ** 2, NanoCpus: 5e8, CpuShares: 64, LogConfig: { Type: 'none' }, PidsLimit: 64 } });
  try {
    await docker('POST', `/containers/${created.Id}/start`);
    const result = await docker('POST', `/containers/${created.Id}/wait`, undefined, 180000);
    if (result.StatusCode !== 0) fail('账号配置归档或恢复失败，原快照未替换', 503);
  } finally { await docker('DELETE', `/containers/${created.Id}?force=true`).catch(() => {}); }
}

async function stop(id) {
  const row = rows.get(id); if (!row) return;
  row.state = 'stopping';
  const container = await inspect(id);
  if (container?.State.Running) await docker('POST', `/containers/${container.Id}/stop?t=25`, undefined, 35000);
  const stopped = container?.State.Running ? await inspect(id) : container;
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
async function checkpoint(id) {
  const row = rows.get(id); if (!row) fail('账号不存在', 404);
  const resume = row.desired;
  const file = path.join(snapshots, `${id}.tar.gz.enc`);
  // A verified snapshot of a browser that has not restarted is immutable.
  // UI intents may already say "saving"/"stopping"; state alone cannot test this.
  if (!row.dirty && fs.existsSync(file)) { row.state = resume ? 'queued' : 'stopped'; return; }
  // Clean interrupted temporary archives without ever deleting browser data.
  const directory = path.join(profiles, id);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of await fsp.readdir(directory)) if (/^\.tg-snapshot-[a-f0-9-]+\.tar\.gz$/.test(file)) await fsp.rm(path.join(directory, file), { force: true });
  // A restored, unopened account has a snapshot and no live profile yet.
  // Never replace its only session copy with an empty archive.
  if (!(await fsp.readdir(directory)).length && (fs.existsSync(file) || row.containerPresent === false)) {
    if (row.containerPresent !== false) await stop(id);
    row.dirty = false; row.state = resume ? 'queued' : 'stopped'; return;
  }
  if (row.containerPresent !== false) await stop(id);
  else row.state = 'stopped';
  await fsp.mkdir(path.join(profiles, id), { recursive: true, mode: 0o700 });
  await fsp.chown(path.join(profiles, id), 10001, 10001);
  const stage = `${file}.partial`;
  const archive = path.join(profiles, id, `.tg-snapshot-${crypto.randomUUID()}.tar.gz`);
  try {
    if ((row.uncleanStop || fs.existsSync(activeMarker(id))) && fs.existsSync(file)) fail('浏览器未正常退出，已保留上次完整快照和当前登录目录；请重新打开后再保存快照', 503);
    const usage = await profileUsage(id), resources = await readResources(true);
    if (resources.error || resources.diskHeadroomBytes < usage.bytes * 2) fail('磁盘空间不足，未覆盖原快照；完整登录资料仍保留在服务器', 503);
    await helper(id, ['node', '/opt/profile-archive.cjs', 'pack', `/profile/${path.basename(archive)}`]);
    const encrypted = encoder(key), writer = fs.createWriteStream(stage, { flags: 'w', mode: 0o600 });
    await pipeline(fs.createReadStream(archive), encrypted, writer);
    const fd = await fsp.open(stage, 'r'); try { await fd.sync(); } finally { await fd.close(); }
    await fsp.chown(stage, 10001, 10001); await fsp.rename(stage, file);
    const directory = await fsp.open(snapshots, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    row.dirty = false; row.snapshotAt = new Date().toISOString(); row.snapshotError = '';
  } catch (error) { row.snapshotError = error.message; throw error;
  } finally { await fsp.rm(archive, { force: true }); await fsp.rm(stage, { force: true }); if (resume) row.state = 'queued'; }
}
async function start(id, cpu = settings.cpu) {
  const row = rows.get(id); if (!row || !row.desired) return;
  row.state = 'starting'; row.error = ''; row.dirty = true; row.healthySince = null;
  try {
    await assertImage(); await restoreProfile(id); await profileUsage(id);
    const directory = path.join(profiles, id);
    await fsp.chown(directory, 10001, 10001); await fsp.chmod(directory, 0o700);
    const network = await ownedNetwork(id);
    let container = await inspect(id);
    if (!container?.State.Running) for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) await fsp.rm(path.join(directory, file), { force: true });
    if (container && !container.State.Running) { await docker('DELETE', `/containers/${container.Id}`); container = null; }
    if (!container) {
      const result = await docker('POST', `/containers/create?name=${name(id)}`, {
        Image: image, User: '10001:10001', Labels: { ...label(), 'nurossh.tg.account': id },
        HostConfig: { Binds: [`${hostProfiles}/${id}:/profile`], ReadonlyRootfs: true, NetworkMode: network, CapDrop: ['ALL'],
          // Chromium's user-namespace sandbox remains enabled. It needs the
          // namespace syscalls Docker's default seccomp policy denies.
          SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'],
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777', '/home/browser': 'rw,nosuid,nodev,size=16m,uid=10001,gid=10001' },
          Memory: settings.memoryMb * 1024 ** 2, MemorySwap: settings.memoryMb * 1024 ** 2, NanoCpus: Math.floor(cpu * 1e9), CpuShares: 128, PidsLimit: 256, ShmSize: 128 * 1024 ** 2,
          RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' } }
      });
      row.containerPresent = true;
      container = await inspect(id);
      const limitError = tgBrowserLimitError(container?.HostConfig, settings.memoryMb, cpu);
      if (limitError) fail(limitError, 503);
      await markProfileActive(id);
      await docker('POST', `/containers/${result.Id}/start`); container = await inspect(id);
    }
    row.ip = container.NetworkSettings.Networks[network]?.IPAddress;
    for (let i = 0; i < 60; i++) {
      const current = await inspect(id);
      if (!current?.State.Running) throw Error('浏览器未能启动；请检查服务器是否允许 Chromium 用户命名空间 sandbox，以及内存预算');
      if (Date.now() - new Date(current.State.StartedAt).getTime() >= 3000 && await probeVnc(row.ip)) { row.memoryMb = container.HostConfig.Memory / 1024 ** 2; row.cpu = container.HostConfig.NanoCpus / 1e9; row.state = 'running'; row.startedAt = new Date().toISOString(); row.retryAt = 0; row.resourceAttempts = 0; row.startAttempts = 0; return; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('浏览器启动超时，请检查服务器资源和 sandbox 支持');
  } catch (error) {
    await stop(id).catch(() => {}); row.error = error.message;
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
        isolationError: tgHostIsolationBlock(info),
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
async function startBudget() {
  const resources = await readResources();
  const cpu = Math.min(settings.cpu, resources.totalCpus * .75 - resources.reservedCpus);
  const message = tgResourceBlock(resources, settings.memoryMb) || (!Number.isFinite(cpu) || cpu < .25 ? 'CPU 预算不足，已排队保护面板；请休眠其他账号或降低单账号 CPU 上限' : '');
  return { resources, cpu, message };
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
      const next = [...rows.values()].find(row => row.state === 'queued' && row.desired && (!row.retryAt || row.retryAt <= Date.now()));
      if (next && !next.pending) {
        const budget = await startBudget();
        if (budget.message) { next.error = budget.message; next.resourceAttempts = (next.resourceAttempts || 0) + 1; next.retryAt = Date.now() + Math.min(120000, 5000 * 2 ** Math.min(next.resourceAttempts - 1, 4)); }
        else await start(next.id, budget.cpu);
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
  if (!Array.isArray(data.accounts) || data.accounts.length > 10000 || data.accounts.some(item => !TG_ACCOUNT_ID.test(item.id) || typeof item.desired !== 'boolean')) fail('账号配置无效');
  settings = tgHostingSettings(data.settings);
  const wasHeld = migrationHold;
  migrationHold = Boolean(data.migrationHold);
  key ||= Buffer.from(data.key, 'hex'); namespace ||= crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  const self = await docker('GET', `/containers/${runtimeName}/json`);
  hostProfiles = self.Mounts.find(mount => mount.Destination === profiles)?.Source;
  if (!hostProfiles || !hostProfiles.startsWith('/')) fail('浏览器持久目录未挂载', 503);
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
      if (migrationHold) { const row = rows.get(item.id); row.desired = false; if (existingIds.has(item.id)) await stop(item.id); else { row.state = 'stopped'; row.containerPresent = false; } }
      else if (wasHeld) { const row = rows.get(item.id); row.desired = item.desired; if (row.desired && row.state === 'stopped') row.state = 'queued'; }
      continue;
    }
    const container = existingIds.has(item.id) ? await inspect(item.id) : null, running = Boolean(container?.State.Running);
    const network = `${name(item.id)}-net`;
    rows.set(item.id, { dirty: true, containerPresent: Boolean(container), memoryMb: container?.HostConfig?.Memory / 1024 ** 2, cpu: container?.HostConfig?.NanoCpus / 1e9, id: item.id, desired: item.desired, state: running ? 'running' : item.desired ? 'queued' : 'stopped', ip: running ? container.NetworkSettings.Networks[network]?.IPAddress : '', error: '', viewers: 0, retryAt: 0, startAttempts: 0, resourceAttempts: 0 });
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
    return { accounts: [...rows.values()].map(tgRuntimeAccount), backupBusy: Boolean(backupLease), resources: resourceCache };
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
      settings = input; return { ok: true };
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
    await fsp.rm(activeMarker(id), { force: true });
    rows.delete(id); return { ok: true };
  });
  if (req.method !== 'POST' || !action) fail('操作不存在', 404);
  if (!rows.has(id)) rows.set(id, { id, state: 'stopped', desired: false, containerPresent: false, viewers: 0, error: '' });
  const row = rows.get(id);
  if (row.pending) fail('该账号正在处理上一个操作，请稍后重试', 409);
  // Acknowledge promptly; heavy profile work stays outside panel HTTP requests.
  if (action === 'wake') {
    if (migrationHold) fail('请先确认旧机器已停止并完成迁移接管', 409);
    await assertImage();
    if (row.pending) fail('该账号正在处理上一个操作，请稍后重试', 409);
    if (backupLease) fail('正在保存备份，请稍后操作', 409);
    row.desired = true;
    row.retryAt = 0; row.startAttempts = 0; row.crashAttempts = 0; row.resourceAttempts = 0; row.error = '';
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
    const vnc = net.connect({ host: row.ip, port: 5900 });
    vnc.setTimeout(30000);
    vnc.on('data', chunk => { if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013); return; } if (ws.readyState === 1) ws.send(chunk); });
    ws.on('message', data => { if (!vnc.write(data)) ws._socket.pause(); });
    vnc.on('drain', () => ws._socket.resume());
    let finished = false;
    const finish = () => { if (finished) return; finished = true; attached.delete(row.id); row.viewers = 0; vnc.destroy(); if (ws.readyState === 1) ws.close(); };
    ws.once('close', finish); ws.once('error', finish); vnc.once('error', finish); vnc.once('close', finish);
    vnc.on('timeout', () => vnc.setTimeout(0));
  });
});
server.listen(socket, async () => { await fsp.chmod(socket, 0o600); await fsp.chown(socket, 10001, 10001); });
const timer = setInterval(() => { if (backupLease?.expires < Date.now()) backupLease = null; void tick().catch(() => {}); }, 5000); timer.unref();
process.on('SIGTERM', () => { closed = true; server.close(); for (const client of wss.clients) client.close(); setTimeout(() => process.exit(0), 100).unref(); });
