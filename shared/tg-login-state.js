// These are observations of the official Web A UI, never proof of permanent
// server-side authorization. No message text, form values or storage is read.
export const TG_LOGIN_EXPRESSION = `(() => {
  if (location.origin !== 'https://web.telegram.org' || !location.pathname.startsWith('/a/') || !navigator.onLine || document.readyState !== 'complete') return 'unknown';
  const visible = selector => { const e = document.querySelector(selector); if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility === 'visible'; };
  const main = visible('#Main'), auth = visible('.Auth');
  return main && !auth ? 'authenticated' : auth && !main ? 'login' : 'unknown';
})()`;
export function advanceTgLogin(previous = {}, observation, now = Date.now()) {
  const everAuthenticated = previous.everAuthenticated === true || observation === 'authenticated';
  // Loading/offline/timeout breaks the consecutive login-page confirmations.
  const confirmations = observation === 'login' ? Math.min(3, (previous.confirmations || 0) + 1) : 0;
  return { state: observation === 'authenticated' ? 'authenticated' : confirmations >= 3 ? (everAuthenticated ? 'attention' : 'login') : 'unknown',
    everAuthenticated, confirmations, checkedAt: now };
}
export function tgLoginStatus(value, token, now = Date.now()) {
  if (!token || !value || value.token !== token || value.version !== 1 || !Number.isFinite(value.checkedAt) ||
      value.checkedAt > now + 30000 || now - value.checkedAt > 12 * 60000 ||
      !['authenticated', 'attention', 'login', 'unknown'].includes(value.state)) return { loginState: 'unknown' };
  return { loginState: value.state, loginCheckedAt: value.checkedAt };
}
