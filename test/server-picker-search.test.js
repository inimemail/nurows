import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { filterPickerServers } from '../shared/server-picker-search.js';

const servers = [
  { id: 'a', name: 'London A', host: '23.134.76.169', groupId: 'uk', username: 'admin', note: 'primary' },
  { id: 'b', name: '英国二号', host: '23.134.76.170', groupId: 'uk' },
  { id: 'c', name: 'Tokyo', host: '2001:db8::3', groupId: 'jp' },
  { id: 'd', name: '备用节点', host: 'backup.example.com', groupId: 'jp' }
];
const ids = (items) => Array.from(items, (item) => item.id);

test('space-separated IPs are alternatives, not one literal or an AND query', () => {
  assert.deepEqual(ids(filterPickerServers(servers, '23.134.76.169 23.134.76.170')), ['a', 'b']);
  assert.deepEqual(ids(filterPickerServers(servers, '23.134.76.170 missing 23.134.76.169')), ['a', 'b']);
});

test('mixed names, partial IPs, IPv6 and domain hosts match case-insensitively', () => {
  assert.deepEqual(ids(filterPickerServers(servers, 'lOnDoN 英国 2001:DB8::3 BACKUP.EXAMPLE.COM')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(filterPickerServers(servers, '23.134.76.17')), ['b']);
  assert.deepEqual(ids(filterPickerServers(servers, 'admin primary')), ['a']);
  assert.deepEqual(ids(filterPickerServers(servers, 'absent')), []);
});

test('repeated whitespace, tabs, newlines, full-width spaces and duplicate terms work', () => {
  assert.deepEqual(ids(filterPickerServers(servers, '  London\tLondon\n英国\r\n\u3000Tokyo  ')), ['a', 'b', 'c']);
  for (const query of ['', '  \t\n\u3000', null, undefined]) {
    assert.deepEqual(ids(filterPickerServers(servers, query)), ['a', 'b', 'c', 'd']);
  }
  assert.deepEqual(filterPickerServers(), []);
});

test('group filtering still constrains every term and an empty query', () => {
  assert.deepEqual(ids(filterPickerServers(servers, '23.134.76.169 Tokyo', 'uk')), ['a']);
  assert.deepEqual(ids(filterPickerServers(servers, '23.134.76.169 Tokyo', 'jp')), ['c']);
  assert.deepEqual(ids(filterPickerServers(servers, ' ', 'uk')), ['a', 'b']);
  assert.deepEqual(ids(filterPickerServers(servers, '', 'missing')), []);
});

test('search preserves source order/references, has no duplicates, and never reads secrets', () => {
  const input = servers.map((server) => ({ ...server, get password() { throw new Error('secret read'); } }));
  const result = filterPickerServers(input, 'Tokyo London London primary');
  assert.deepEqual(ids(result), ['a', 'c']);
  assert.equal(result[0], input[0]);
  assert.equal(result[1], input[2]);
  assert.deepEqual(ids(input), ['a', 'b', 'c', 'd']);
  assert.doesNotThrow(() => filterPickerServers([{ id: 'empty' }], 'unknown'));
});

const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function between(start, end) {
  const first = app.indexOf(start), last = app.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing App section: ${start}`);
  return app.slice(first, last);
}

for (const mode of ['command', 'proxy']) test(`${mode} picker uses multi-search and current selection actions respect its results`, () => {
  const context = vm.createContext({ state: { servers }, pickerSearch: '', pickerGroupId: 'all', pickerSelectedIds: [],
    selectedServerIds: ['d'], filterPickerServers, useMemo: (fn) => fn(), requireSelectedItem: () => true });
  for (const field of ['serverPickerMode', 'pickerSearch', 'pickerGroupId', 'pickerSelectedIds', 'serverPickerOpen']) {
    context[`set${field[0].toUpperCase()}${field.slice(1)}`] = (value) => {
      context[field] = typeof value === 'function' ? value(context[field]) : value;
    };
  }
  vm.runInContext(between('  function openServerPicker()', '  function toggleGroupChecked('), context);
  context[mode === 'command' ? 'openServerPicker' : 'openProxyServerPicker']();
  assert.equal(context.serverPickerMode, mode);
  assert.equal(context.serverPickerOpen, true);
  assert.equal(context.pickerSearch, '');
  assert.equal(context.pickerGroupId, 'all');
  assert.deepEqual(Array.from(context.pickerSelectedIds), mode === 'command' ? ['d'] : []);
  context.pickerSelectedIds = ['d'];
  context.pickerSearch = '23.134.76.169 23.134.76.170 Tokyo';
  context.pickerGroupId = 'uk';
  const updateResults = () => vm.runInContext(`{ ${between('  const pickerFilteredServers = useMemo(', '  const filteredCommands = useMemo(')}
    globalThis.pickerFilteredServers = pickerFilteredServers; }`, context);
  updateResults();
  assert.deepEqual(ids(context.pickerFilteredServers), ['a', 'b']);
  vm.runInContext(between('  function selectAllServers()', '  function togglePickerServerChecked('), context);
  context.selectCurrentPickerGroup();
  context.selectCurrentPickerGroup();
  assert.deepEqual(Array.from(context.pickerSelectedIds), ['d', 'a', 'b']);
  context.clearCurrentPickerGroup();
  assert.deepEqual(Array.from(context.pickerSelectedIds), ['d']);
  context.pickerSearch = 'not-found nowhere';
  updateResults();
  context.selectCurrentPickerGroup();
  context.clearCurrentPickerGroup();
  assert.deepEqual(Array.from(context.pickerSelectedIds), ['d'], 'empty results cannot select or clear unrelated hosts');
  context.pickerSearch = 'Tokyo';
  context.pickerGroupId = 'all';
  updateResults();
  context.selectCurrentPickerGroup();
  assert.deepEqual(Array.from(context.pickerSelectedIds), ['d', 'c']);
  context.pickerSearch = '';
  context.pickerGroupId = 'uk';
  updateResults();
  context.clearCurrentPickerGroup();
  assert.deepEqual(Array.from(context.pickerSelectedIds), ['d', 'c'], 'changing the search/group preserves other selections');
  context.selectAllServers();
  assert.deepEqual(Array.from(context.pickerSelectedIds), ['a', 'b', 'c', 'd']);
});

function pasteHarness(value, start = value.length, end = start) {
  let query = value, prevented = false;
  const input = { value, selectionStart: start, selectionEnd: end,
    setRangeText(text, first, last, selectionMode) {
      assert.equal(selectionMode, 'end');
      this.value = this.value.slice(0, first) + text + this.value.slice(last);
      this.selectionStart = this.selectionEnd = first + text.length;
    } };
  const context = vm.createContext({ setPickerSearch: (next) => { query = next; } });
  vm.runInContext(between('  function pastePickerSearch(', '  function toggleGroupChecked('), context);
  return { input, query: () => query, prevented: () => prevented,
    paste(text) { context.pastePickerSearch({ currentTarget: input, clipboardData: { getData: () => text },
      preventDefault() { prevented = true; } }); } };
}

test('pasting line-separated or tab-separated IPs normalizes separators before input sanitization', () => {
  const h = pasteHarness('');
  h.paste('23.134.76.169\r\n23.134.76.170\tTokyo');
  assert.equal(h.prevented(), true);
  assert.equal(h.query(), '23.134.76.169 23.134.76.170 Tokyo');
  assert.deepEqual(ids(filterPickerServers(servers, h.query())), ['a', 'b', 'c']);
  assert.equal(h.input.selectionStart, h.query().length);
});

test('multiline paste replaces only the selection, preserving surrounding search and caret', () => {
  const h = pasteHarness('London OLD 备用', 7, 10);
  h.paste('23.134.76.170\nTokyo');
  assert.equal(h.query(), 'London 23.134.76.170 Tokyo 备用');
  assert.equal(h.input.selectionStart, 'London 23.134.76.170 Tokyo'.length);
  assert.equal(h.input.selectionEnd, h.input.selectionStart);
});

test('ordinary single-line and empty pastes keep native browser behavior', () => {
  for (const pasted of ['London 英国', '', '2001:db8::3']) {
    const h = pasteHarness('original');
    h.paste(pasted);
    assert.equal(h.prevented(), false);
    assert.equal(h.query(), 'original');
  }
});

for (const mode of ['command', 'proxy']) test(`${mode} confirmation uses selected IDs, never all search matches`, async () => {
  let selected, applied = 0, closed = false;
  const context = vm.createContext({ serverPickerMode: mode, pickerSelectedIds: ['b'],
    pickerFilteredServers: servers, setSelectedServerIds(value) { selected = Array.from(value); },
    setServerPickerOpen(value) { closed = !value; }, applySelectedServersToProxy() { applied++; } });
  vm.runInContext(between('  async function confirmServerPicker()', '  function closeTerminal('), context);
  await context.confirmServerPicker();
  if (mode === 'command') {
    assert.deepEqual(selected, ['b']);
    assert.equal(closed, true);
    assert.equal(applied, 0);
  } else {
    assert.equal(selected, undefined);
    assert.equal(applied, 1);
  }
});

test('proxy assignment sends only checked IDs and sends no request for an empty selection', async () => {
  const requests = [], messages = [];
  let open = true, selected = ['b'];
  const context = vm.createContext({ selectedProxy: { id: 'proxy' }, pickerSelectedIds: selected,
    pickerFilteredServers: servers, setActionBusy() {}, setState() {}, setAuth() {},
    setServerPickerOpen(value) { open = value; }, setPickerSelectedIds(value) { selected = value; },
    toast(value) { messages.push(value); },
    async api(path, options) { requests.push({ path, body: JSON.parse(options.body) }); return { state: {} }; } });
  vm.runInContext(between('  async function applySelectedServersToProxy()', '  async function unassignProxyServers('), context);
  await context.applySelectedServersToProxy();
  assert.deepEqual(requests, [{ path: '/api/proxies/proxy/assign', body: { serverIds: ['b'] } }]);
  assert.equal(open, false);
  assert.deepEqual(Array.from(selected), []);
  context.pickerSelectedIds = [];
  await context.applySelectedServersToProxy();
  assert.equal(requests.length, 1);
  assert.equal(messages.at(-1), '请先选择至少一台服务器');
});

test('search treats regular-expression syntax and HTML as literal strings', () => {
  assert.deepEqual(ids(filterPickerServers(servers, '.* [London] <script>')), []);
  const records = [{ id: 'html', name: '<script>alert(1)</script>' }];
  assert.deepEqual(ids(filterPickerServers(records, '<script>')), ['html']);
});

test('shared picker has concise multi-search hint and is unchanged by mode', () => {
  assert.match(app, /placeholder="名称 \/ IP，空格多项"/);
  assert.match(app, /aria-label="搜索服务器名称或 IP，多个条件用空格分隔，匹配任意一项"/);
  assert.match(app, /onPaste=\{pastePickerSearch\}/);
  assert.match(app, /serverPickerMode === 'proxy' \? '选择服务器并应用代理' : '选择服务器'/);
});
