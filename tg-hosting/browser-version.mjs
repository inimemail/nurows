import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
export function chromiumMajor(value) {
  const match = String(value).match(/(?:^|\s)(\d{2,4})\.\d+\.\d+\.\d+(?:\s|$)/);
  return match ? Number(match[1]) : null;
}
async function savedMajor(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 512) throw Error('invalid version marker');
    const buffer = Buffer.alloc(513), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 512) throw Error('invalid version marker');
    const major = chromiumMajor(buffer.subarray(0, bytesRead).toString().trim());
    if (!major) throw Error('invalid version marker');
    return major;
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } finally { await handle?.close(); }
}
export async function protectBrowserVersion(directory = '/profile', version = execFileSync('chromium', ['--version'], { timeout: 5000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  const current = chromiumMajor(version);
  if (!current) throw Error('browser-version-unavailable');
  const previous = Math.max(await savedMajor(`${directory}/Last Version`), await savedMajor(`${directory}/.nurossh-browser-version`));
  if (previous > current) throw Error('browser-downgrade');
  const file = `${directory}/.nurossh-browser-version`, stage = `${file}.${crypto.randomBytes(6).toString('hex')}.partial`;
  try {
    const handle = await fs.open(stage, 'wx', 0o600);
    try { await handle.writeFile(`${current}.0.0.0\n`); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(stage, file);
    const handleDirectory = await fs.open(directory, 'r'); try { await handleDirectory.sync(); } finally { await handleDirectory.close(); }
  } finally { await fs.rm(stage, { force: true }); }
  return current;
}
