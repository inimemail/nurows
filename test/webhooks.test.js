import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebhookService, registerWebhookRoutes } from '../server/webhooks.js';
import { createWebhookStore } from '../server/webhook-store.js';
import { runLocalWebhook, createOutputBuffer, IPV4_SHELL, shellQuote } from '../server/webhook-runtime.js';
import { normalizeDynamicGuard, DYNAMIC_DEFAULTS, createDynamicGuardService, acceptDynamicReports, registerDynamicGuardRoutes } from '../server/dynamic-guard.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn) {
  const deadline = Date.now() + 3000;
  while (!fn()) { if (Date.now() > deadline) assert.fail('等待执行结果超时'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function setup(t, overrides = {}) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const calls = [], notifications = [], guards = [];
  const deps = { db, encrypt: (text) => Buffer.from(text).toString('base64'), decrypt: (text) => Buffer.from(text, 'base64').toString(),
    servers: () => [{ id: 's1', name: '测试服务器', host: '192.0.2.1' }], bots: () => [{ id: 'b1', name: 'Bot', enabled: true, tokenEnc: 'x' }], guards: () => guards,
    execute: async (config) => { calls.push(config); return { ok: true, status: 'success', output: 'done' }; }, notify: (task, run) => notifications.push({ task, run }),
    ...overrides };
  const service = createWebhookService(deps);
  const save = (input = {}) => service.save({ name: '任务', command: 'echo test', ...input });
  return { db, deps, service, save, calls, notifications, guards };
}

test('task validation, stable encrypted credentials, safe summaries and fresh duplicate credentials', (t) => {
  const env = setup(t), task = env.save();
  const token = env.service.token(task.id);
  assert.equal(token.length, 43);
  assert.equal(task.timeout, 30); assert.deepEqual(task.botIds, []);
  assert.equal(JSON.stringify(env.service.snapshot()).includes(token), false);
  assert.equal(JSON.stringify(env.service.snapshot()).includes('echo test'), false);
  assert.notEqual(env.service.store.task(task.id).commandEnc, 'echo test');
  const edited = env.service.save({ ...task, name: '重命名', command: '' }, task.id);
  assert.equal(env.service.token(task.id), token);
  assert.throws(() => env.service.save({ ...task, name: '覆盖' }, task.id), /已被修改/);
  assert.throws(() => env.save({ name: ' 重命名 ' }), /已存在/);
  const copied = env.save({ ...edited, name: '副本', command: 'echo test', enabled: false });
  assert.notEqual(env.service.token(copied.id), token);
  for (const input of [{ name: ' ' }, { timeout: 4 }, { timeout: 3601 }, { command: 'a\0b' }, { serverId: 'missing' }, { botIds: ['missing'] }, { enabled: 'yes' }]) assert.throws(() => env.save({ name: '新任务', ...input }));
});

test('same-task lock and persisted request keys suppress concurrent and completed retries', async (t) => {
  let resolve;
  const env = setup(t, { execute: () => new Promise((done) => { resolve = done; }) }), task = env.save();
  const first = env.service.trigger(task.id, 'webhook', 'operation1'); await flush();
  const duplicate = env.service.trigger(task.id, 'webhook', 'operation2');
  assert.equal(duplicate.run.id, first.run.id); assert.equal(duplicate.duplicate, true);
  assert.equal(env.service.store.history('calls', task.id).total, 2);
  resolve({ ok: true, status: 'success', output: 'complete' });
  await waitFor(() => env.service.store.run(first.run.id).status === 'success');
  assert.equal(env.service.trigger(task.id, 'webhook', 'operation1').run.id, first.run.id);
  assert.equal(env.service.trigger(task.id, 'webhook', 'operation2').run.id, first.run.id);
  assert.equal(env.service.status(task.id).status, 'success');
  assert.equal(env.service.output(first.run.id).output, 'complete');
  assert.equal(env.notifications.length, 1);
});

test('a streamed-output persistence error is contained and final execution can still complete', async (t) => {
  const errors = [];
  const env = setup(t, { logError: (error) => errors.push(error), execute: async (_config, _signal, onOutput) => {
    onOutput('partial'); onOutput('later'); return { ok: true, status: 'success', output: 'complete' };
  } });
  let writes = 0;
  env.service.store.writeOutput = () => { writes++; throw Error('temporary output write failure'); };
  const run = env.service.trigger(env.save().id);
  await waitFor(() => env.service.store.run(run.run.id).status === 'success');
  assert.equal(writes, 1); assert.equal(errors.length, 1);
  assert.equal(env.service.output(run.run.id).output, 'complete');
});

test('an incomplete executor result cannot leave a run stuck', async (t) => {
  const env = setup(t, { execute: async () => undefined });
  const run = env.service.trigger(env.save().id);
  await waitFor(() => env.service.store.run(run.run.id).status === 'uncertain');
  assert.equal(env.service.store.run(run.run.id).message, '执行器未返回结果');
});

test('bounded concurrency, immutable command snapshots, queue saturation and queued cancellation', async (t) => {
  const running = [];
  const env = setup(t, { execute: (config) => new Promise((resolve) => running.push({ config, resolve })) });
  env.service.settings({ concurrency: 1, queueLimit: 10 });
  const task = env.save(), nextTask = env.save({ name: '第二个', command: 'old' });
  env.service.trigger(task.id); const second = env.service.trigger(nextTask.id); await flush();
  assert.equal(running.length, 1);
  env.service.save({ ...nextTask, command: 'new' }, nextTask.id);
  for (let i = 0; i < 9; i++) env.service.trigger(env.save({ name: `队列${i}` }).id);
  assert.throws(() => env.service.trigger(env.save({ name: '满了' }).id), /队列已满/);
  running[0].resolve({ ok: true, status: 'success' }); await flush();
  assert.equal(running.length, 2);
  assert.equal(env.deps.decrypt(running[1].config.commandEnc), 'old');
  assert.equal(env.service.store.run(second.run.id).status, 'running');
  for (const run of env.service.store.actives()) if (run.status === 'queued') env.service.cancel(run.id);
  running[1].resolve({ ok: true, status: 'success' }); await flush();
  assert.equal(env.service.store.actives().length, 0);
});

test('Token reset, external switches and cross-task status isolation', (t) => {
  const { service, save } = setup(t), task = save(), other = save({ name: '其他任务' });
  const token = service.token(task.id);
  assert.equal(service.authenticate(task.id, token).id, task.id);
  assert.throws(() => service.authenticate(task.id, 'wrong'), /凭证无效/);
  assert.throws(() => service.authenticate(task.id, token, true), /GET/);
  const newToken = service.token(task.id, true);
  assert.notEqual(token, newToken);
  assert.throws(() => service.authenticate(task.id, token), /凭证无效/);
  const run = { id: 'r1', taskId: other.id, status: 'success', created: Date.now(), snapshot: { secret: 'x' } };
  service.store.saveRun(run);
  assert.throws(() => service.status(task.id, run.id), /不存在/);
  assert.equal(service.output(run.id).snapshot, undefined);
  service.save({ ...service.detail(task.id), externalEnabled: false }, task.id);
  assert.throws(() => service.authenticate(task.id, newToken), /已关闭/);
});

test('malformed persisted token hashes fail authentication cleanly', (t) => {
  const { service, save } = setup(t);
  const task = save();
  const stored = service.store.task(task.id);
  stored.tokenHash = 'broken';
  service.store.saveTask(stored);
  assert.throws(() => service.authenticate(task.id, 'anything'), /凭证无效/);
});

test('restart never replays orphan commands and preserves idempotency keys', (t) => {
  const env = setup(t), task = env.save();
  const run = { id: 'interrupted', taskId: task.id, taskName: task.name, created: Date.now(), status: 'running', snapshot: env.service.store.task(task.id) };
  env.service.store.saveRun(run); env.service.store.call(task.id, run.id, 'persisted', 'webhook', false);
  const restored = createWebhookService(env.deps);
  assert.equal(restored.store.run(run.id).status, 'uncertain');
  assert.equal(restored.store.run(run.id).snapshot, undefined);
  assert.equal(restored.trigger(task.id, 'webhook', 'persisted').run.id, run.id);
  assert.equal(env.calls.length, 0);
});

test('retention and manual cleanup protect active runs and their call keys', (t) => {
  const env = setup(t), task = env.save(), old = Date.now() - 8 * 86400000;
  for (const [id, status] of [['done', 'success'], ['active', 'waiting_guard']]) {
    env.service.store.saveRun({ id, taskId: task.id, status, created: old });
    env.service.store.call(task.id, id, id, 'webhook', false);
    env.db.prepare('UPDATE webhook_calls SET created=? WHERE run_id=?').run(old, id);
  }
  env.service.store.prune();
  assert.equal(env.service.store.run('done'), null); assert.ok(env.service.store.run('active'));
  assert.equal(env.service.store.priorRequest(task.id, 'done'), undefined);
  assert.equal(env.service.store.priorRequest(task.id, 'active'), 'active');
  env.service.clear(task.id);
  assert.ok(env.service.store.run('active')); assert.equal(env.service.store.history('calls', task.id).total, 1);
});

test('output is byte-bounded and redacts secrets even across chunks', async () => {
  const buffer = createOutputBuffer(['my-secret']); buffer.append('hello my-'); buffer.append('secret');
  assert.equal(buffer.value().includes('my-secret'), false);
  buffer.append('长'.repeat(100000)); assert.ok(Buffer.byteLength(buffer.value()) <= 65536 + 100); assert.match(buffer.value(), /截断/);
  const result = await runLocalWebhook('printf "%s" "$NUROSSH_WEBHOOK_TEST_SECRET"; printf my-secret', 2, { secrets: ['my-secret'] });
  assert.equal(result.status, 'success'); assert.equal(result.output, '[已隐藏]');
});

test('local exits, process-group deadlines and explicit cancellation settle correctly', async () => {
  assert.equal((await runLocalWebhook('exit 7', 2)).exitCode, 7);
  const timed = await runLocalWebhook('sleep 5', .05);
  assert.equal(timed.status, 'timeout'); assert.equal(timed.uncertain, true);
  const controller = new AbortController(); const promise = runLocalWebhook('sleep 5', 2, { signal: controller.signal }); controller.abort();
  const canceled = await promise; assert.equal(canceled.status, 'cancelled');
});

test('curl defaults to IPv4 while preserving explicit IPv6 and literal arguments', async () => {
  const command = `curl --help >/dev/null; declare -f curl`;
  const result = await runLocalWebhook(command, 2);
  assert.equal(result.ok, true); assert.match(result.output, /command curl -4/);
  assert.match(IPV4_SHELL, /-4\|-6\|--ipv4\|--ipv6/);
  const value = "literal ' $(do-not-execute)";
  assert.equal((await runLocalWebhook(`printf %s ${shellQuote(value)}`, 2)).output, value);
});

test('public API returns immediate acceptance, ignores command injection and hides full output', async (t) => {
  const env = setup(t), task = env.save(), handlers = new Map();
  registerWebhookRoutes(Object.fromEntries(['get', 'post'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)])), env.service, { publicOnly: true });
  const request = { params: { id: task.id }, headers: { authorization: `Bearer ${env.service.token(task.id)}` }, query: {}, method: 'POST', body: { command: 'bad-command' } };
  let body, status;
  const res = { set() { return this; }, status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  await handlers.get('post /hooks/:id/run')(request, res, (err) => { throw err; });
  assert.equal(status, 202); assert.ok(body.executionId); await flush();
  assert.equal(env.deps.decrypt(env.calls[0].commandEnc), 'echo test');
  request.method = 'GET'; request.query.executionId = body.executionId;
  await handlers.get('get /hooks/:id/status')(request, res, (err) => { throw err; });
  assert.equal(body.status, 'success'); assert.equal(body.output, undefined); assert.equal(body.message, undefined); assert.equal(body.snapshot, undefined);
});

test('paused/deleted tasks and bound guards cannot accidentally trigger unrelated execution', async (t) => {
  const env = setup(t), task = env.save({ enabled: false });
  assert.throws(() => env.service.trigger(task.id), /停用/);
  env.service.remove(task.id); assert.throws(() => env.service.authenticate(task.id, 'token'), /无效/);
  const bound = env.save({ name: '关联' }); env.guards.push({ id: 'g1', webhookTaskId: bound.id, enabled: false });
  assert.throws(() => env.service.trigger(bound.id), /守护已停用/);
  assert.throws(() => env.service.remove(bound.id), /解除关联/);
});

test('guard association validation rejects missing/duplicate tasks and keeps inline mode', () => {
  const state = { probes: [{ id: 'p', enabled: true }], dynamicGuards: [], webhookTasks: [{ id: 'w', enabled: true }] };
  const input = { ...DYNAMIC_DEFAULTS, domain: 'vps.example.com', probeIds: ['p'], webhookTaskId: 'w' };
  const guard = normalizeDynamicGuard(input, null, state, (v) => v);
  assert.equal(guard.commandEnc, null); state.dynamicGuards.push(guard);
  assert.throws(() => normalizeDynamicGuard({ ...input, domain: 'other.example.com' }, null, state, (v) => v), /其他动态守护/);
  assert.throws(() => normalizeDynamicGuard({ ...input, webhookTaskId: 'missing' }, guard, state, (v) => v), /已启用/);
  assert.throws(() => normalizeDynamicGuard({ ...input, webhookTaskId: '' }, guard, state, (v) => v), /API 命令/);
});

test('bound external calls use guard pipeline, hold lock through IP verification and avoid duplicate notifications', async (t) => {
  let time = Date.now(), address = '192.0.2.1', commandCalls = 0, dynamic;
  const state = { dynamicGuards: [], dynamicGuardRuns: [], probes: [{ id: 'p', enabled: true, status: 'online', lastSeenAt: new Date(time).toISOString() }], telegramBots: [] };
  const env = setup(t, { guards: () => state.dynamicGuards, requestGuard: (id) => dynamic.request(id, true), execute: async () => { commandCalls++; return { ok: true, status: 'success', uncertain: false, output: 'submitted' }; } });
  const task = env.save(); state.webhookTasks = env.service.choices();
  state.dynamicGuards.push(normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain: 'vps.example.com', probeIds: ['p'], webhookTaskId: task.id }, null, state, env.deps.encrypt, time));
  const guard = () => state.dynamicGuards[0];
  dynamic = createDynamicGuardService({ readState: (keys) => Object.fromEntries(keys.map((key) => [key, state[key]])), updateState: (mutate) => mutate(state),
    readDynamicGuard: (id) => structuredClone(state.dynamicGuards.find((item) => item.id === id)), decryptSecret: env.deps.decrypt,
    executeWebhook: (id, item) => env.service.executeForGuard(id, item), webhookTimeout: () => 30 }, { now: () => time, resolveIp: async () => address });
  const first = env.service.trigger(task.id, 'webhook', 'change1'); await dynamic.drain();
  assert.equal(commandCalls, 1); assert.equal(guard().status, 'waiting_ip');
  assert.equal(env.service.store.run(first.run.id).status, 'waiting_guard');
  const duplicate = env.service.trigger(task.id); assert.equal(duplicate.run.id, first.run.id); assert.equal(commandCalls, 1);
  address = '192.0.2.2'; time += 6000; state.probes[0].lastSeenAt = new Date(time).toISOString();
  dynamic.tick(); await dynamic.drain();
  assert.equal(guard().status, 'verifying');
  acceptDynamicReports(state, 'p', [{ targetId: guard().cycle.id, checkMarker: guard().cycle.id, ok: true, attempts: 1 }], time);
  dynamic.tick(); await dynamic.drain(); env.service.tick();
  assert.equal(env.service.store.run(first.run.id).status, 'success'); assert.equal(env.service.store.actives().length, 0);
  assert.equal(env.notifications.length, 0);
});

test('schema upgrade is additive and includes webhook tables in SQLite backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nurows-webhooks-backup-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = setup(t); env.db.exec("CREATE TABLE old_data (value TEXT); INSERT INTO old_data VALUES('keep')");
  const task = env.save(); const run = env.service.trigger(task.id, 'panel', 'backup-key'); await flush(); createWebhookStore(env.db);
  assert.equal(env.db.prepare('SELECT value FROM old_data').get().value, 'keep');
  assert.equal(env.service.store.task(task.id).name, task.name);
  assert.ok(env.db.prepare("SELECT name FROM sqlite_master WHERE name='webhook_runs'").get());
  await env.db.backup(join(directory, 'app.db'));
  const restored = new Database(join(directory, 'app.db')); t.after(() => restored.close());
  const store = createWebhookStore(restored);
  assert.equal(store.task(task.id).name, task.name); assert.equal(store.run(run.run.id).status, 'success');
  assert.equal(store.priorRequest(task.id, 'backup-key'), run.run.id); assert.equal(store.output(run.run.id), 'done');
  assert.equal(restored.prepare('SELECT value FROM old_data').get().value, 'keep');
});

test('bounded retention cannot leave idempotency keys pointing at deleted runs', (t) => {
  const env = setup(t), task = env.save(), old = Date.now() - 8 * 86400000;
  env.service.store.saveRun({ id: 'old', taskId: task.id, status: 'success', created: old });
  for (let i = 0; i < 700; i++) env.service.store.call(task.id, 'old', `key-${i}`, 'webhook', true);
  env.db.prepare('UPDATE webhook_calls SET created=?').run(old);
  env.service.store.prune();
  assert.ok(env.service.store.run('old')); assert.equal(env.service.store.history('calls', task.id).total, 200);
  env.service.store.prune(); assert.equal(env.service.store.run('old'), null);
  assert.equal(env.service.store.priorRequest(task.id, 'key-699'), undefined);
});

test('guard retries use newly saved configuration while retaining the same workflow lock', async (t) => {
  const env = setup(t), task = env.save();
  const guard = { id: 'guard', webhookTaskId: task.id, flow: { id: 'flow' }, status: 'waiting_ip' }; env.guards.push(guard);
  const promise = env.service.executeForGuard(task.id, guard);
  assert.equal(env.service.executeForGuard(task.id, guard), promise); await promise;
  const runId = env.service.store.active(task.id).id;
  env.service.tick(); // Reconciliation also keeps the lock without loading encrypted command snapshots.
  env.service.save({ ...task, command: 'echo updated' }, task.id);
  await env.service.executeForGuard(task.id, guard);
  assert.equal(env.service.store.active(task.id).id, runId);
  assert.equal(env.deps.decrypt(env.calls[1].commandEnc), 'echo updated');
  assert.equal(env.service.store.active(task.id).attempts, 2);
});

test('credential scrubbing cannot cascade or build an unbounded replacement workload', () => {
  const buffer = createOutputBuffer(['[', 'hidden-secret', 'hidden', '[']); buffer.append(Buffer.from('hidden-secret ['));
  assert.equal(buffer.value(), '[已隐藏] [已隐藏]');
  const crowded = createOutputBuffer(Array.from({ length: 1000 }, (_, i) => `credential-${i}`)); crowded.append(Buffer.from('credential-999'));
  assert.equal(crowded.value(), '[输出包含过多凭证，已隐藏]');
});

test('disabled webhook waits without spending guard quota and resumes after enabling', async (t) => {
  let time = Date.now(), dynamic;
  const state = { dynamicGuards: [], dynamicGuardRuns: [], probes: [{ id: 'p', enabled: true, status: 'online', lastSeenAt: new Date(time).toISOString() }], telegramBots: [] };
  const env = setup(t, { guards: () => state.dynamicGuards, requestGuard: (id) => dynamic.request(id, true) });
  const task = env.save(); state.webhookTasks = env.service.choices();
  state.dynamicGuards.push(normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain: 'vps.example.com', probeIds: ['p'], webhookTaskId: task.id }, null, state, env.deps.encrypt, time));
  env.service.save({ ...task, enabled: false, command: '' }, task.id);
  dynamic = createDynamicGuardService({ readState: (keys) => Object.fromEntries(keys.map((key) => [key, state[key]])), updateState: (mutate) => mutate(state),
    readDynamicGuard: () => structuredClone(state.dynamicGuards[0]), decryptSecret: env.deps.decrypt,
    executeWebhook: (id, guard) => env.service.executeForGuard(id, guard), webhookTimeout: () => 30,
    webhookEnabled: (id) => env.service.store.task(id).enabled }, { now: () => time, resolveIp: async () => '192.0.2.1' });
  dynamic.request(state.dynamicGuards[0].id, true); await dynamic.drain();
  assert.equal(env.calls.length, 0); assert.equal(state.dynamicGuards[0].flow, null); assert.equal(state.dynamicGuardRuns.length, 0);
  assert.equal(state.dynamicGuards[0].manualRequested, true); assert.match(state.dynamicGuards[0].message, /已停用/);
  const saved = env.service.detail(task.id); env.service.save({ ...saved, enabled: true }, task.id);
  time += 31000; state.probes[0].lastSeenAt = new Date(time).toISOString(); dynamic.tick(); await dynamic.drain();
  assert.equal(env.calls.length, 1); assert.equal(state.dynamicGuards[0].daily.count, 1); assert.equal(state.dynamicGuards[0].status, 'waiting_ip');
});

test('legacy inline guard can still be edited while waiting for its new IP', async () => {
  const state = { probes: [{ id: 'p', enabled: true }], telegramBots: [], dynamicGuards: [], dynamicGuardRuns: [] };
  const guard = normalizeDynamicGuard({ ...DYNAMIC_DEFAULTS, domain: 'vps.example.com', probeIds: ['p'], command: 'curl test' }, null, state, (v) => v);
  delete guard.webhookTaskId; guard.flow = { id: 'flow', commandState: 'submitted', submittedAt: Date.now() }; guard.status = 'waiting_ip'; state.dynamicGuards.push(guard);
  const handlers = new Map(); registerDynamicGuardRoutes(Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)])),
    { readState: () => structuredClone(state), updateState: (mutate) => mutate(state), encryptSecret: (v) => v, webhookTasks: () => [] }, { isExecuting: () => false, tick() {} });
  let result;
  await handlers.get('put /api/dynamic-guards/:id')({ params: { id: guard.id }, body: { ...guard, name: '编辑成功', command: '' } }, { json: (value) => { result = value; } }, (error) => { throw error; });
  assert.equal(result.guard.name, '编辑成功'); assert.equal(result.guard.flow.id, 'flow');
});
