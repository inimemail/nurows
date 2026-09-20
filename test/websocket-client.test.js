import assert from 'node:assert/strict';
import test from 'node:test';
import { openAuthenticatedWebSocket } from '../shared/websocket-client.js';

test('browser terminal and command sockets request a fresh one-use proof without putting it in the URL', async () => {
  const calls = [], sockets = [];
  class Socket { constructor(...args) { sockets.push(args); } }
  for (const path of ['/ws/terminal?serverId=a', '/ws/command-job?jobId=b&serverId=a']) {
    await openAuthenticatedWebSocket(`wss://panel.example${path}`, { Socket, fetchImpl: async (...args) => {
      calls.push(args); return { ok: true, json: async () => ({ ticket: 'a'.repeat(64) }) };
    } });
    assert.deepEqual(sockets.at(-1), [`wss://panel.example${path}`, ['nurossh-v1', `nurossh-ticket.${'a'.repeat(64)}`]]);
    assert.equal(calls.at(-1)[0], '/api/auth/ws-ticket');
    assert.equal(calls.at(-1)[1].credentials, 'same-origin');
    assert.equal(JSON.parse(calls.at(-1)[1].body).path, path.split('?')[0]);
  }
  assert.equal(calls.length, 2);
});

test('expired login and denied ticket requests never start a socket and produce an actionable error', async () => {
  class Socket { constructor() { assert.fail('must not open a socket'); } }
  for (const [status, error, expected] of [[401, '', /重新登录/], [403, '来源校验失败', /来源校验失败/], [200, '', /前后端已同时更新/]]) {
    await assert.rejects(openAuthenticatedWebSocket('wss://panel.example/ws/terminal', {
      Socket, fetchImpl: async () => ({ status, ok: status === 200, json: async () => ({ error }) })
    }), expected);
  }
});

test('closing a terminal while a ticket request is pending cannot open a stale connection', async () => {
  const controller = new AbortController();
  let finish;
  const pending = openAuthenticatedWebSocket('wss://panel.example/ws/terminal', {
    signal: controller.signal, Socket: class { constructor() { assert.fail('stale socket'); } },
    fetchImpl: () => new Promise((resolve) => { finish = resolve; })
  });
  controller.abort();
  finish({ ok: true, json: async () => ({ ticket: 'a'.repeat(64) }) });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('ticket requests time out instead of leaving terminals stuck connecting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = openAuthenticatedWebSocket('wss://panel.example/ws/terminal', {
    Socket: class { constructor() { assert.fail('timed-out socket'); } },
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  });
  const rejected = assert.rejects(pending, /连接凭证超时/);
  t.mock.timers.tick(10000);
  await rejected;
});
