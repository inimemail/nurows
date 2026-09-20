import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Exercise the actual component handlers with deterministic hooks and deferred
// HTTP responses. No server, production data, DOM, or user command is started.
const compiled = transformSync(fs.readFileSync(new URL('../src/DynamicGuardWorkspace.jsx', import.meta.url), 'utf8'), {
  loader: 'jsx', format: 'cjs', jsx: 'automatic'
}).code;
const fixture = () => ({ guards: [{ id: 'one', name: '测试 VPS', domain: 'test.example.com', recordType: 'A', currentIp: '192.0.2.1', enabled: true,
  commandConfigured: true, probeIds: ['p1'], botIds: [], status: 'waiting_ip', message: '等待新 IP', flow: { id: 'run', deadlineAt: Date.now() + 60000 },
  todayCount: 1, maxDaily: 5, checkType: 'ping', port: 443, interval: 30, checkRounds: 3, attemptsPerRound: 3, timeout: 5,
  waitTimeout: 120, queryInterval: 5, commandTimeout: 90, cooldown: 0 }],
  probes: [{ id: 'p1', name: '测试探针', enabled: true, status: 'online', lastSeenAt: new Date().toISOString() }], bots: [] });
function harness(api, data = fixture()) {
  const slots = [], effects = [];
  let cursor = 0, tree, poll;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = index === 0 ? data : typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useEffect(callback) { effects.push(callback); }
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Date, AbortSignal, structuredClone, setInterval, clearInterval,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name.endsWith('polling.js')) return { startPolling(callback) { poll = callback; return () => {}; } };
      if (name.endsWith('.css')) return {};
      if (name.endsWith('HistoryRecords.jsx')) return () => null;
      throw Error(`Unexpected import ${name}`);
    } });
  const render = () => { cursor = 0; effects.length = 0; tree = module.exports.default({ api, toast() {}, Dialog: 'dialog', onOpenHistory() {} }); return tree; };
  render();
  function nodes(value = tree) {
    if (Array.isArray(value)) return value.flatMap((item) => nodes(item));
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.footer ?? null)];
  }
  const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node) === label);
  return { render, nodes, button, data: () => slots[0], startPoll: () => { effects[1](); }, poll: () => poll(new AbortController().signal) };
}

test('waiting task remains editable, cannot manually duplicate a pending change, and saving keeps the encrypted command', async () => {
  const calls = [];
  const view = harness(async (url, options) => { calls.push({ url, options }); return { ok: true }; });
  assert.equal(view.button('手动换 IP').props.disabled, true);
  assert.equal(view.button('编辑').props.disabled, false);
  view.button('编辑').props.onClick(); view.render();
  const command = view.nodes().find((node) => node.type === 'textarea');
  assert.equal(command.props.required, false);
  assert.equal(command.props.value, '');
  const form = view.nodes().find((node) => node.type === 'form');
  await form.props.onSubmit({ preventDefault() {} }); view.render();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.command, '');
  assert.equal(body.domain, 'test.example.com');
  assert.equal(Object.hasOwn(body, 'flow'), false);
  assert.equal(Object.hasOwn(body, 'commandEnc'), false);
  assert.equal(calls[0].options.method, 'PUT');
});

test('a late polling response cannot restore stale data after a task mutation', async () => {
  let respond;
  const view = harness((url, options) => !options.method
    ? new Promise((resolve) => { respond = resolve; }) : Promise.resolve({ ok: true }));
  view.startPoll();
  const pending = view.poll();
  view.button('停用').props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  respond({ ...fixture(), guards: [], serverTime: Date.now() }); await pending;
  assert.equal(view.data().guards.length, 1);
});

test('manual IP change requires confirmation before sending a background request', async () => {
  const data = fixture(); data.guards[0].flow = null; data.guards[0].status = 'healthy';
  const calls = [];
  const view = harness(async (url, options) => { calls.push({ url, options }); return { ok: true }; }, data);
  view.button('手动换 IP').props.onClick(); view.render();
  assert.equal(calls.length, 0);
  view.button('确认').props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/dynamic-guards/one/change');
  assert.equal(JSON.parse(calls[0].options.body).confirm, 'change-ip');
});

test('rapid repeated actions send one request and toggle only the enabled flag', async () => {
  let release;
  const calls = [];
  const view = harness((url, options) => { calls.push({ url, options }); return new Promise((resolve) => { release = resolve; }); });
  const click = view.button('停用').props.onClick;
  click(); click(); click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/dynamic-guards/one/enabled');
  assert.deepEqual(JSON.parse(calls[0].options.body), { enabled: false });
  release({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
});

test('rapid repeated form submissions save once', async () => {
  let release;
  const calls = [];
  const view = harness((url, options) => { calls.push({ url, options }); return new Promise((resolve) => { release = resolve; }); });
  view.button('编辑').props.onClick(); view.render();
  const submit = view.nodes().find((node) => node.type === 'form').props.onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  release({ ok: true }); await first;
});
