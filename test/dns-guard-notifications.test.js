import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { transformSync } from 'esbuild';
import * as telegramPermissions from '../shared/telegram-permissions.js';
import * as workspaceSearch from '../shared/workspace-search.js';
import { normalizeOrchestrationState, orchestrationDefaults, registerOrchestrationRoutes } from '../server/orchestration.js';

function harness() {
  let state = { ...orchestrationDefaults(), probes: [{ id: 'probe' }], dnsAccounts: [{ id: 'account' }],
    telegramBots: [{ id: 'bot-a' }, { id: 'bot-b' }] };
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, fn) => routes.set(`${method} ${path}`, fn)]));
  registerOrchestrationRoutes(app, { readState: () => structuredClone(state),
    updateState(mutate) { state = mutate(structuredClone(state)); return state; }, sanitizeState: (value) => value });
  return { state: () => state, async request(method, resource, body = {}, id = '') {
    let result;
    await routes.get(`${method} /api/orchestration/:resource${id ? '/:id' : ''}`)(
      { params: { resource, id }, body, auth: { username: 'test' } }, { json(value) { result = value; } }, (error) => { throw error; });
    return result;
  } };
}

test('guard notification choices default empty, remain independent and can be saved, retained and cleared', async () => {
  assert.deepEqual(normalizeOrchestrationState({ dnsGuards: [{ id: 'legacy' }] }).dnsGuards[0].alertBotIds, []);
  const h = harness();
  const body = { name: '守护', domain: 'test.example.com', accountId: 'account', probeIds: ['probe'], poolIds: [] };
  const first = (await h.request('post', 'dns-guards', body)).item;
  assert.deepEqual(first.alertBotIds, []);
  const second = (await h.request('post', 'dns-guards', { ...body, alertBotIds: ['bot-b'] })).item;
  const saved = (await h.request('put', 'dns-guards', { ...body, alertBotIds: ['bot-a', 'bot-a'] }, first.id)).item;
  assert.deepEqual(saved.alertBotIds, ['bot-a']);
  assert.deepEqual((await h.request('put', 'dns-guards', body, first.id)).item.alertBotIds, ['bot-a']);
  assert.deepEqual((await h.request('put', 'dns-guards', { ...body, alertBotIds: [] }, first.id)).item.alertBotIds, []);
  assert.deepEqual(h.state().dnsGuards.find((item) => item.id === second.id).alertBotIds, ['bot-b']);
  await assert.rejects(h.request('put', 'dns-guards', { ...body, alertBotIds: ['missing'] }, first.id), /机器人不存在/);
  h.state().dynamicGuards = [{ id: 'dynamic', botIds: ['bot-a', 'bot-b'], revision: 7, cycle: { id: 'running' } }];
  await h.request('delete', 'telegram-bots', {}, 'bot-b');
  assert.deepEqual(h.state().dnsGuards.find((item) => item.id === second.id).alertBotIds, []);
  assert.deepEqual(h.state().dynamicGuards[0], { id: 'dynamic', botIds: ['bot-a'], revision: 7, cycle: { id: 'running' } });
});

test('DNS notifications only go to selected active bots, retain remaining count, and skip healthy runs', () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function notifyDnsGuardViaTelegram(');
  const end = source.indexOf('\nfunction snapshotPoolInventory(', start);
  const calls = [], reads = [];
  const state = { dnsGuards: [{ id: 'guard', name: '守护', domain: 'test.example.com', currentValues: ['192.0.2.2'], recordType: 'A' }],
    dnsGuardRuns: [{ guardId: 'guard', failedValues: ['192.0.2.1'] }],
    telegramBots: [
      { id: 'chosen', enabled: true, tokenEnc: 'chosen', userIds: ['chat', 'chat'] },
      { id: 'other', enabled: true, tokenEnc: 'other', userIds: ['other-chat'] },
      { id: 'disabled', enabled: false, tokenEnc: 'disabled', userIds: ['disabled-chat'] }
    ] };
  const ctx = vm.createContext({ AbortSignal, readState(keys) { reads.push(keys); return state; },
    decryptSecret: (value) => value, telegramMenuAllowed: () => false,
    telegramCall(token, method, body, options) { calls.push({ token, method, body, options }); return Promise.resolve(); }
  });
  vm.runInContext(source.slice(start, end), ctx);
  ctx.notifyDnsGuardViaTelegram('guard');
  assert.equal(calls.length, 0);
  assert.equal(reads.length, 1);
  state.dnsGuards[0].alertBotIds = ['chosen', 'chosen', 'disabled', 'missing'];
  ctx.notifyDnsGuardViaTelegram('guard');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'chosen');
  assert.equal(calls[0].body.chat_id, 'chat');
  assert.match(calls[0].body.text, /当前活动 IP：1 个/);
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.ok(calls[0].options.signal);
  state.dnsGuardRuns[0].failedValues = [];
  ctx.notifyDnsGuardViaTelegram('guard');
  assert.equal(calls.length, 1);
});

test('guard editor exposes default-empty bot selection and serializes changes without affecting probes or pools', () => {
  const source = fs.readFileSync(new URL('../src/OrchestrationWorkspace.jsx', import.meta.url), 'utf8');
  const compiled = transformSync(`${source}\nexport { GuardEditor, normalizeDraft, serializeDraft };`, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, structuredClone, require(path) {
    if (path === 'react') return { useState: (initial) => [initial, () => {}] };
    if (path === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (path.endsWith('polling.js')) return {};
    if (path.endsWith('telegram-permissions.js')) return telegramPermissions;
    if (path.endsWith('workspace-search.js')) return workspaceSearch;
    if (path.endsWith('DynamicGuardWorkspace.jsx')) return { default: 'dynamic', __esModule: true };
    throw Error(path);
  } });
  let draft = module.exports.normalizeDraft('guard', { probeIds: ['probe'], poolIds: ['pool'] });
  function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.props?.children)];
  }
  const bots = [{ id: 'bot', name: '通知机器人', configured: true, enabled: true, userIds: ['chat'] }];
  const tree = module.exports.GuardEditor({ value: draft, patch: (value) => { draft = { ...draft, ...value }; }, state: { telegramBots: bots }, api() {} });
  const picker = nodes(tree).find((node) => node.props?.label === '通知机器人（不选则不通知）');
  assert.equal(picker.props.value.length, 0);
  assert.equal(picker.props.items, bots);
  picker.props.onChange(['bot']);
  const saved = module.exports.serializeDraft('guard', draft);
  assert.deepEqual(saved.alertBotIds, ['bot']);
  assert.deepEqual(saved.probeIds, ['probe']);
  assert.deepEqual(saved.poolIds, ['pool']);
  picker.props.onChange([]);
  assert.deepEqual(module.exports.serializeDraft('guard', draft).alertBotIds, []);
});
