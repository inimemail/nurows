import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import { TG_LOGIN_EXPRESSION, advanceTgLogin } from './tg-login-state.js';

// Chromium's anonymous inherited pipe has no network listener. It is owned by
// this process only; callers cannot supply expressions, methods or target URLs.
export function createLoginProbe(input, output) {
  let sequence = 0, buffer = Buffer.alloc(0), closed = false, sampling = false;
  const pending = new Map();
  function close() {
    if (closed) return; closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error('monitor unavailable')); }
    pending.clear(); buffer = Buffer.alloc(0);
  }
  function receive(chunk) {
    if (closed) return;
    if (buffer.length + chunk.length > 256 * 1024) { close(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    for (let end; (end = buffer.indexOf(0)) !== -1;) {
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      try {
        const message = JSON.parse(line.toString()), request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id); clearTimeout(request.timer);
        // An attach may succeed after its deadline. Never leak a debugger
        // session on every sample; clean up the late success before retrying.
        if (request.expired) {
          if (request.method === 'Target.attachToTarget' && message.result?.sessionId) void detach(message.result.sessionId);
          if (request.method === 'Target.detachFromTarget' && message.error) close();
          continue;
        }
        message.error ? request.reject(Error('monitor unavailable')) : request.resolve(message.result);
      } catch { close(); return; }
    }
  }
  output.on('data', receive); output.on('end', close); output.on('error', close); input.on('error', close);
  function requestCommand(method, params, sessionId) {
    if (closed || pending.size >= 4) return Promise.reject(Error('monitor unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => {
        if (method === 'Target.attachToTarget' || method === 'Target.detachFromTarget') {
          // Keep one bounded tombstone until the result is known. A stalled
          // pipe disables further attaches rather than accumulating sessions.
          const request = pending.get(id); if (request) request.expired = true;
        } else pending.delete(id);
        reject(Error('monitor timeout'));
      }, 2500);
      timer.unref?.(); pending.set(id, { resolve, reject, timer, method });
      try { input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) close(); }); }
      catch { close(); }
    });
  }
  async function detach(sessionId) {
    await requestCommand('Target.detachFromTarget', { sessionId }).catch(() => {
      // A timed-out detach remains tracked for a late reply. An explicit
      // failure is not safe to retry by opening still more sessions.
      if (![...pending.values()].some(request => request.method === 'Target.detachFromTarget')) close();
    });
  }
  return {
    close,
    async sample() {
      if (closed || sampling || [...pending.values()].some(request => request.method === 'Target.attachToTarget' || request.method === 'Target.detachFromTarget')) return 'unknown';
      sampling = true;
      let sessionId;
      try {
        const targets = await requestCommand('Target.getTargets');
        const pages = (targets?.targetInfos || []).filter(t => t.type === 'page' && /^https:\/\/web\.telegram\.org\/a\/(?:[?#].*)?$/.test(t.url));
        if (pages.length !== 1) return 'unknown';
        ({ sessionId } = await requestCommand('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true }));
        if (!sessionId) return 'unknown';
        const result = await requestCommand('Runtime.evaluate', { expression: TG_LOGIN_EXPRESSION, returnByValue: true, timeout: 1500, disableBreaks: true }, sessionId);
        const value = result?.exceptionDetails ? 'unknown' : result?.result?.value;
        return ['authenticated', 'login'].includes(value) ? value : 'unknown';
      } catch { return 'unknown'; }
      finally {
        if (sessionId) await detach(sessionId);
        sampling = false;
      }
    },
  };
}
export async function readLoginFile(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1024) return null;
    // Bound the read even if a file is replaced/grown concurrently.
    const buffer = Buffer.alloc(1025), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString());
  } catch { return null; } finally { await handle?.close(); }
}
export async function startLoginMonitor(chromium, { directory = '/profile', token = process.env.TG_MONITOR_TOKEN } = {}) {
  if (!/^[a-f0-9]{32}$/.test(token || '') || !chromium?.stdio?.[3] || !chromium?.stdio?.[4]) return () => {};
  const file = `${directory}/.nurossh-login.json`, probe = createLoginProbe(chromium.stdio[3], chromium.stdio[4]);
  let previous = { everAuthenticated: (await readLoginFile(file))?.everAuthenticated === true }, stopped = false, timer;
  async function sample() {
    if (stopped) return;
    const observation = await probe.sample(); if (stopped) return;
    previous = advanceTgLogin(previous, observation);
    const stage = `${file}.${crypto.randomBytes(6).toString('hex')}.partial`;
    try {
      await fs.writeFile(stage, JSON.stringify({ version: 1, token, ...previous }), { flag: 'wx', mode: 0o600 });
      if (!stopped) await fs.rename(stage, file);
    } catch {} finally { await fs.rm(stage, { force: true }).catch(() => {}); }
    if (!stopped) { timer = setTimeout(sample, 5 * 60000); timer.unref(); }
  }
  // Stagger accounts after a host restart; no periodic reload or wake-up.
  timer = setTimeout(sample, 15000 + crypto.randomInt(45000)); timer.unref();
  return () => { stopped = true; clearTimeout(timer); probe.close(); };
}
