import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { startLoginMonitor } from './shared/tg-login-monitor.js';
import { protectBrowserVersion } from './browser-version.mjs';

const children = new Set();
let stopping = false, chromium, forcedStop = false, stopMonitor = () => {};
function launch(command, args, pipe = false) {
  if (stopping) return null;
  const process = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', ...(pipe ? ['pipe', 'pipe'] : [])] });
  children.add(process);
  // Never log URLs, clipboard, page text, or login input.
  process.stderr.resume();
  process.on('exit', () => { children.delete(process); if (!stopping) stop(1); });
  process.on('error', () => stop(1));
  return process;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  stopMonitor();
  // Keep X and the clipboard alive until Chromium has flushed its profile.
  let displayStopped = false;
  const stopDisplay = () => {
    if (displayStopped) return; displayStopped = true;
    for (const process of children) if (process !== chromium) process.kill('SIGTERM');
  };
  if (chromium && children.has(chromium)) {
    chromium.once('exit', (exitCode, signal) => { if (exitCode !== 0 || signal) forcedStop = true; stopDisplay(); }); chromium.kill('SIGTERM');
    setTimeout(() => { if (children.has(chromium)) { forcedStop = true; chromium.kill('SIGKILL'); } stopDisplay(); }, 12000).unref();
  } else stopDisplay();
  const poll = setInterval(() => { if (!children.size) { clearInterval(poll); process.exit(forcedStop ? 75 : code); } }, 100);
  setTimeout(() => { for (const process of children) process.kill('SIGKILL'); process.exit(75); }, 18000).unref();
}
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
fs.mkdirSync('/profile', { recursive: true, mode: 0o700 });
try { await protectBrowserVersion(); }
catch (error) {
  // A lower browser must never open a newer login database. Keep every file.
  const code = error.message === 'browser-downgrade' ? error.message : 'browser-version-unavailable';
  const stage = `/profile/.nurossh-browser-error.${crypto.randomBytes(6).toString('hex')}.partial`;
  try { fs.writeFileSync(stage, JSON.stringify({ code, token: process.env.TG_MONITOR_TOKEN }), { flag: 'wx', mode: 0o600 }); fs.renameSync(stage, '/profile/.nurossh-browser-error.json'); } catch {}
  finally { try { fs.rmSync(stage, { force: true }); } catch {} }
  process.exit(78);
}
launch('Xtigervnc', [':99', '-geometry', '1024x768', '-depth', '24', '-SecurityTypes', 'None', '-AlwaysShared', '-localhost', 'no', '-rfbport', '5900', '-FrameRate', '30', '-MaxCutText', '32768', '-nolisten', 'tcp', '-ac']);
for (let i = 0; i < 100 && !fs.existsSync('/tmp/.X11-unix/X99'); i++) await new Promise(resolve => setTimeout(resolve, 50));

launch('openbox', ['--config-file', '/opt/openbox.xml', '--sm-disable']);
// VPS sessions use a single app window. Avoid GPU acceleration and optional
// Chrome services; keep the sandbox, Telegram workers and persistent storage.
chromium = launch('chromium', ['--user-data-dir=/profile', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-breakpad', '--disable-session-crashed-bubble', '--disable-extensions', '--disable-gpu', '--renderer-process-limit=2', '--disable-background-networking', '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication', '--disk-cache-size=16777216', '--media-cache-size=8388608', '--window-size=1024,768', '--start-maximized', '--app=https://web.telegram.org/a/'], true);
if (!stopping) stopMonitor = await startLoginMonitor(chromium).catch(() => () => {});
if (stopping) stopMonitor();

await new Promise(resolve => setTimeout(resolve, 2000));
if (!stopping) launch('tigervncconfig', ['-nowin']);
