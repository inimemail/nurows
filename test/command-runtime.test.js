import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import test from 'node:test';
import { hasExactPerServerInputs } from '../shared/command-input.js';
import { commandJobDelta, mergeCommandDelta, workspaceResultPreviews, COMMAND_HISTORY_LIMIT } from '../shared/command-output.js';

// Exercise the actual runtime functions without starting the HTTP server,
// connecting SSH, reading credentials, or launching background DNS tasks.
const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}
function harness(names, globals = {}, setup = '') {
  const context = vm.createContext(globals);
  vm.runInContext(`${setup}\n${names.map(functionSource).join('\n')}`, context);
  return context;
}

test('repeated authenticated input requests do not reload storage or migrate every password', () => {
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 3);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update('synthetic-secret'), cipher.final()]);
  const passwordEnc = { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
  const state = { servers: Array.from({ length: 50 }, (_, id) => ({ id, passwordEnc })), proxies: [] };
  let stateLoads = 0;
  let schemaChecks = 0;
  let decryptions = 0;
  const session = { username: 'test', encryptionKey: key.toString('hex') };
  const ctx = harness(['ensureStorage', 'migrateLegacyStorage', 'readAuth', 'getAppSecretKey', 'decryptSecret', 'authGuard', 'readState', 'migrateLegacySecrets'], {
    fs: { existsSync: () => true }, path: { dirname: (value) => value },
    DATA_DIR: 'unused', SQLITE_FILE: 'unused', SQLITE_KV_TABLE: 'kv',
    STORAGE_KEYS: { state: 'state', auth: 'auth', secret: 'secret' }, defaultState: {},
    normalizeStateRecord: (value) => value, normalizeAuthRecord: (value) => value, getDefaultAuthRecord: () => ({}),
    getSqliteDb: () => ({ pragma() {}, exec() { schemaChecks += 1; } }),
    dbGetRaw: () => key.toString('hex'),
    dbGetJson: (id) => { if (id === 'state') { stateLoads += 1; return structuredClone(state); } return { configured: true }; },
    structuredClone, Buffer,
    crypto: { ...crypto, createDecipheriv(...args) { decryptions += 1; return crypto.createDecipheriv(...args); } },
    isPublicAuthRoute: () => false, getSessionFromRequest: () => session
  }, 'let storageInitialized=false, cachedState=null, cachedAuth=null, cachedSecretHex="";');
  let accepted = 0;
  for (let i = 0; i < 20; i += 1) {
    ctx.authGuard({}, { status(code) { throw new Error(`Unexpected status ${code}`); } }, () => accepted++);
  }
  assert.equal(accepted, 20);
  assert.equal(stateLoads, 1);
  assert.equal(schemaChecks, 1);
  assert.equal(decryptions, 50, 'legacy migration happens only on the first request for this session');
});

test('storage initialization retries after a failed initial load', () => {
  let attempts = 0;
  const ctx = harness(['ensureStorage'], {
    fs: { existsSync: () => true }, path: { dirname: (x) => x }, DATA_DIR: '', SQLITE_FILE: '', SQLITE_KV_TABLE: 'kv',
    getSqliteDb: () => ({ pragma() {}, exec() {} }),
    migrateLegacyStorage() { if (++attempts === 1) throw new Error('temporary failure'); }
  }, 'let storageInitialized=false;');
  assert.throws(() => ctx.ensureStorage(), /temporary failure/);
  ctx.ensureStorage();
  ctx.ensureStorage();
  assert.equal(attempts, 2);
});

test('summary polling transfers only changed results and clients recover from an invalid cursor', () => {
  const job = { results: [
    { serverId: 'one', status: 'awaiting_input', stdout: 'x'.repeat(200000) },
    { serverId: 'two', status: 'running', stdout: 'ready' }
  ] };
  const initial = commandJobDelta(job, -1);
  assert.equal(initial.reset, true);
  assert.ok(JSON.stringify(initial).length < 6000);
  const client = mergeCommandDelta([], initial);
  const unchanged = commandJobDelta(job, initial.revision);
  assert.deepEqual(unchanged.results, []);
  assert.equal(mergeCommandDelta(client, unchanged), client);
  job.results[1].stdout += '\nnew output';
  const delta = commandJobDelta(job, initial.revision);
  assert.deepEqual(delta.results.map((item) => item.serverId), ['two']);
  const next = mergeCommandDelta(client, delta);
  assert.equal(next[0], client[0]);
  assert.equal(next[1].stdout, 'ready\nnew output');
  const reset = commandJobDelta(job, 999999);
  assert.equal(reset.reset, true);
  assert.equal(mergeCommandDelta([], reset).length, 2);
});

test('saved previews fit under the request limit for hundreds of servers with Unicode logs', () => {
  const results = Array.from({ length: 300 }, (_, index) => ({ serverId: String(index), stdout: '日\n'.repeat(20000), stderr: '错'.repeat(20000) }));
  const previews = workspaceResultPreviews(results);
  assert.equal(previews.length, 300);
  assert.ok(Buffer.byteLength(JSON.stringify({ executionResults: previews })) < 2 * 1024 * 1024);
  assert.equal(previews[0].outputTruncated, true);
});

function inputHarness() {
  const writes = [];
  const timers = new Map();
  let sequence = 0;
  const globals = {
    setTimeout(callback) { timers.set(++sequence, callback); return sequence; },
    clearTimeout(id) { timers.delete(id); },
    broadcastCommandSession() {}, refreshCommandJobStatus() {},
    SHELL_PROMPT_PATTERNS: [], COMMAND_PROMPT_PATTERNS: [],
    COMMAND_EXIT_MARKER: '__NUROSSH_EXIT__', COMMAND_HISTORY_LIMIT
  };
  const ctx = harness(['writeCommandSessionInput', 'scheduleAwaitingInputCheck', 'looksLikeInteractivePrompt',
    'appendCommandRuntimeOutput', 'extractCommandExitCode', 'stripCommandExitMarker', 'stripAnsi',
    'tryFinalizeCommandResult', 'finalizeCommandResult', 'getLastNonEmptyLine', 'looksLikeShellPromptLine'], globals);
  const item = { serverId: 'one', status: 'awaiting_input', awaitingInput: true, inputRequestCount: 1, stdout: '' };
  const runtime = { tailText: '请输入选项：', closed: false, shellStream: { write: (text) => writes.push(text) } };
  const job = { interactiveKeywords: [], results: [item] };
  return { ctx, item, runtime, job, writes, timers };
}

test('sending input consumes the old prompt and only fresh output can request input again', () => {
  const { ctx, item, runtime, job, writes, timers } = inputHarness();
  ctx.writeCommandSessionInput(job, runtime, item, 'yes\r');
  assert.deepEqual(writes, ['yes\r']);
  for (const callback of [...timers.values()]) callback();
  assert.equal(item.status, 'running');
  assert.equal(item.inputRequestCount, 1);
  ctx.appendCommandRuntimeOutput(job, runtime, item, '请输入下一选项：');
  for (const callback of [...timers.values()]) callback();
  assert.equal(item.status, 'awaiting_input');
  assert.equal(item.inputRequestCount, 2);
});

test('split exit markers still finish commands after the output history limit is reached', () => {
  const { ctx, item, runtime, job } = inputHarness();
  item.inputRequestCount = 0;
  ctx.appendCommandRuntimeOutput(job, runtime, item, 'x'.repeat(COMMAND_HISTORY_LIMIT + 100));
  assert.equal(item.stdout.length, COMMAND_HISTORY_LIMIT);
  assert.equal(item.outputTruncated, true);
  ctx.appendCommandRuntimeOutput(job, runtime, item, '\n__NUROSSH_EX');
  assert.notEqual(item.status, 'done');
  ctx.appendCommandRuntimeOutput(job, runtime, item, 'IT__:7\n');
  assert.equal(item.status, 'done');
  assert.equal(item.exitCode, 7);
  assert.equal(item.ok, false);
});

test('exit codes split between digits wait for the newline and finish only once', () => {
  const { ctx, item, runtime, job } = inputHarness();
  let finishes = 0;
  ctx.refreshCommandJobStatus = () => { finishes += 1; };
  ctx.appendCommandRuntimeOutput(job, runtime, item, '\n__NUROSSH_EXIT__:1');
  assert.notEqual(item.status, 'done');
  ctx.appendCommandRuntimeOutput(job, runtime, item, '0\r');
  assert.notEqual(item.status, 'done');
  ctx.appendCommandRuntimeOutput(job, runtime, item, '\n');
  assert.equal(item.exitCode, 10);
  ctx.appendCommandRuntimeOutput(job, runtime, item, 'trailing output');
  ctx.tryFinalizeCommandResult(job, runtime, item);
  assert.equal(item.exitCode, 10);
  assert.equal(finishes, 1);
});

test('automation per-server prompts remain waiting until input is sent', () => {
  const { ctx, item, runtime, job } = inputHarness();
  job.type = 'automation';
  job.automationResponders = [{ waitText: 'choose', inputMode: 'per-server' }];
  item.status = 'running';
  item.awaitingInput = false;
  ctx.appendCommandRuntimeOutput(job, runtime, item, 'choose:');
  assert.equal(item.status, 'awaiting_input');
  ctx.appendCommandRuntimeOutput(job, runtime, item, 'more prompt output');
  assert.equal(item.status, 'awaiting_input');
  ctx.writeCommandSessionInput(job, runtime, item, 'yes\r');
  assert.equal(item.status, 'running');
  assert.equal(runtime.awaitingAutomationResponder, null);
  ctx.appendCommandRuntimeOutput(job, runtime, item, '\n__NUROSSH_EXIT__:0\n');
  assert.equal(item.status, 'done');
  assert.equal(item.ok, true);
});

test('per-server input keeps exact server mapping and rejects invalid batches before any write', () => {
  const results = Array.from({ length: 50 }, (_, i) => ({ serverId: String(i), status: 'awaiting_input', awaitingInput: true }));
  const job = { results, sessions: new Map(results.map((item) => [item.serverId, { shellStream: {}, closed: false }])) };
  const writes = [];
  let handler;
  const ctx = vm.createContext({ app: { post: (_path, callback) => { handler = callback; } }, commandJobs: new Map([['job', job]]),
    hasExactPerServerInputs, writeCommandSessionInput: (_job, _runtime, result, data) => writes.push([result.serverId, data]) });
  vm.runInContext(functionSource('normalizeCommandInput'), ctx);
  const start = source.indexOf("app.post('/api/commands/jobs/:id/input'");
  vm.runInContext(source.slice(start, source.indexOf("app.post('/api/commands/jobs/:id/cancel'", start)), ctx);
  let status = 200;
  const res = { status(code) { status = code; return this; }, json() {} };
  const inputs = results.map((item, index) => ({ serverId: item.serverId, data: `line-${index}` })).reverse();
  handler({ params: { id: 'job' }, body: { inputs } }, res);
  assert.equal(writes.length, 50);
  assert.deepEqual(writes[0], ['49', 'line-49\r']);
  writes.length = 0;
  handler({ params: { id: 'job' }, body: { inputs: inputs.slice(1) } }, res);
  assert.equal(status, 400);
  assert.equal(writes.length, 0);
  status = 200;
  handler({ params: { id: 'job' }, body: { serverIds: ['0', '0', '1'], data: '' } }, res);
  assert.equal(status, 200);
  assert.deepEqual(writes, [['0', '\r'], ['1', '\r']]);
});

// Run the actual polling effect with a controlled network and timer queue.
// This covers lifecycle races without a browser, server, or SSH connection.
function pollingHarness() {
  const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const end = appSource.indexOf('  }, [commandJobId, commandJobStatus]);');
  const start = appSource.lastIndexOf('  useEffect(() => {', end);
  const requests = [];
  const timers = new Map();
  let sequence = 0;
  let cleanup;
  let results = [];
  let status = 'running';
  const epoch = { current: 0 };
  const sending = { current: false };
  const context = vm.createContext({
    useEffect(callback) { cleanup = callback(); }, commandJobId: 'job', commandJobStatus: 'running',
    commandInputEpochRef: epoch, batchInputSendingRef: sending, AbortController, AbortSignal,
    window: { setTimeout(callback, delay) { timers.set(++sequence, { callback, delay }); return sequence; }, clearTimeout(id) { timers.delete(id); } },
    api(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); },
    mergeCommandDelta, setExecutionResults(update) { results = update(results); },
    setLastExecutedCommand() {}, setCommandInteractiveKeywords() {}, setBusy() {}, setAuth() {}, toast() {},
    setCommandJobStatus(value) { status = value; }
  });
  vm.runInContext(appSource.slice(start, end) + '  }, [commandJobId, commandJobStatus]);', context);
  return { requests, timers, epoch, sending, get results() { return results; }, get status() { return status; }, cleanup: () => cleanup(),
    async settle() { await new Promise(setImmediate); },
    runNext() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      void timer.callback();
      return timer.delay;
    }
  };
}

test('polling never overlaps requests, retries transient failures, and stops at completion', async () => {
  const poll = pollingHarness();
  assert.equal(poll.requests.length, 1);
  assert.equal(poll.timers.size, 0, 'no new poll is scheduled while a request is pending');
  poll.requests[0].reject(new Error('temporary gateway error'));
  await poll.settle();
  assert.equal(poll.runNext(), 1400);
  poll.requests[1].resolve({ status: 'running', reset: true, revision: 1, results: [{ serverId: 'one' }] });
  await poll.settle();
  assert.equal(poll.runNext(), 700);
  assert.match(poll.requests[2].url, /since=1$/);
  poll.requests[2].resolve({ status: 'done', reset: false, revision: 2, results: [{ serverId: 'one', status: 'done' }] });
  await poll.settle();
  assert.equal(poll.status, 'done');
  assert.equal(poll.results[0].status, 'done');
  assert.equal(poll.timers.size, 0);
  poll.cleanup();
});

test('polling ignores stale responses across input submission without advancing its cursor', async () => {
  const poll = pollingHarness();
  poll.epoch.current += 2; // The input request started and completed during this poll.
  poll.requests[0].resolve({ status: 'running', reset: true, revision: 5, results: [{ serverId: 'one', status: 'awaiting_input' }] });
  await poll.settle();
  assert.equal(poll.results.length, 0);
  poll.runNext();
  assert.match(poll.requests[1].url, /since=-1$/);
  poll.requests[1].resolve({ status: 'running', reset: true, revision: 6, results: [{ serverId: 'one', status: 'running' }] });
  await poll.settle();
  assert.equal(poll.results[0].status, 'running');
  poll.cleanup();
  assert.equal(poll.timers.size, 0);
});

test('poll cleanup aborts its request and an expired job does not retry indefinitely', async () => {
  const abandoned = pollingHarness();
  abandoned.cleanup();
  assert.equal(abandoned.requests[0].options.signal.aborted, true);
  abandoned.requests[0].resolve({ status: 'done', reset: true, revision: 1, results: [{ serverId: 'stale' }] });
  await abandoned.settle();
  assert.equal(abandoned.results.length, 0);
  assert.equal(abandoned.timers.size, 0);
  const expired = pollingHarness();
  expired.requests[0].reject(Object.assign(new Error('expired'), { status: 404 }));
  await expired.settle();
  assert.equal(expired.status, 'done');
  assert.equal(expired.timers.size, 0);
  expired.cleanup();
});
