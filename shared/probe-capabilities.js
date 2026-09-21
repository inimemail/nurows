export const POOL_HEALTH_PROBE_VERSION = '1.4.10';

export function supportsPoolHealthCheck(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 10)));
}
