import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { runSshWebhook } from '../server/webhook-runtime.js';

const { Server } = ssh2;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
async function fixture(t, execute) {
  const connections = new Set();
  const server = new Server({ hostKeys: [privateKey] }, (connection) => {
    connections.add(connection); connection.on('error', () => {}); connection.on('close', () => connections.delete(connection));
    connection.on('authentication', (ctx) => ctx.accept()).on('ready', () => {
      connection.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => execute(acceptExec(), info.command, connection));
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const connection of connections) connection.end(); await new Promise((resolve) => server.close(resolve)); });
  return { server: { host: '127.0.0.1' }, options: { host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test', readyTimeout: 1000 } };
}

test('SSH commands have a quoted remote deadline and scrub bounded output', async (t) => {
  let wrapper;
  const config = await fixture(t, (stream, command) => {
    wrapper = command; stream.write('token=private-value\n'); stream.stderr.write('stderr\n'); stream.exit(0); stream.end();
  });
  const result = await runSshWebhook("printf '%s' 'literal; $(no-execution)'", 5, { ...config, secrets: ['private-value'] });
  assert.equal(result.status, 'success'); assert.equal(result.ok, true); assert.ok(!result.output.includes('private-value'));
  assert.match(wrapper, /command -v timeout/); assert.match(wrapper, /exec timeout --signal=TERM --kill-after=2s 5s bash -lc/);
  assert.ok(wrapper.includes('literal; $(no-execution)')); assert.match(result.output, /stderr/);
});

test('remote failure and timeout remain distinct and uncertain disconnects are never called success', async (t) => {
  let count = 0;
  const config = await fixture(t, (stream, _command, connection) => {
    count++;
    if (count === 3) { connection.end(); return; }
    stream.exit(count === 1 ? 2 : 124); stream.end();
  });
  const failed = await runSshWebhook('false', 5, config);
  assert.equal(failed.status, 'failed'); assert.equal(failed.uncertain, false);
  const timeout = await runSshWebhook('sleep 100', 5, config);
  assert.equal(timeout.status, 'timeout'); assert.equal(timeout.uncertain, true);
  const disconnected = await runSshWebhook('curl submit', 5, config);
  assert.equal(disconnected.status, 'uncertain'); assert.equal(disconnected.ok, false); assert.equal(disconnected.uncertain, true);
});

test('cancelling SSH after submission records uncertainty and releases the connection', async (t) => {
  const controller = new AbortController();
  const config = await fixture(t, () => controller.abort());
  const result = await runSshWebhook('curl submit', 5, { ...config, signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.uncertain, true); assert.equal(result.ok, false);
});

test('proxy sockets arriving after cancellation are destroyed without starting SSH', async () => {
  const controller = new AbortController(); let release, destroyed = false;
  const late = new Promise((resolve) => { release = resolve; });
  const running = runSshWebhook('echo test', 5, { server: { host: 'test.invalid' }, options: {}, signal: controller.signal, proxySocket: () => late });
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  const result = await running; assert.equal(result.status, 'cancelled'); assert.equal(result.uncertain, false);
  release({ destroy() { destroyed = true; } }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(destroyed, true);
});
