import { spawn } from 'node:child_process';
import fs from 'node:fs';

const children = new Set();
let stopping = false, chromium, forcedStop = false;
function launch(command, args) {
  if (stopping) return null;
  const process = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
  // Keep X and the clipboard alive until Chromium has flushed its profile.
  let displayStopped = false;
  const stopDisplay = () => {
    if (displayStopped) return; displayStopped = true;
    for (const process of children) if (process !== chromium) process.kill('SIGTERM');
  };
  if (chromium && children.has(chromium)) {
    chromium.once('exit', stopDisplay); chromium.kill('SIGTERM');
    setTimeout(() => { if (children.has(chromium)) { forcedStop = true; chromium.kill('SIGKILL'); } stopDisplay(); }, 12000).unref();
  } else stopDisplay();
  const poll = setInterval(() => { if (!children.size) { clearInterval(poll); process.exit(forcedStop ? 75 : code); } }, 100);
  setTimeout(() => { for (const process of children) process.kill('SIGKILL'); process.exit(75); }, 18000).unref();
}
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
fs.mkdirSync('/profile', { recursive: true, mode: 0o700 });
launch('Xtigervnc', [':99', '-geometry', '1280x800', '-depth', '24', '-SecurityTypes', 'None', '-AlwaysShared', '-localhost', 'no', '-rfbport', '5900', '-MaxCutText', '32768', '-nolisten', 'tcp', '-ac']);
for (let i = 0; i < 100 && !fs.existsSync('/tmp/.X11-unix/X99'); i++) await new Promise(resolve => setTimeout(resolve, 50));

launch('openbox', ['--config-file', '/opt/openbox.xml', '--sm-disable']);
chromium = launch('chromium', ['--user-data-dir=/profile', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-breakpad', '--disable-session-crashed-bubble', '--disable-extensions', '--disk-cache-size=33554432', '--media-cache-size=16777216', '--window-size=1280,800', '--start-maximized', '--app=https://web.telegram.org/a/']);

await new Promise(resolve => setTimeout(resolve, 2000));
if (!stopping) launch('tigervncconfig', ['-nowin']);
