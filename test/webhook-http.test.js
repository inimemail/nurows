import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('real application isolates panel authentication, accepts background hooks and persists them across restart', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurows-webhook-http-'));
  const listener = createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  let child, cookie = '', errors = '';
  const stop = async () => { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], { cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (data) => { errors = (errors + data).slice(-2000); }); child.stdout.resume();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) assert.fail(`应用启动失败：${errors}`);
      try { const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`); if (response.ok) return; } catch { /* wait for startup */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`应用未就绪：${errors}`);
  };
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
  await start(); assert.equal((await request('/api/webhooks')).status, 401);
  const setup = await request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'webhook-test', password: 'local-test-only' }) });
  assert.equal(setup.status, 200); cookie = setup.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const workspace = await request('/api/workspace', { method: 'POST', body: JSON.stringify({ tab: 'webhooks', search: 'HTTP' }) });
  assert.equal(workspace.status, 200);
  assert.equal((await (await request('/api/state')).json()).workspace.tab, 'webhooks');
  const created = await request('/api/webhooks', { method: 'POST', body: JSON.stringify({ name: 'HTTP 测试', command: "printf 'safe-output'; sleep 0.15" }) });
  assert.equal(created.status, 201); const task = await created.json();
  const { token } = await (await request(`/api/webhooks/${task.id}/token`)).json();
  assert.equal((await request(`/hooks/${task.id}/run`, { method: 'POST' })).status, 401);
  const credentials = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'same-operation' };
  const accepted = await request(`/hooks/${task.id}/run`, { method: 'POST', headers: credentials, body: JSON.stringify({ command: 'echo forbidden' }) });
  assert.equal(accepted.status, 202); const run = await accepted.json();
  const duplicate = await (await request(`/hooks/${task.id}/run`, { method: 'POST', headers: credentials })).json();
  assert.equal(duplicate.executionId, run.executionId); assert.equal(duplicate.duplicate, true);
  let output;
  for (let i = 0; i < 100; i++) {
    output = await (await request(`/api/webhooks/runs/${run.executionId}`)).json();
    if (output.status === 'success') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(output.status, 'success'); assert.equal(output.output, 'safe-output'); assert.equal(output.snapshot, undefined);
  const status = await (await request(`/hooks/${task.id}/status?executionId=${run.executionId}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(status.status, 'success'); assert.equal(status.output, undefined);
  assert.equal((await request(`/hooks/${task.id}/status?token=${token}`)).status, 405);
  await stop(); cookie = ''; await start();
  const persisted = await (await request(`/hooks/${task.id}/run`, { method: 'POST', headers: credentials })).json();
  assert.equal(persisted.executionId, run.executionId); assert.equal(persisted.status, 'success'); assert.equal(persisted.duplicate, true);
  assert.equal(errors, '');
});
