export const TG_HOSTING_DEFAULTS = Object.freeze({ maxRunning: 2, memoryMb: 1024, cpu: 1, cpuTotal: 0, storageGb: 5 });
export const TG_PROFILE_MAX_BYTES = 20 * 1024 ** 3;
export const TG_PROFILE_MAX_FILES = 100000;
export const TG_BROWSER_MIN_MEMORY_MB = 512;
// Session protection/status metadata is backed up, but cannot by itself prove
// that any Chromium login data remains. Keep in sync with profile-archive.py.
export function tgProfileDataName(name) {
  return !/^\.nurossh-(?:login\.json|browser-version|browser-error\.json)(?:\.[a-f0-9]{12}\.partial)?$/.test(name) &&
    !['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(name) && !/^\.tg-snapshot-.*\.tar\.gz$/.test(name);
}
// Keep desktop rendering bounded even when the viewer fills a 4K monitor.
// noVNC scales the resulting framebuffer and translates pointer coordinates.
export function tgViewerSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const ratio = Math.min(1, 1440 / width, 900 / height);
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) };
}
export const TG_HOSTING_STATES = Object.freeze({ stopped: '休眠', queued: '等待启动', starting: '启动中', running: '后台保持', stopping: '正在休眠', saving: '保存快照中', error: '运行异常', unavailable: '组件未连接' });
export const TG_ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function hostingError(message, statusCode = 400) { return Object.assign(Error(message), { statusCode }); }
export function tgResumeOrder(accounts) {
  return [...accounts].sort((a, b) => Number(Boolean(b.lastRunningAt)) - Number(Boolean(a.lastRunningAt)) ||
    (Date.parse(b.lastRunningAt || '') || 0) - (Date.parse(a.lastRunningAt || '') || 0) ||
    (Date.parse(a.createdAt || '') || 0) - (Date.parse(b.createdAt || '') || 0));
}
export function tgRetryDelay(attempt, oom = false) {
  return (oom ? [300000, 900000, 1800000] : [60000, 300000, 900000])[attempt - 1] ?? null;
}
export function tgCrashAttempts(row, now = Date.now()) {
  // Count a burst of failures, not every failure over an account's lifetime.
  return Number.isFinite(row.healthySince) && now - row.healthySince >= 30 * 60000 ? 0 : (row.crashAttempts || 0);
}
export function tgViewRetryDelay(attempt) {
  return [2000, 5000, 10000, 20000, 30000][attempt - 1] ?? null;
}
export function tgRuntimeAccount(row) {
  const value = { id: row.id, state: row.state };
  if (row.state === 'running' && ['authenticated', 'attention', 'login', 'unknown'].includes(row.loginState) && Number.isFinite(row.loginCheckedAt)) {
    value.loginState = Date.now() - row.loginCheckedAt > 12 * 60000 ? 'unknown' : row.loginState;
    value.loginCheckedAt = row.loginCheckedAt;
  }
  for (const field of ['pending', 'snapshotAt', 'startedAt', 'retryAt', 'memoryMb', 'cpu', 'viewers']) if (row[field]) value[field] = row[field];
  for (const field of ['storageBytes', 'snapshotBytes']) if (Number.isFinite(row[field]) && row[field] >= 0) value[field] = row[field];
  if (row.storageCheckedAt) value.storageCheckedAt = row.storageCheckedAt;
  if (row.storageBlocked) value.storageBlocked = true;
  if (row.storageMaintaining) value.storageMaintaining = true;
  // The UI displays one error. Avoid duplicating long errors across thousands
  // of accounts in the runner's bounded status response.
  if (row.storageError && !row.error && !row.healthError && !row.snapshotError) value.storageError = String(row.storageError).slice(0, 160);
  if (row.error || row.healthError) value.error = String(row.error || row.healthError).slice(0, 160);
  else if (row.snapshotError) value.snapshotError = String(row.snapshotError).slice(0, 160);
  return value;
}
export function tgDiskReserve(totalBytes) {
  return Math.min(4 * 1024 ** 3, Math.max(1024 ** 3, totalBytes * .05));
}
export function tgHostIsolationBlock(info) {
  if (info.MemoryLimit !== true || info.SwapLimit !== true) return '宿主机不支持完整的内存限额，已暂停新账号启动；请检查 Docker 和内核 cgroup 配置';
  if (info.CpuCfsQuota !== true || info.PidsLimit !== true) return '宿主机不支持 CPU 或进程数限额，已暂停新账号启动；请检查 Docker 和内核 cgroup 配置';
  return '';
}
export function tgBrowserLimitError(config, memoryMb, cpu) {
  const bytes = memoryMb * 1024 ** 2;
  if (!config || config.Memory !== bytes || config.MemorySwap !== bytes ||
      !Number.isFinite(config.NanoCpus) || config.NanoCpus <= 0 || config.NanoCpus > Math.floor(cpu * 1e9) ||
      !Number.isInteger(config.PidsLimit) || config.PidsLimit <= 0 || config.PidsLimit > 256) return '浏览器资源限额校验失败，未启动账号；登录资料已保留';
  return '';
}
export function tgContainerHealth(container) {
  const status = String(container?.State?.Health?.Status || container?.Status || '').toLowerCase();
  if (status.includes('unhealthy')) return 'unhealthy';
  if (status.includes('healthy')) return 'healthy';
  return 'unknown';
}
export function tgMemoryBudget(resources, maximumMb) {
  const blocked = reason => ({ memoryMb: 0, reason });
  if (!resources || resources.error || !Number.isFinite(resources.totalMb) || resources.totalMb <= 0 || !Number.isFinite(resources.availableMb) || resources.availableMb < 0 || !Number.isFinite(resources.reservedMb) || resources.reservedMb < 0 || !Number.isFinite(maximumMb) || maximumMb < TG_BROWSER_MIN_MEMORY_MB) return blocked('暂时无法读取服务器资源，已暂停新账号启动');
  if (resources.isolationError) return blocked(resources.isolationError);
  if (resources.diskLow) return blocked('磁盘空间不足，已暂停启动并保留登录资料，请清理宿主机磁盘');
  // A setting is an upper bound, not a requirement to allocate a full GiB.
  // Keep host headroom AND the unused portion of existing browser hard limits.
  // Without a valid usage sample, reserve every byte of those limits.
  const growthMb = resources.growthMb ?? resources.reservedMb;
  if (!Number.isFinite(growthMb) || growthMb < 0 || growthMb > resources.reservedMb) return blocked('暂时无法确认账号内存预算，已暂停新账号启动');
  const reserveMb = Math.max(384, resources.totalMb * .2);
  const totalHeadroom = resources.totalMb - resources.reservedMb - reserveMb;
  if (totalHeadroom < TG_BROWSER_MIN_MEMORY_MB) return blocked(`内存预算不足：已有账号限额合计 ${Math.ceil(resources.reservedMb)} MB，需保留 ${Math.ceil(reserveMb)} MB 系统余量；已排队等待`);
  const available = Math.min(totalHeadroom, resources.availableMb - growthMb - Math.min(reserveMb, 1024));
  const memoryMb = Math.floor(Math.min(maximumMb, available) / 128) * 128;
  if (memoryMb < TG_BROWSER_MIN_MEMORY_MB) return blocked(`内存预算不足：可用 ${Math.floor(resources.availableMb)} MB，需至少 ${Math.ceil(growthMb + Math.min(reserveMb, 1024) + TG_BROWSER_MIN_MEMORY_MB)} MB；已排队，空闲后自动重试`);
  return { memoryMb, reserveMb, reason: '' };
}
export function tgCpuTotal(totalCpus, configured = 0) {
  if (!Number.isFinite(totalCpus) || totalCpus <= 0 || !Number.isFinite(configured) || configured < 0) throw hostingError('暂时无法确认服务器 CPU 容量', 503);
  return Math.min(totalCpus, configured || totalCpus * .75);
}
export function tgResourceBlock(resources, memoryMb) {
  return tgMemoryBudget(resources, memoryMb).reason;
}
export function tgBrowserGrowthMb(stats, limitMb) {
  const memory = stats?.memory_stats, values = memory?.stats;
  const usage = memory?.usage, inactive = values?.total_inactive_file ?? values?.inactive_file;
  if (!Number.isFinite(usage) || usage < 0 || !Number.isFinite(inactive) || inactive < 0 || inactive > usage || memory.limit !== limitMb * 1024 ** 2) return limitMb;
  // Match Docker's working-set calculation: reclaimable cache cannot pay for
  // both MemAvailable and a browser's future growth at the same time.
  return Math.max(0, limitMb - (usage - inactive) / 1024 ** 2);
}
export function tgDiskNeedsParking(resources) {
  return Boolean(resources && !resources.error && resources.diskLow && Number.isFinite(resources.diskHeadroomBytes) && resources.diskHeadroomBytes < 0);
}
export function tgHostingSettings(input = {}) {
  const value = { ...TG_HOSTING_DEFAULTS, ...input };
  if (!Number.isInteger(value.maxRunning) || value.maxRunning < 1 || value.maxRunning > 50) throw hostingError('同时运行数量应为 1–50');
  if (!Number.isInteger(value.memoryMb) || value.memoryMb < TG_BROWSER_MIN_MEMORY_MB || value.memoryMb > 8192 || value.memoryMb % 128) throw hostingError('单账号内存应为 512–8192 MB，按 128 MB 调整');
  if (!Number.isFinite(value.cpu) || value.cpu < 0.25 || value.cpu > 4 || value.cpu * 4 % 1) throw hostingError('单账号 CPU 应为 0.25–4 核，按 0.25 核调整');
  if (!Number.isFinite(value.cpuTotal) || value.cpuTotal < 0 || value.cpuTotal > 256 || value.cpuTotal !== 0 && (value.cpuTotal < .25 || value.cpuTotal * 4 % 1)) throw hostingError('整体 CPU 应为自动或 0.25–256 核，按 0.25 核调整');
  if (!Number.isInteger(value.storageGb) || value.storageGb < 1 || value.storageGb > 20) throw hostingError('单账号存储上限应为 1–20 GB');
  return { maxRunning: value.maxRunning, memoryMb: value.memoryMb, cpu: value.cpu, cpuTotal: value.cpuTotal, storageGb: value.storageGb };
}
export function tgHostingAccount(input, old = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw hostingError('账号信息格式无效');
  const field = (name, max) => {
    if (typeof (input[name] ?? '') !== 'string' || (input[name] || '').length > max) throw hostingError('账号信息格式或长度无效');
    return (input[name] || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  };
  const name = field('name', 100), phone = field('phone', 40), group = field('group', 60), note = field('note', 500);
  if (!name) throw hostingError('请填写账号名称');
  if (phone && !/^\+?[\d ()-]{5,40}$/.test(phone)) throw hostingError('手机号格式不正确');
  const mode = input.mode ?? old.mode ?? 'keep';
  if (!['keep', 'sleep'].includes(mode)) throw hostingError('运行模式无效');
  return { name, phone, group, note, mode };
}
