import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TG_PROFILE_MAX_FILES } from './tg-hosting.js';

// Exact Chromium cache locations only. Never match arbitrary directory names:
// IndexedDB, Local Storage, Cookies, Sessions and Service Worker are retained.
export const PROFILE_CACHE_PATHS = [
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/Media Cache',
  'Default/DawnCache', 'Default/GrShaderCache', 'Default/ShaderCache',
  'GPUCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'BrowserMetrics',
];
const ignored = name => ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(name) || /^\.tg-snapshot-[a-f0-9-]+\.tar\.gz$/.test(name);
const cachePath = relative => PROFILE_CACHE_PATHS.some(value => relative === value || relative.startsWith(value + '/'));
const DAY = 24 * 60 * 60000;

// Scheduling metadata lives outside Chromium's profile. A restart must not
// restart the daily timer, or repeatedly clean every account at once.
export function createCacheMaintenance(profiles) {
  const filename = id => {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw Error('账号标识无效');
    return path.join(profiles, `.cache-cleaned-${id}`);
  };
  return {
    async read(id) {
      let handle;
      try {
        handle = await fs.open(filename(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await handle.stat();
        if (!info.isFile() || info.size > 160) throw Error('缓存维护时间文件无效');
        return JSON.parse(await handle.readFile('utf8'));
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      finally { await handle?.close(); }
    },
    async write(id, value) {
      const target = filename(id), temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async forget(id) { await fs.rm(filename(id), { force: true }); },
  };
}

export async function scanProfile(root, { maxFiles = TG_PROFILE_MAX_FILES, timeoutMs = 30000, excludeCaches = false } = {}) {
  const result = { bytes: 0, cacheBytes: 0, files: 0, filesExceeded: false };
  const deadline = Date.now() + timeoutMs;
  try {
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('账号配置目录无效');
  } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  async function walk(directory, relative = '', depth = 0) {
    if (depth > 40) throw Error('账号配置目录层级过深，已停止统计');
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (!relative && ignored(entry.name)) continue;
      if (Date.now() > deadline) throw Error('存储统计超时，稍后重试；登录资料保留');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (excludeCaches && cachePath(name)) continue;
      if (++result.files > maxFiles) { result.filesExceeded = true; return; }
      if (entry.isSymbolicLink()) throw Error('账号配置包含不允许的符号链接');
      const current = path.join(directory, entry.name);
      try {
        if (entry.isDirectory()) await walk(current, name, depth + 1);
        else if (entry.isFile()) {
          const info = await fs.lstat(current);
          if (!info.isFile() || info.isSymbolicLink()) throw Error('账号配置文件类型发生变化');
          result.bytes += info.size;
          if (cachePath(name)) result.cacheBytes += info.size;
        } else throw Error('账号配置包含不支持的文件类型');
      } catch (error) { if (error.code !== 'ENOENT') throw error; } // Live caches rotate during a scan.
      if (result.filesExceeded) return;
    }
  }
  await walk(root);
  return result;
}

// Caller must confirm Chromium has stopped. Check every ancestor so a symlink
// cannot turn a cache removal into deleting data elsewhere on the host.
export async function cleanProfileCaches(root) {
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('账号配置目录无效');
  for (const relative of PROFILE_CACHE_PATHS) {
    let current = root, exists = true;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try {
        const entry = await fs.lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw Error('缓存目录类型无效，未清理');
      } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; break; }
    }
    if (exists) await fs.rm(current, { recursive: true });
  }
}

// One account at a time, independent of list polling and the Docker watchdog.
// Filesystem scans are outside the mutation lock; only stop/cleanup decisions
// acquire it. A quota is a periodic management threshold, not a filesystem quota.
export function createProfileStorage({ rows, profiles, snapshots, getLimit, exclusive, blocked, stop,
  scan = scanProfile, clean = cleanProfileCaches, now = Date.now, maintenance = createCacheMaintenance(profiles),
  canClean = row => !row.uncleanStop }) {
  let working = false, cursor = rows.values();
  const scanJobs = new Map();
  async function remember(row, time, cleaned = false) {
    row.storageDailyAt = time;
    if (cleaned) row.storageCleanedAt = time;
    row.storageMaintenanceUnsaved = true;
    try {
      await maintenance.write(row.id, { checkedAt: time, cleanedAt: row.storageCleanedAt || 0 });
      row.storageMaintenanceUnsaved = false; row.storageMaintenanceError = '';
    } catch { row.storageMaintenanceError = '缓存维护时间暂未保存；登录资料保留'; }
  }
  async function loadMaintenance(row) {
    if (!row.storageMaintenanceLoaded) {
      let value;
      try { value = await maintenance.read(row.id); }
      catch { row.storageMaintenanceError = '缓存维护时间暂不可读；登录资料保留'; }
      row.storageMaintenanceLoaded = true;
      const valid = time => Number.isSafeInteger(time) && time > 0 && time <= now();
      if (valid(value?.checkedAt)) {
        row.storageDailyAt = value.checkedAt;
        if (valid(value.cleanedAt)) row.storageCleanedAt = value.cleanedAt;
      }
      else {
        // Spread first-time maintenance across an hour, never clean on install.
        const offset = createHash('sha256').update(row.id).digest().readUInt32BE(0) % (60 * 60000);
        await remember(row, now() - offset);
      }
    } else if (row.storageMaintenanceUnsaved) await remember(row, row.storageDailyAt);
  }
  const dailyDue = row => now() - row.storageDailyAt >= DAY;
  async function usage(row) {
    if (scanJobs.has(row.id)) return scanJobs.get(row.id);
    const pending = (async () => {
      await loadMaintenance(row);
      const value = await scan(path.join(profiles, row.id));
      if (rows.get(row.id) === row) {
        row.storageBytes = value.bytes; row.storageCheckedAt = now(); row.storageError = row.storageMaintenanceError || '';
        row.storageSample = (row.storageSample || 0) + 1;
        try { row.snapshotBytes = (await fs.stat(path.join(snapshots, `${row.id}.tar.gz.enc`))).size; }
        catch (error) { if (error.code === 'ENOENT') row.snapshotBytes = 0; else row.storageError = '暂时无法统计快照大小'; }
      }
      return value;
    })().finally(() => scanJobs.delete(row.id));
    scanJobs.set(row.id, pending); return pending;
  }
  const over = value => value.filesExceeded || value.bytes >= getLimit();
  function hold(row, value) {
    row.storageBlocked = true; row.state = 'error'; row.retryAt = 0;
    row.storageScanAfter = now() + 5 * 60000;
    row.error = value?.filesExceeded ? '账号配置超过 10 万文件；资料已保留，请清理缓存后再打开' : `账号存储达到 ${getLimit() / 1024 ** 3} GB 上限；登录资料已保留，请提高上限或清理后再打开`;
  }
  async function prepare(row, { cleanAllowed = true } = {}) {
    let value = await usage(row);
    if (cleanAllowed && canClean(row) && (value.filesExceeded || value.bytes >= getLimit() * .85 || dailyDue(row)) && (value.cacheBytes > 0 || value.filesExceeded)) {
      await clean(path.join(profiles, row.id)); await remember(row, now(), true); value = await usage(row);
    }
    if (over(value)) { hold(row, value); throw Object.assign(Error(row.error), { storageBlocked: true }); }
    row.storageBlocked = false;
    row.storageScanAfter = now() + 5 * 60000;
    return value;
  }
  // The runner calls this inside its mutation lock after confirming a clean
  // stop. No extra scan: the checkpoint already measures retained files next.
  async function cleanStopped(row) {
    if (row.containerPresent !== false || !canClean(row)) throw Error('浏览器未确认正常停止，未清理任何登录资料');
    await clean(path.join(profiles, row.id));
    await remember(row, now(), true);
    row.storageError = row.storageMaintenanceError || '';
  }
  async function tick() {
    if (working || blocked()) return;
    let row;
    // A large collection of dormant accounts must not delay running accounts.
    for (const candidate of rows.values()) {
      if (candidate.state === 'running' && !candidate.pending && !candidate.storageMaintaining &&
          (!candidate.storageScanAfter || candidate.storageScanAfter <= now()) &&
          (!row || (candidate.storageScanAfter || 0) < (row.storageScanAfter || 0))) row = candidate;
    }
    for (let count = 0; count < rows.size && !row; count++) {
      let item = cursor.next();
      if (item.done) { cursor = rows.values(); item = cursor.next(); }
      const candidate = item.value;
      if (candidate && !candidate.pending && !candidate.storageMaintaining && ['running', 'stopped', 'queued', 'error'].includes(candidate.state) &&
          (!candidate.storageScanAfter || candidate.storageScanAfter <= now())) { row = candidate; break; }
    }
    if (!row) return;
    working = true;
    row.storageScanAfter = now() + (row.state === 'running' || row.storageBlocked ? 5 * 60000 : 30 * 60000);
    try {
      let value = await usage(row);
      const sample = row.storageSample;
      if (rows.get(row.id) !== row || blocked()) return;
      const nearWithCache = value.bytes >= getLimit() * .85 && value.cacheBytes >= 64 * 1024 ** 2 &&
        (!row.storageCleanedAt || now() - row.storageCleanedAt >= 30 * 60000);
      const dailyWithCache = dailyDue(row) && value.cacheBytes > 0;
      if (dailyDue(row) && !value.cacheBytes && !value.filesExceeded) await remember(row, now());
      if (!over(value) && !nearWithCache && !dailyWithCache) {
        if (row.storageBlocked) await exclusive(() => {
          if (rows.get(row.id) === row && !blocked() && !row.pending && row.storageBlocked && row.storageSample === sample && ['error', 'stopped'].includes(row.state)) {
            row.storageBlocked = false; row.error = ''; row.state = row.desired ? 'queued' : 'stopped';
          }
        });
        return;
      }
      // Routine work must not disconnect someone using the account. Quota
      // enforcement still takes precedence to protect the host's disk space.
      if (!over(value) && row.viewers > 0) return;
      let stopped = false;
      await exclusive(async () => {
        if (rows.get(row.id) !== row || blocked() || row.pending || row.storageSample !== sample || !['running', 'stopped', 'queued', 'error'].includes(row.state)) return;
        if (!over(value) && row.viewers > 0) return;
        const wasRunning = row.state === 'running';
        row.storageMaintaining = true;
        try {
          if (row.containerPresent !== false) await stop(row.id);
          row.state = 'stopped'; stopped = true;
          // A forced/OOM exit keeps every current file and the old snapshot.
          if (!canClean(row)) throw Error('浏览器未正常退出，已暂停并保留全部资料；请重新打开使浏览器恢复后再清理');
          await clean(path.join(profiles, row.id)); await remember(row, now(), true);
        } catch (error) {
          if (!stopped && wasRunning) row.state = 'running';
          else { row.storageBlocked = true; row.state = 'error'; }
          throw error;
        }
      });
      if (!stopped) return;
      value = await usage(row);
      await exclusive(() => {
        if (rows.get(row.id) !== row) return;
        if (over(value)) hold(row, value);
        else { row.storageBlocked = false; row.error = ''; if (!blocked() && !row.pending) row.state = row.desired ? 'queued' : 'stopped'; }
      });
    } catch (error) {
      if (rows.get(row.id) === row) {
        row.storageError = error.code ? `存储检查失败（${error.code}），稍后重试；登录资料保留` : error.message;
        if (row.storageMaintaining && row.state === 'stopped') {
          row.storageBlocked = true; row.state = 'error'; row.storageScanAfter = now() + 60000;
          row.error = '缓存已清理，暂时无法确认存储用量；账号已暂停，稍后自动重试';
        }
      }
    }
    finally { row.storageMaintaining = false; working = false; }
  }
  return { usage, prepare, tick, hold, cleanStopped, forget: id => maintenance.forget(id) };
}
