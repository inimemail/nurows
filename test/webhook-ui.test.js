import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const compiled = transformSync(fs.readFileSync(new URL('../src/WebhookWorkspace.jsx', import.meta.url), 'utf8'), {
  loader: 'jsx', format: 'cjs', jsx: 'automatic'
}).code;
const fixture = () => ({ tasks: [{ id: 'one', name: '更换 IP', location: '面板本机', enabled: true, externalEnabled: true,
  allowGet: false, timeout: 30, note: '', botIds: ['bot'], version: 'v1', commandConfigured: true }],
  servers: [], bots: [], total: 1, matched: 1, active: 0, page: 1, pages: 1, settings: { concurrency: 8, queueLimit: 200 } });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(api, data = fixture()) {
  const slots = [], effects = [], cache = { current: { data } };
  let cursor = 0, tree, poll;
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Date, AbortController, structuredClone, setTimeout, clearTimeout,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    require(name) {
      if (name === 'react') return {
        useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
          return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
        useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
        useEffect(callback) { effects.push(callback); }
      };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'lucide-react') return new Proxy({}, { get: (_target, key) => String(key) });
      if (name.endsWith('polling.js')) return { startPolling(callback) { poll = callback; return () => {}; } };
      if (name.endsWith('note-clipboard.js')) return {};
      if (name.endsWith('RenewalWorkspace.jsx')) return { RenewalBotPicker: 'bot-picker' };
      if (name.endsWith('.css')) return {};
      throw Error(name);
    }
  });
  const render = () => { cursor = 0; effects.length = 0; tree = module.exports.default({ api, toast() {}, Dialog: 'dialog', cache }); return tree; };
  function nodes(value = tree) { return Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? []
    : [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.footer ?? null)]; }
  const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  render();
  return { render, nodes, cache, button: (label) => nodes().find((node) => node.type === 'button' && text(node) === label),
    startPoll: () => effects[3](), poll: () => poll(new AbortController().signal) };
}

test('Webhook cached list paints immediately without loading commands or tokens', () => {
  const view = harness(() => assert.fail('render must not request sensitive details'));
  assert.equal(view.nodes().filter((node) => node.props?.className === 'webhook-row').length, 1);
  assert.ok(view.button('新建任务'));
});

test('copy fetches only selected command and keeps bots while initially disabling the new task', async () => {
  const requests = [];
  const view = harness(async (url) => { requests.push(url); return { ...fixture().tasks[0], command: 'curl -4 example.test', serverId: '' }; });
  const duplicate = view.button('复制');
  duplicate.props.onClick({ currentTarget: { closest: () => ({ open: true }) } });
  await flush(); view.render();
  assert.deepEqual(requests, ['/api/webhooks/one']);
  assert.ok(view.nodes().some((node) => node.type === 'textarea' && node.props.value === 'curl -4 example.test'));
  const checks = view.nodes().filter((node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checks[0].props.checked, false);
  const picker = view.nodes().find((node) => node.type === 'bot-picker');
  assert.deepEqual(picker.props.value, ['bot']);
});

test('double submitting a Webhook editor sends one mutation and stays open until it finishes', async () => {
  let release;
  const requests = [];
  const view = harness((url, options) => { requests.push({ url, options }); return new Promise((resolve) => { release = resolve; }); });
  view.button('新建任务').props.onClick(); view.render();
  const submit = view.nodes().find((node) => node.type === 'form').props.onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} }); view.render();
  assert.equal(requests.length, 1);
  assert.ok(view.nodes().some((node) => node.type === 'form'));
  release({ id: 'new' }); await first; view.render();
  assert.equal(view.nodes().some((node) => node.type === 'form'), false);
});

test('late list polling cannot overwrite cached state after an execution mutation', async () => {
  let respond;
  const requests = [];
  const view = harness((url, options) => { requests.push(url); return options.method ? Promise.resolve({ accepted: true })
    : new Promise((resolve) => { respond = resolve; }); });
  view.startPoll(); const pending = view.poll();
  view.button('执行').props.onClick(); view.render();
  await view.button('确认').props.onClick();
  respond({ ...fixture(), tasks: [], total: 0 }); await pending; view.render();
  assert.equal(view.cache.current.data.total, 1);
  assert.equal(view.nodes().filter((node) => node.props?.className === 'webhook-row').length, 1);
  assert.equal(requests.filter((url) => url.endsWith('/run')).length, 1);
});
