import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('real 2FA API isolates secrets, persists through restart, and needs new grants after login', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nurows-authenticator-http-'));
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let child, cookie = '', errors = '';
  const stop = async () => { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], { cwd: directory, env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', data => { errors = (errors + data).slice(-2000); }); child.stdout.resume();
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) assert.fail(`应用启动失败：${errors}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`应用未就绪：${errors}`);
  };
  const call = (path, body, method = 'POST', token = '') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-Authenticator-Unlock': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const password = 'local-test-password';
  await start();
  assert.equal((await call('/api/authenticator', undefined, 'GET')).status, 401);
  const setup = await call('/api/auth/setup', { username: '2fa-test', password });
  assert.equal(setup.status, 200);
  cookie = setup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const config = { issuer: 'Example', account: 'admin@example.com', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30 };
  assert.equal((await call('/api/authenticator', config)).status, 423);
  assert.equal((await call('/api/authenticator/unlock', { password: 'wrong' })).status, 403);
  const unlock = await call('/api/authenticator/unlock', { password });
  assert.equal(unlock.status, 200); const grant = await unlock.json();
  const created = await call('/api/authenticator', config, 'POST', grant.token);
  assert.equal(created.status, 201); const item = (await created.json()).item;
  const metadata = await call('/api/authenticator', undefined, 'GET');
  assert.equal(metadata.headers.get('cache-control'), 'no-store');
  assert.ok(!(await metadata.text()).includes(config.secret));
  assert.ok(!(await (await call('/api/state', undefined, 'GET')).text()).includes(config.secret));
  const exported = await call('/api/authenticator/export', { password, passphrase: 'backup-password-local' }, 'POST', grant.token);
  assert.equal(exported.status, 200); const backup = await exported.json();
  assert.ok(!JSON.stringify(backup).includes(config.secret));
  assert.equal((await call('/api/authenticator/import', { ...backup, passphrase: 'incorrect-password' }, 'POST', grant.token)).status, 400);
  const reveal = await call(`/api/authenticator/${item.id}/reveal`, { password }, 'POST', grant.token);
  assert.equal((await reveal.json()).item.secret, config.secret);
  await call('/api/auth/logout', {});
  assert.equal((await call('/api/authenticator/session', {}, 'POST', grant.token)).status, 401);
  await stop(); cookie = ''; await start();
  const login = await call('/api/auth/login', { username: '2fa-test', password });
  assert.equal(login.status, 200); cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await call('/api/authenticator/session', {}, 'POST', grant.token)).status, 423);
  const reopened = await (await call('/api/authenticator/unlock', { password })).json();
  assert.equal(reopened.accounts[0].secret, config.secret);
  assert.equal(reopened.accounts[0].id, item.id);
  assert.equal((await call('/api/workspace', { tab: 'authenticator' })).status, 200);
  assert.equal((await (await call('/api/state', undefined, 'GET')).json()).workspace.tab, 'authenticator');
  assert.equal(errors, '');
});
