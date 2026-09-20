import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { orchestrationDefaults, registerProbePublicRoutes, registerOrchestrationRoutes, scanOfflineProbes } from '../server/orchestration.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function harness(probe = {}) {
  let state = { ...orchestrationDefaults(), probes: [{ id: 'p', name: '测试探针', status: 'pending', enabled: true, agentSecretHash: hash('secret'), tokenHash: hash('register'), ...probe }], telegramBots: [{ id: 'bot', enabled: true, tokenEnc: 'encrypted' }] };
  let writes = 0;
  const events = [], reads = [], routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, fn) => routes.set(`${method} ${path}`, fn)]));
  const deps = { readState(keys) { reads.push(keys); return structuredClone(state); },
    updateState(mutate) { state = mutate(structuredClone(state)); writes++; return state; },
    notifyProbePresence(items) { events.push(...items); }, allowProbeRegistration: () => true,
    sanitizeState: (value) => value, encryptSecret: (value) => value
  };
  registerProbePublicRoutes(app, deps);
  registerOrchestrationRoutes(app, deps);
  return { deps, events, reads, state: () => state, writes: () => writes,
    async request(method, route, body = {}, params = {}) {
      let result;
      await routes.get(`${method} ${route}`)({ headers: { 'x-probe-id': 'p', authorization: 'Bearer secret' }, body, params, auth: { username: 'tester' } },
        { json(value) { result = value; }, status() { return this; } }, (error) => { throw error; });
      return result;
    }
  };
}

test('expiry is persisted once, reads only probes, and restart does not repeat the offline event', () => {
  const h = harness({ status: 'online', lastSeenAt: new Date(Date.now() - 100000).toISOString(), alertBotIds: ['bot'] });
  scanOfflineProbes(h.deps);
  scanOfflineProbes({ ...h.deps });
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.events.map((item) => item.status), ['offline']);
  assert.deepEqual(h.events[0].alertBotIds, ['bot']);
  assert.equal(h.state().probes[0].status, 'offline');
  assert.ok(h.reads.every((keys) => keys.length === 1 && keys[0] === 'probes'));
});

test('pending, disabled and fresh probes do not trigger writes or offline notifications', () => {
  for (const probe of [{ status: 'pending' }, { status: 'online', enabled: false, lastSeenAt: '2000-01-01' }, { status: 'online', lastSeenAt: new Date().toISOString() }]) {
    const h = harness(probe);
    scanOfflineProbes(h.deps);
    assert.equal(h.writes(), 0);
    assert.equal(h.events.length, 0);
  }
});

test('heartbeats and reports recover a probe once and repeated heartbeats remain cheap', async () => {
  for (const route of ['/probe/heartbeat', '/probe/report']) {
    const h = harness({ status: 'offline', agentVersion: '1.4.0', alertBotIds: ['bot'] });
    await h.request('post', route, { version: '1.4.0', results: [] });
    await h.request('post', '/probe/heartbeat', { version: '1.4.0' });
    assert.deepEqual(h.events.map((item) => item.status), ['online']);
    assert.equal(h.events[0].previousStatus, 'offline');
    assert.equal(h.writes(), 1);
  }
});

test('heartbeat between scans records offline then recovery; initial registration records online', async () => {
  const h = harness({ status: 'online', lastSeenAt: new Date(Date.now() - 100000).toISOString() });
  await h.request('post', '/probe/heartbeat', { version: '1.4.0' });
  assert.deepEqual(h.events.map((item) => item.status), ['offline', 'online']);
  const initial = harness();
  await initial.request('post', '/probe/register', { probeId: 'p', token: 'register' });
  await initial.request('post', '/probe/register', { probeId: 'p', token: 'register' });
  assert.deepEqual(initial.events.map((item) => item.status), ['online']);
  assert.deepEqual(initial.events[0].alertBotIds, []);
});

test('notification recipients default to empty, can be selected or cleared, and survive legacy edits', async () => {
  const h = harness();
  const update = (body) => h.request('put', '/api/orchestration/:resource/:id', { name: '测试探针', ...body }, { resource: 'probes', id: 'p' });
  await update({});
  assert.deepEqual(h.state().probes[0].alertBotIds, []);
  await update({ alertBotIds: ['bot', 'bot'] });
  await update({});
  assert.deepEqual(h.state().probes[0].alertBotIds, ['bot']);
  await update({ alertBotIds: [] });
  assert.deepEqual(h.state().probes[0].alertBotIds, []);
  await assert.rejects(update({ alertBotIds: ['missing'] }), /机器人不存在/);
});

test('Telegram delivery is opt-in, deduplicates recipients, skips disabled bots and tolerates failures', async () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function notifyProbePresenceViaTelegram(');
  const end = source.indexOf('\nfunction notifyIncidentViaTelegram(', start);
  const calls = [];
  let reads = 0;
  const ctx = vm.createContext({ AbortSignal,
    readState() { reads++; return { telegramBots: [{ id: 'bot', enabled: true, tokenEnc: 'encrypted', userIds: ['one', 'one', 'two'] }, { id: 'disabled', enabled: false, tokenEnc: 'encrypted', userIds: ['wrong'] }] }; },
    decryptSecret: () => 'fake-token',
    async telegramCall(token, method, body, options) { calls.push({ method, body, options }); if (body.chat_id === 'one') throw Error('simulated timeout'); }
  });
  vm.runInContext(source.slice(start, end), ctx);
  ctx.notifyProbePresenceViaTelegram([{ status: 'online', alertBotIds: [] }]);
  assert.equal(reads, 0);
  ctx.notifyProbePresenceViaTelegram([{ name: '测试探针', status: 'offline', alertBotIds: ['bot', 'bot', 'disabled', 'missing'] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((item) => item.body.chat_id), ['one', 'two']);
  assert.match(calls[0].body.text, /探针离线/);
  assert.ok(calls[0].options.signal);
});
