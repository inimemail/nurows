import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { beijingDate, validRenewalDate, renewalDays, renewalStatus, sortRenewals, renewalStage, renewalAmount, renewalIdentityIndex, renewalDuplicateField, DEFAULT_RENEWAL_SETTINGS } from '../shared/renewals.js';
import { validateRenewal, validateRenewalSettings, normalizeRenewalState, renewalSnapshot, registerRenewalRoutes, createRenewalService, renewalMessage } from '../server/renewals.js';
import { pruneHistory } from '../server/history.js';
import { filterWorkspaceRecords, workspaceSearchPlaceholder } from '../shared/workspace-search.js';

const NOW = Date.parse('2026-09-21T02:00:00Z');
const BOT = { id: 'bot', name: '通知', tokenEnc: 'encrypted', userIds: ['1', '2'], enabled: true };
const input = (patch = {}) => ({ name: '香港入口', address: 'hk.example.com', price: '12.50', currency: 'USD', dueDate: '2026-09-24', botIds: ['bot'], note: '', ...patch });
const record = (patch = {}, time = NOW) => validateRenewal(input(patch), [BOT], null, time);
function harness(records = [record()], bots = [BOT], send) {
  let state = { ...normalizeRenewalState(), renewals: records }, time = NOW, writes = 0, botReads = 0;
  const sent = [], errors = [];
  const deps = {
    read: () => structuredClone(state),
    update(mutator) { const draft = structuredClone(state); mutator(draft); draft.renewalRevision++; state = draft; writes++; },
    bots: () => { botReads++; return structuredClone(bots); }, now: () => time,
    send: async (...args) => { sent.push(args); await send?.(...args); }, logError: (error) => errors.push(error)
  };
  let service = createRenewalService(deps);
  return { deps, bots, sent, errors, get state() { return state; }, get writes() { return writes; }, get botReads() { return botReads; },
    tick: () => service.tick(), restart() { service = createRenewalService(deps); }, time(value) { time = value; } };
}

test('renewal dates use Beijing calendar days, strict dates and stable expiration sorting', () => {
  assert.equal(beijingDate(Date.parse('2026-09-20T15:59:59Z')), '2026-09-20');
  assert.equal(beijingDate(Date.parse('2026-09-20T16:00:00Z')), '2026-09-21');
  assert.equal(renewalDays('2026-09-21', NOW), 0);
  assert.equal(validRenewalDate('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-09-31', '2026-9-21', '1999-12-31', '2200-01-01', '']) assert.equal(validRenewalDate(date), false);
  const dates = ['', '2026-10-21', '2026-09-19', '2026-09-21', '2026-09-20'];
  assert.deepEqual(sortRenewals(dates.map((dueDate, id) => ({ id: String(id), name: 'x', dueDate })), NOW).map((r) => r.dueDate), ['2026-09-20', '2026-09-19', '2026-09-21', '2026-10-21', '']);
  assert.equal(renewalStatus({ dueDate: '' }, undefined, NOW).key, 'unknown');
  assert.equal(renewalStatus({ dueDate: '2026-09-20' }, undefined, NOW).key, 'expired');
  assert.equal(renewalStatus({ dueDate: '2026-09-21' }, undefined, NOW).tone, 'bad');
  assert.equal(renewalStatus({ dueDate: '2026-09-24' }, undefined, NOW).key, 'soon');
  assert.equal(renewalStatus({ dueDate: '2026-10-21' }, undefined, NOW).key, 'valid');
});

test('renewal validation handles optional fields, zero amounts and rejects invalid input', () => {
  assert.equal(record({ address: '2001:db8::1', price: '0' }).price, '0.00');
  assert.equal(renewalAmount(record({ price: '0' })), 'USD 0.00');
  assert.equal(record({ address: 'EXAMPLE.COM.' }).address, 'example.com');
  assert.equal(record({ address: '', dueDate: '', price: '', botIds: [] }).dueDate, '');
  for (const patch of [{ name: '' }, { address: 'https://example.com' }, { address: 'example.com/path' }, { address: '192.168.0.999' }, { address: 'a.com:80' }, { price: '-1' }, { price: '1.234' }, { price: '1e2' }, { currency: 'bogus' }, { botIds: ['missing'] }, { dueDate: '2026-02-30' }]) assert.throws(() => record(patch));
  assert.deepEqual(validateRenewalSettings({ days: [0, 3, 7, 3], time: '23:59' }), { days: [7, 3, 0], time: '23:59', botIds: [] });
  for (const patch of [{ days: [-1] }, { days: [366] }, { days: [1.5] }, { time: '24:00' }]) assert.throws(() => validateRenewalSettings({ ...DEFAULT_RENEWAL_SETTINGS, ...patch }));
  assert.deepEqual(normalizeRenewalState({ renewalSettings: { days: ['bad'] } }).renewalSettings, DEFAULT_RENEWAL_SETTINGS);
});

test('renewal edits keep dedup state unless the date changes; removed bots do not block editing', () => {
  const before = record();
  before.deliveries = { '["bot","1"]': { stage: 3, status: 'sent' }, corrupt: {} };
  const edited = validateRenewal(input({ note: 'new' }), [BOT], before, NOW);
  assert.equal(edited.id, before.id);
  assert.notEqual(edited.version, before.version);
  assert.deepEqual(Object.keys(edited.deliveries), ['["bot","1"]']);
  assert.deepEqual(validateRenewal(input({ dueDate: '2026-09-28' }), [BOT], before, NOW).deliveries, {});
  assert.deepEqual(validateRenewal(input(), [], before, NOW).botIds, []);
  assert.equal(Object.hasOwn(renewalSnapshot({ renewals: [edited] }).renewals[0], 'deliveries'), false);
});

test('reminders group by bot and recipient, escape HTML, persist success and do not repeat after restart', async () => {
  const h = harness([record(), record({ name: '<b>香港 & 测试</b>' }), record({ name: 'not selected', botIds: [] })]);
  await h.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0][2], /&lt;b&gt;香港 &amp; 测试&lt;\/b&gt;/);
  assert.doesNotMatch(h.sent[0][2], /not selected/);
  assert.match(h.sent[0][2], /还有 3 天到期/);
  h.restart(); await h.tick();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.errors, []);
  h.time(Date.parse('2026-09-23T02:00:00Z')); await h.tick();
  assert.equal(h.sent.length, 4);
  assert.match(h.sent[2][2], /明天到期/);
  h.time(Date.parse('2026-09-24T02:00:00Z')); await h.tick();
  assert.equal(h.sent.length, 6);
  h.time(Date.parse('2026-09-25T02:00:00Z')); await h.tick();
  assert.equal(h.sent.length, 6);
});

test('one catch-up stage, scheduled time, immediate newly added reminders and optional day zero', async () => {
  const old = record({ dueDate: '2026-09-23' }, NOW - 86400000);
  const h = harness([old]);
  h.time(Date.parse('2026-09-21T00:59:00Z')); await h.tick();
  assert.equal(h.sent.length, 0);
  h.time(Date.parse('2026-09-21T01:00:00Z')); await h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.state.renewals[0].deliveries['["bot","1"]'].stage, 3);
  const fresh = harness([record()], [{ ...BOT, userIds: ['1'] }]);
  fresh.time(Date.parse('2026-09-21T00:00:00Z')); await fresh.tick();
  assert.equal(fresh.sent.length, 1);
  assert.equal(renewalStage({ dueDate: '2026-09-21' }, { days: [7, 1] }, NOW), null);
  assert.equal(renewalStage({ dueDate: '2026-09-21' }, { days: [0] }, NOW), 0);
});

test('idle scheduler does not write or load bots for unknown, expired, distant or unselected records', async () => {
  const h = harness([record({ dueDate: '' }), record({ dueDate: '2026-09-20' }), record({ dueDate: '2027-01-01' }), record({ botIds: [] })]);
  await h.tick(); await h.tick();
  assert.equal(h.writes, 0); assert.equal(h.botReads, 0); assert.equal(h.sent.length, 0);
  const disabled = harness([record()], [{ ...BOT, enabled: false }]); await disabled.tick();
  assert.equal(disabled.sent.length, 0);
  const noRecipients = harness([record()], [{ ...BOT, userIds: [] }]); await noRecipients.tick();
  assert.equal(noRecipients.writes, 0);
});

test('renewal default bots apply only to records without explicit selection and survive edits without duplicate reminders', async () => {
  const defaultBot = { ...BOT, id: 'default', userIds: ['3'] };
  const h = harness([record({ name: 'inherited', botIds: [] }), record({ name: 'explicit' })], [BOT, defaultBot]);
  h.state.renewalSettings.botIds = ['default'];
  await h.tick();
  assert.equal(h.sent.length, 3);
  const inherited = h.sent.find(([bot]) => bot.id === 'default');
  assert.match(inherited[2], /inherited/); assert.doesNotMatch(inherited[2], /explicit/);
  assert.ok(h.sent.filter(([bot]) => bot.id === 'bot').every(([, , text]) => text.includes('explicit') && !text.includes('inherited')));
  h.deps.update((state) => { state.renewals[0] = validateRenewal({ ...state.renewals[0], note: 'edited' }, [BOT, defaultBot], state.renewals[0], NOW); });
  h.restart(); await h.tick(); assert.equal(h.sent.length, 3);
  h.state.renewalSettings.botIds = [];
  await h.tick(); assert.equal(h.sent.length, 3);
  h.state.renewalSettings.botIds = ['default'];
  await h.tick(); assert.equal(h.sent.length, 3);
});

test('clearing default bots during an in-flight batch stops queued inherited recipients', async () => {
  let release;
  const h = harness([record({ botIds: [] })], [BOT], () => new Promise((resolve) => { release = resolve; }));
  h.state.renewalSettings.botIds = ['bot'];
  const pending = h.tick();
  assert.equal(h.sent.length, 1);
  h.deps.update((state) => { state.renewalSettings.botIds = []; });
  release(); await pending;
  assert.equal(h.sent.length, 1); assert.deepEqual(h.errors, []);
});

test('per-record notification defaults on, opt-out persists and re-enabling preserves deduplication', async () => {
  const original = record({ botIds: [] });
  assert.equal(original.notificationEnabled, true);
  assert.throws(() => record({ notificationEnabled: 'false' }));
  const disabled = validateRenewal({ ...original, notificationEnabled: false }, [BOT], original, NOW);
  assert.equal(validateRenewal(input({ botIds: [] }), [BOT], disabled, NOW).notificationEnabled, false);
  const h = harness([disabled, record({ name: 'explicit disabled', notificationEnabled: false })]);
  h.state.renewalSettings.botIds = ['bot'];
  await h.tick(); assert.equal(h.sent.length, 0); assert.equal(h.writes, 0);
  h.deps.update((state) => { state.renewals[0] = validateRenewal({ ...state.renewals[0], notificationEnabled: true }, [BOT], state.renewals[0], NOW); });
  await h.tick(); assert.equal(h.sent.length, 2);
  for (const enabled of [false, true]) {
    h.deps.update((state) => { state.renewals[0] = validateRenewal({ ...state.renewals[0], notificationEnabled: enabled }, [BOT], state.renewals[0], NOW); });
    h.restart(); await h.tick();
  }
  assert.equal(h.sent.length, 2);
  const legacy = record({ botIds: [] }); delete legacy.notificationEnabled;
  const old = harness([legacy]); old.state.renewalSettings.botIds = ['bot'];
  await old.tick(); assert.equal(old.sent.length, 2);
});

test('disabling a record while sending stops its remaining queued recipients', async () => {
  let release;
  const h = harness([record()], [BOT], () => new Promise((resolve) => { release = resolve; }));
  const pending = h.tick();
  h.deps.update((state) => { state.renewals[0].notificationEnabled = false; });
  release(); await pending;
  assert.equal(h.sent.length, 1);
});

test('renewal settings validate and persist default bots, preserve selection for old clients, and clean deleted bots', async () => {
  const h = harness([record({ botIds: [] }), record()]);
  let handler, ticks = 0;
  registerRenewalRoutes({ get() {}, post() {}, put(path, fn) { if (path === '/api/renewals/settings') handler = fn; } }, h.deps, { tick() { ticks++; } });
  const save = async (body) => {
    let error;
    await handler({ body: { days: [7, 3, 1, 0], time: '09:00', revision: h.state.renewalRevision, ...body } }, { json() {} }, (value) => { error = value; });
    if (error) throw error;
  };
  for (const botIds of [['missing'], 'bot', [123]]) await assert.rejects(save({ botIds }));
  assert.equal(h.writes, 0);
  await save({ botIds: ['bot', 'bot'] });
  assert.deepEqual(h.state.renewalSettings.botIds, ['bot']);
  assert.equal(h.state.renewals[0].immediateDate, beijingDate());
  assert.deepEqual(h.state.renewals[0].botIds, []);
  await save({ time: '10:00' });
  assert.deepEqual(h.state.renewalSettings.botIds, ['bot']);
  assert.deepEqual(normalizeRenewalState(h.state).renewalSettings.botIds, ['bot']);
  h.bots.splice(0);
  await save({ botIds: ['bot'] });
  assert.deepEqual(h.state.renewalSettings.botIds, []);
  assert.equal(ticks, 3);
});

test('definite failures retry at most three times with delay and other recipients do not hide errors', async () => {
  const h = harness([record()], [BOT], async (_bot, chat) => { if (chat === '1') throw Object.assign(Error('rejected'), { definite: true, retryAfter: 600 }); });
  await h.tick(); assert.equal(h.sent.length, 2);
  assert.match(h.state.renewals[0].notificationError, /失败/);
  h.time(NOW + 5 * 60000); await h.tick(); assert.equal(h.sent.length, 2);
  h.time(NOW + 10 * 60000); await h.tick(); assert.equal(h.sent.length, 3);
  h.time(NOW + 20 * 60000); await h.tick(); assert.equal(h.sent.length, 4);
  h.time(NOW + 30 * 60000); await h.tick(); assert.equal(h.sent.length, 4);
  assert.match(h.state.renewals[0].notificationError, /重试上限/);
});

test('uncertain network outcomes and interrupted sends never replay the same node after restart', async () => {
  const h = harness([record()], [{ ...BOT, userIds: ['1'] }], () => { throw Error('timeout'); });
  await h.tick(); h.restart(); h.time(NOW + 3600000); await h.tick();
  assert.equal(h.sent.length, 1); assert.match(h.state.renewals[0].notificationError, /未确认/);
  h.state.renewals[0].deliveries['["bot","1"]'].status = 'sending';
  h.restart(); await h.tick(); assert.equal(h.sent.length, 1);
});

test('overlapping ticks coalesce and queued deletes, bot disables and date edits cannot revive old deliveries', async () => {
  let release;
  const h = harness([record()], [structuredClone(BOT)], () => new Promise((resolve) => { release = resolve; }));
  const pending = h.tick(); const second = h.tick();
  assert.equal(pending, second); assert.equal(h.sent.length, 1);
  h.deps.update((state) => { state.renewals = []; });
  release(); await pending; assert.equal(h.sent.length, 1); assert.equal(h.state.renewals.length, 0);

  const changed = harness([record()], [structuredClone(BOT)], () => new Promise((resolve) => { release = resolve; }));
  const sending = changed.tick();
  changed.deps.update((state) => { state.renewals[0] = validateRenewal(input({ dueDate: '2026-10-21' }), [BOT], state.renewals[0], NOW); });
  release(); await sending;
  assert.equal(changed.sent.length, 1); assert.deepEqual(changed.state.renewals[0].deliveries, {});

  const disabled = harness([record()], [structuredClone(BOT)], () => new Promise((resolve) => { release = resolve; }));
  const inFlight = disabled.tick(); disabled.bots[0].enabled = false; release(); await inFlight;
  assert.equal(disabled.sent.length, 1);
});

test('message chunks and per-tick sends are bounded and progress carries to the next tick', async () => {
  const h = harness(Array.from({ length: 210 }, (_, i) => record({ name: `server-${i}` })), [{ ...BOT, userIds: ['1'] }]);
  await h.tick(); assert.equal(h.sent.length, 20);
  for (const [, , text] of h.sent) { assert.ok(text.length <= 3500); assert.ok((text.match(/🖥/g) || []).length <= 10); }
  await h.tick(); assert.equal(h.sent.length, 21);
  assert.deepEqual(h.errors, []);
  const long = harness(Array.from({ length: 30 }, () => record({ name: '&'.repeat(120), address: 'a'.repeat(60) + '.example.com' })), [{ ...BOT, userIds: ['1'] }]);
  await long.tick(); assert.ok(long.sent.every((entry) => entry[2].length <= 3500));
  assert.doesNotMatch(renewalMessage([record({ price: '', address: '' })], NOW), /续费：|地址：/);
});

test('renewal CRUD requires revisions and delete confirmation and never touches other modules', async () => {
  const h = harness(); const handlers = new Map(); let ticks = 0;
  h.state.servers = [{ id: 'server' }]; h.state.dnsGuards = [{ id: 'guard' }];
  registerRenewalRoutes(Object.fromEntries(['get', 'put', 'post'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)])), h.deps, { tick() { ticks++; } });
  const invoke = async (method, path, body = {}, params = {}) => {
    let result, error;
    await handlers.get(`${method} ${path}`)({ body, params }, { json(value) { result = value; } }, (value) => { error = value; });
    if (error) throw error;
    return result;
  };
  const initial = await invoke('get', '/api/renewals');
  assert.equal(initial.bots[0].tokenEnc, undefined); assert.equal(initial.bots[0].userIds, undefined);
  let res = await invoke('post', '/api/renewals', input({ name: 'second', address: 'second.example.com', botIds: [] }));
  assert.equal(res.renewals.length, 2);
  const item = res.renewals[0];
  await assert.rejects(invoke('put', '/api/renewals/:id', { ...input(), version: 'stale' }, { id: item.id }), { statusCode: 409 });
  res = await invoke('put', '/api/renewals/:id', { ...input(), version: item.version, name: 'edited' }, { id: item.id });
  assert.equal(res.renewals[0].name, 'edited');
  await assert.rejects(invoke('post', '/api/renewals/delete', { all: true, revision: res.renewalRevision }));
  await assert.rejects(invoke('post', '/api/renewals/delete', { all: true, confirm: true, revision: 0 }), { statusCode: 409 });
  res = await invoke('put', '/api/renewals/settings', { days: [5, 0], time: '10:00', revision: res.renewalRevision });
  assert.deepEqual(res.renewalSettings.days, [5, 0]);
  res = await invoke('post', '/api/renewals/delete', { ids: [item.id], confirm: true, revision: res.renewalRevision });
  assert.equal(res.renewals.length, 1);
  res = await invoke('post', '/api/renewals/delete', { all: true, confirm: true, revision: res.renewalRevision });
  assert.equal(res.renewals.length, 0); assert.equal(ticks, 3);
  assert.deepEqual(h.state.servers, [{ id: 'server' }]); assert.deepEqual(h.state.dnsGuards, [{ id: 'guard' }]);
});

test('renewal identity matching canonicalizes names, domains and IPv6 without resolving DNS', () => {
  const records = [record({ name: ' Server ONE ', address: 'EXAMPLE.com.' }), record({ name: 'IPv6', address: '2001:db8::1' }), record({ name: 'IDN', address: '例子.测试' })];
  const index = renewalIdentityIndex(records);
  assert.equal(renewalDuplicateField({ name: 'server one', address: '' }, index), 'name');
  assert.equal(renewalDuplicateField({ name: 'new', address: 'example.COM.' }, index), 'address');
  assert.equal(renewalDuplicateField({ name: 'new', address: '2001:0DB8:0:0:0:0:0:1' }, index), 'address');
  assert.equal(renewalDuplicateField({ name: 'new', address: '例子.测试' }, index), 'address');
  assert.equal(renewalDuplicateField({ name: 'new', address: 'xn--fsqu00a.xn--0zwm56d' }, index), 'address');
  assert.equal(renewalDuplicateField({ name: 'new', address: '' }, index), '');
  assert.equal(renewalDuplicateField(records[0], renewalIdentityIndex(records, records[0].id)), '');
});

test('renewal create and edit enforce uniqueness inside the write transaction without blocking self edits or empty addresses', async () => {
  const h = harness([record({ name: 'first', address: '2001:db8::1' }), record({ name: 'second', address: 'example.com' })]);
  const handlers = new Map();
  registerRenewalRoutes(Object.fromEntries(['get', 'put', 'post'].map((method) => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)])), h.deps, { tick() {} });
  const invoke = async (method, path, body, params = {}) => {
    let error;
    await handlers.get(`${method} ${path}`)({ body, params }, { json() {} }, (value) => { error = value; });
    if (error) throw error;
  };
  for (const patch of [{ name: ' FIRST ', address: '' }, { name: 'new', address: '2001:0DB8:0:0:0:0:0:1' }, { name: 'new', address: 'EXAMPLE.COM.' }]) {
    await assert.rejects(invoke('post', '/api/renewals', input(patch)), { statusCode: 409 });
  }
  assert.equal(h.writes, 0);
  const first = h.state.renewals[0];
  await assert.rejects(invoke('put', '/api/renewals/:id', { ...first, name: 'second' }, { id: first.id }), { statusCode: 409 });
  await assert.rejects(invoke('put', '/api/renewals/:id', { ...first, address: 'example.com' }, { id: first.id }), { statusCode: 409 });
  await invoke('put', '/api/renewals/:id', { ...first, note: 'changed' }, { id: first.id });
  assert.equal(h.state.renewals[0].note, 'changed');
  await invoke('post', '/api/renewals', input({ name: 'empty1', address: '' }));
  await invoke('post', '/api/renewals', input({ name: 'empty2', address: '' }));
  await assert.rejects(invoke('post', '/api/renewals', input({ name: 'empty2', address: '' })), { statusCode: 409 });
  assert.equal(h.state.renewals.length, 4);
});

test('renewals survive history cleanup and search only public identity fields', () => {
  const state = { renewals: [record({ note: '测试备注' })], renewalSettings: DEFAULT_RENEWAL_SETTINGS, auditLogs: [] };
  const before = structuredClone(state.renewals);
  pruneHistory(state, { all: true, now: NOW + 365 * 86400000 });
  assert.deepEqual(state.renewals, before);
  for (const search of ['香港', 'hk.example', '测试备注']) assert.equal(filterWorkspaceRecords('renewals', state.renewals, search).length, 1);
  assert.equal(filterWorkspaceRecords('renewals', state.renewals, 'encrypted').length, 0);
  assert.match(workspaceSearchPlaceholder('renewals'), /名称|续费|域名/);
});

test('isolated renewal writes clone no histories and publish only after persistence succeeds; only one startup timer exists', () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function updateRenewalState('), end = source.indexOf('\nfunction ', start + 1);
  const before = { ...normalizeRenewalState(), renewals: [record()], auditLogs: [{ content: 'large history' }] };
  const clones = [];
  const ctx = vm.createContext({ cachedState: before, ensureStorage() {}, STORAGE_KEYS: { state: 'state' },
    structuredClone(value) { clones.push(value); return structuredClone(value); }, dbSetJson() { throw Error('disk full'); } });
  vm.runInContext(source.slice(start, end), ctx);
  assert.throws(() => ctx.updateRenewalState((draft) => { draft.renewals = []; }), /disk full/);
  assert.equal(ctx.cachedState, before); assert.equal(clones[0].auditLogs, undefined);
  ctx.dbSetJson = () => {};
  ctx.updateRenewalState((draft) => { draft.renewals = []; });
  assert.equal(ctx.cachedState.auditLogs, before.auditLogs); assert.equal(ctx.cachedState.renewalRevision, 1);
  assert.equal(source.match(/setInterval\(\(\) => renewalService.tick\(\), 60000\)/g).length, 1);
  assert.ok(source.indexOf('setInterval(() => renewalService.tick(), 60000)') > source.indexOf('server.listen(PORT'));
  assert.ok(source.indexOf("app.use('/api', authGuard)") < source.indexOf('registerRenewalRoutes(app'));
});
