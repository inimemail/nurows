import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const compiled = transformSync(fs.readFileSync(new URL('../src/SettingsDialog.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
function harness(name = 'default', extra = {}) {
  const values = []; let cursor = 0, tree, saves = 0, clears = [];
  let account = { username: 'user', currentPassword: '', newPassword: '', confirmPassword: '' };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require(path) {
    if (path === 'react') return { useId: () => 'tabs-id', useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial;
      return [values[index], (value) => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; } };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path.endsWith('Dialog.jsx')) return { default: 'dialog', __esModule: true };
    if (path.endsWith('HistoryRecords.jsx')) return { default: 'records', __esModule: true };
    if (path.endsWith('.css')) return {};
    throw Error(path);
  } });
  const render = () => { cursor = 0; tree = module.exports[name]({ accountForm: account, setAccountForm: (update) => { account = update(account); },
    onSave: () => saves++, onClose() {}, onLogout() {}, onClearHistory: (scope) => clears.push(scope), ...extra }); };
  function nodes(value = tree) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    if (value.type?.name === 'Tabs') return nodes(value.type(value.props));
    return [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.footer ?? null)];
  }
  const text = (value) => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const button = (label) => nodes().find((node) => node.type === 'button' && text(node) === label);
  render();
  return { render, nodes, button, account: () => account, saves: () => saves, clears };
}

test('settings separate account and history; switching tabs preserves entered account values', () => {
  const view = harness();
  assert.equal(view.nodes().some((node) => node.type?.name === 'HistoryBrowser'), false);
  view.nodes().find((node) => node.type === 'input' && node.props.autoComplete === 'current-password').props.onChange({ target: { value: 'entered-value' } });
  view.button('历史记录').props.onClick(); view.render();
  assert.equal(view.nodes().some((node) => node.type === 'form'), false);
  assert.equal(view.nodes().filter((node) => node.type?.name === 'HistoryBrowser').length, 1);
  assert.equal(view.button('保存设置'), undefined);
  view.button('清理所有类别').props.onClick();
  assert.deepEqual(view.clears, ['all']);
  view.button('账号设置').props.onClick(); view.render();
  assert.equal(view.account().currentPassword, 'entered-value');
  view.nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(view.saves(), 1);
});

test('history exposes seven tabs and mounts only the selected category', () => {
  const view = harness('HistoryBrowser', { initialScope: 'dnsGuardRuns' });
  assert.equal(view.nodes().filter((node) => node.props?.role === 'tab').length, 7);
  assert.equal(view.nodes().find((node) => node.type === 'records').props.scope, 'dnsGuardRuns');
  view.button('动态 IP 守护').props.onClick(); view.render();
  const records = view.nodes().filter((node) => node.type === 'records');
  assert.equal(records.length, 1);
  assert.equal(records[0].props.scope, 'dynamicGuardRuns');
  assert.equal(view.button('动态 IP 守护').props['aria-selected'], true);
});

test('saving account disables submitting and closing through settings handlers', () => {
  let closed = 0;
  const view = harness('default', { saving: true, onClose: () => closed++ });
  assert.equal(view.button('保存中...').props.disabled, true);
  view.nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  view.button('取消').props.onClick();
  assert.equal(view.saves(), 0); assert.equal(closed, 0);
});
