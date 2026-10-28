import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createEpayService, normalizeEpayOrder, epayReceiptMessage } from '../server/epay.js';
import { requestEpay } from '../server/epay-api.js';
import { epayBalanceCents, epayMoney } from '../shared/epay.js';

function setup(t, orderStatus = '0') {
  const db = new Database(':memory:'); t.after(() => db.close());
  const sends = [], bots = [{ id: 'bot', name: '收款通知', enabled: true, tokenEnc: 'token', userIds: ['chat'] }];
  let current = orderStatus;
  const request = async (_account, _key, act) => act === 'query' ? { code: 1, money: '123.45' } : act === 'order'
    ? { code: 1, pid: '1001', trade_no: 'T1', out_trade_no: 'O1', name: '服务', type: 'alipay', money: '2.50', status: current, addtime: '2026-10-28 10:00:00', endtime: current === '1' ? '2026-10-28 10:01:00' : '' }
    : { code: 1, data: [{ pid: '1001', trade_no: 'T1', out_trade_no: 'O1', name: '服务', type: 'alipay', money: '2.50', status: current, addtime: '2026-10-28 10:00:00', endtime: current === '1' ? '2026-10-28 10:01:00' : '' }] };
  const service = createEpayService({ db, encrypt: value => ({ value }), decrypt: value => value?.value || '', bots: () => bots, request,
    send: async (_bot, chat, text) => sends.push({ chat, text }) });
  return { service, sends, setStatus: value => { current = value; } };
}

test('amount parsing uses minor units and supports a negative account balance', () => {
  assert.equal(epayBalanceCents('-12.30'), -1230);
  assert.equal(epayMoney(-1230, 'CNY'), '¥-12.30');
  assert.equal(epayMoney(250, 'CNY'), '¥2.50');
  assert.equal(epayBalanceCents('not-money'), null);
});

test('normalizes compatible orders without storing buyer or arbitrary response fields', () => {
  const result = normalizeEpayOrder({ pid: '1001', trade_no: 'T1', out_trade_no: 'O1', name: '会员', type: 'alipay', money: '1.00', status: 1, addtime: '2026-10-28 10:00:00', endtime: '2026-10-28 10:01:00', buyer: 'secret-user', param: 'secret' }, '1001');
  assert.deepEqual(Object.keys(result).sort(), ['cents', 'channel', 'created_at', 'name', 'out_trade_no', 'paid_at', 'paid_day', 'status', 'trade_no'].sort());
  assert.equal(result.status, 'paid');
  assert.throws(() => normalizeEpayOrder({ pid: '1002', trade_no: 'T1', money: '1', addtime: '2026-10-28' }, '1001'), /所属商户/);
});

test('first sync creates a silent baseline, then a pending-to-paid transition sends once with both balances', async t => {
  const env = setup(t, '0');
  const item = env.service.save({ name: '主站', url: 'https://pay.example.com/', pid: '1001', key: 'secret', botIds: ['bot'], interval: 15 });
  await env.service.sync(item.id); assert.equal(env.sends.length, 0);
  env.setStatus('1'); await env.service.sync(item.id); await env.service.deliver();
  assert.equal(env.sends.length, 1);
  assert.match(env.sends[0].text, /当前商户余额：/);
  assert.match(env.sends[0].text, /全部商户总余额：/);
  await env.service.deliver(); assert.equal(env.sends.length, 1);
});

test('initial paid history is a silent baseline and does not flood Telegram', async t => {
  const env = setup(t, '1');
  const item = env.service.save({ name: '历史站点', url: 'https://pay.example.com/', pid: '1001', key: 'secret', botIds: ['bot'], interval: 15 });
  await env.service.sync(item.id); await env.service.deliver();
  assert.equal(env.sends.length, 0);
});

test('editing an existing merchant cannot mix its ledger with another site or merchant id', t => {
  const env = setup(t), item = env.service.save({ name: '主站', url: 'https://pay.example.com/', pid: '1001', key: 'secret' });
  assert.throws(() => env.service.save({ ...item, key: '', url: 'https://other.example.com/' }, item.id), /不能直接修改/);
  assert.throws(() => env.service.save({ ...item, key: '', pid: '1002' }, item.id), /不能直接修改/);
});

test('receipt notification never includes merchant credentials', () => {
  const message = epayReceiptMessage({ name: '站点', currency: 'CNY', balance: 1000, botIds: [], lastError: '' }, { cents: 250, trade_no: 'T1', name: '商品', channel: 'alipay', paid_at: '2026-10-28T02:00:00.000Z' }, [{ currency: 'CNY', balance: 1000, interval: 30, balanceAt: new Date().toISOString(), lastError: '' }]);
  assert.match(message, /¥2.50/); assert.doesNotMatch(message, /key|secret/i);
});

test('overview and account snapshots skip the order ledger query', async t => {
  const env = setup(t, '0');
  const item = env.service.save({ name: '账号页', url: 'https://pay.example.com/', pid: '1001', key: 'secret' });
  await env.service.sync(item.id);
  env.service.store.orders = () => { throw new Error('order query should be skipped'); };
  for (const view of ['overview', 'accounts']) {
    const snapshot = env.service.snapshot({ view });
    assert.deepEqual(snapshot.orders, { records: [], total: 0, page: 1, pages: 1 });
    assert.equal(snapshot.accounts.length, 1);
  }
});

test('a disconnected connection test stops before its second request and releases its slot', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  let release, receivedSignal, calls = 0;
  const service = createEpayService({ db, encrypt: value => value, decrypt: value => value,
    request: async (_account, _key, act, _params, options) => {
      calls++; receivedSignal = options.signal;
      if (calls === 1) return new Promise(resolve => { release = resolve; });
      return act === 'query' ? { code: 1, money: '0' } : { code: 1, data: [] };
    } });
  const input = { name: '测试商户', url: 'https://pay.example.com/', pid: '1001', key: 'secret' };
  const controller = new AbortController();
  const pending = service.test(input, '', { signal: controller.signal });
  controller.abort(); assert.equal(receivedSignal.aborted, true);
  release({ code: 1, money: '0' });
  await assert.rejects(pending, /连接测试失败/); assert.equal(calls, 1);
  assert.equal((await service.test(input)).ok, true);
});

test('slow merchants stay bounded at three background syncs without delaying snapshots', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const releases = []; let active = 0, peak = 0;
  const service = createEpayService({ db, encrypt: value => value, decrypt: value => value,
    request: async (_account, _key, act) => {
      if (act !== 'query') return { code: 1, data: [] };
      active++; peak = Math.max(peak, active);
      return new Promise(resolve => releases.push(() => { active--; resolve({ code: 1, money: '0' }); }));
    } });
  const ids = Array.from({ length: 8 }, (_, i) => service.save({ name: `商户 ${i}`, url: 'https://pay.example.com/', pid: String(1000 + i), key: 'secret' }).id);
  const pending = ids.map(id => service.sync(id));
  for (let i = 0; i < 5; i++) await service.tick();
  assert.equal(peak, 3); assert.equal(active, 3);
  assert.equal(service.snapshot({ view: 'accounts' }).accounts.filter(item => item.syncing).length, 3);
  releases.forEach(release => release()); await Promise.all(pending);
  assert.equal(active, 0);
});

test('invalid calendar filters cannot silently roll into a different month', t => {
  const { service } = setup(t);
  assert.throws(() => service.snapshot({ from: '2026-02-31' }), /日期无效/);
  assert.doesNotThrow(() => service.snapshot({ from: '2028-02-29' }));
});

const compatibleRow = (i, status = '0') => ({ pid: '1001', trade_no: `T${i}`, money: '1.00', status,
  addtime: '2026-10-28 10:00:00', endtime: status === '1' ? '2026-10-28 10:01:00' : '' });
function customService(t, request, options = {}) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const service = createEpayService({ db, encrypt: value => value, decrypt: value => value, request, ...options });
  const item = service.save({ name: '兼容站点', url: 'https://pay.example.com/', pid: '1001', key: 'secret' });
  return { service, item, db };
}

const legacyQueryError = '易支付查询失败，请检查商户号、密钥以及商户 API 查询权限';

test('startup rechecks legacy generic errors without clearing them early or exceeding three syncs', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const options = { db, encrypt: value => value, decrypt: value => value };
  const old = createEpayService(options), releases = [];
  const items = Array.from({ length: 6 }, (_, i) => old.save({ name: `旧商户 ${i}`, url: 'https://pay.example.com/', pid: String(1000 + i), key: 'secret', enabled: i !== 4 }));
  const nextAt = Date.now() + 900000;
  for (const [i, item] of items.entries()) old.store.saveAccount({ ...old.store.account(item.id), nextAt, failures: 10,
    lastError: i === 5 ? '订单列表查询失败，请检查商户凭证、该接口权限与兼容性' : i === 3 ? '读取商户余额失败：易支付请求超时，请稍后重试' : legacyQueryError });
  old.close();
  const service = createEpayService({ ...options, request: async (_account, _key, act) => {
    if (act === 'query') return new Promise(resolve => releases.push(() => resolve({ code: 1, money: '1.00' })));
    return { code: 1, data: [] };
  } });
  t.after(() => service.close());
  assert.equal(service.snapshot({ view: 'accounts' }).accounts.filter(item => item.lastError).length, 6);
  await service.tick(); await service.tick();
  assert.equal(releases.length, 3);
  assert.equal(service.snapshot({ view: 'accounts' }).accounts.filter(item => item.syncing).length, 3);
  releases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  await service.tick(); assert.equal(releases.length, 1);
  releases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  for (const item of items.slice(0, 4)) {
    const account = service.store.account(item.id);
    assert.equal(account.lastError, ''); assert.equal(account.failures, 0); assert.equal(account.initialized, true);
  }
  assert.equal(service.store.account(items[4].id).lastError, legacyQueryError);
  assert.equal(service.store.account(items[4].id).nextAt, nextAt);
  assert.equal(service.store.account(items[5].id).nextAt, nextAt);
});

test('a legacy error recheck preserves cached orders and a real failure with its retry backoff', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const options = { db, encrypt: value => value, decrypt: value => value };
  const old = createEpayService(options);
  const item = old.save({ name: '旧错误', url: 'https://pay.example.com/', pid: '1001', key: 'secret' });
  old.store.mergeOrders(item, [normalizeEpayOrder(compatibleRow('paid', '1'), '1001')], [], () => false, Date.now());
  old.store.saveAccount({ ...old.store.account(item.id), lastError: legacyQueryError, nextAt: Date.now() + 900000 });
  old.close();
  let calls = 0;
  const request = async (_account, _key, act) => {
    if (act === 'query') return { code: 1, money: '1.00' };
    calls++; throw Object.assign(Error('订单列表查询失败，请检查商户凭证、该接口权限与兼容性'), { statusCode: 400 });
  };
  const service = createEpayService({ ...options, request });
  await service.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const result = service.snapshot({ view: 'orders' });
  assert.equal(result.orders.total, 1); assert.match(result.accounts[0].lastError, /订单列表查询失败/);
  assert.ok(result.accounts[0].nextAt > Date.now());
  service.close();
  const restarted = createEpayService({ ...options, request });
  t.after(() => restarted.close());
  await restarted.tick(); assert.equal(calls, 1);
});

test('a fixed thirty-order page stays healthy and never repeats detail requests for freshly listed orders', async t => {
  let details = 0;
  const { service, item } = customService(t, async (_account, _key, act) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    if (act === 'order') { details++; throw Object.assign(Error('detail not supported'), { statusCode: 400 }); }
    return { code: 1, data: Array.from({ length: 30 }, (_, i) => compatibleRow(i)) };
  });
  await service.sync(item.id);
  service.store.saveAccount({ ...service.store.account(item.id), lastError: '旧版本的辅助查询异常', failures: 2 });
  await service.sync(item.id);
  const result = service.snapshot().accounts[0];
  assert.equal(details, 0); assert.equal(result.lastError, ''); assert.equal(result.initialized, true);
  assert.equal(result.historyUnsupported, true); assert.ok(result.lastSyncAt); assert.equal(result.failures, 0);
  assert.equal(service.snapshot().balances[0].stale, 0);
});

test('history imports resume from their cursor, then normal syncs and restarts only read the newest page', async t => {
  const starts = [];
  const request = mockMerchant((act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    starts.push(params.start);
    return { code: 1, data: (params.start === 0 ? [5, 4] : params.start === 2 ? [3, 2] : params.start === 4 ? [1] : []).map(i => compatibleRow(i, '1')) };
  });
  const { service, item, db } = customService(t, request);
  await service.sync(item.id); await service.sync(item.id);
  assert.deepEqual(starts, [0, 2, 0, 4]);
  assert.equal(service.store.account(item.id).historyComplete, true);
  starts.length = 0; await service.sync(item.id); await service.sync(item.id);
  assert.deepEqual(starts, [0, 0]);
  const totals = service.snapshot().totals;
  service.close();
  const restarted = createEpayService({ db, encrypt: value => value, decrypt: value => value, request });
  t.after(() => restarted.close()); starts.length = 0;
  await restarted.sync(item.id); assert.deepEqual(starts, [0]);
  // Reading overview, order pages, and filters never makes merchant API calls.
  assert.equal(restarted.snapshot({ view: 'orders', accountId: item.id }).orders.total, 5);
  restarted.snapshot({ view: 'overview' }); restarted.snapshot({ view: 'orders', accountId: item.id, status: 'paid', page: 2 });
  assert.deepEqual(starts, [0]); assert.deepEqual(restarted.snapshot().totals, totals);
});

test('history failures do not undo current-order success and back off before retrying', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T06:00:00Z') });
  let historyRequests = 0, historyAvailable = false;
  const { service, item } = customService(t, async (_account, _key, act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    if (params.start) { historyRequests++; if (!historyAvailable) throw Object.assign(Error('history endpoint failed'), { statusCode: 400 }); return { code: 1, data: [] }; }
    return { code: 1, data: Array.from({ length: 50 }, (_, i) => compatibleRow(i, '1')) };
  });
  await service.sync(item.id);
  let result = service.snapshot().accounts[0];
  assert.equal(result.lastError, ''); assert.match(result.lastWarning, /历史订单暂未补齐/);
  assert.equal(result.initialized, true); assert.ok(result.lastSyncAt); assert.equal(service.snapshot().balances[0].stale, 0);
  await service.sync(item.id); assert.equal(historyRequests, 1);
  historyAvailable = true; t.mock.timers.tick(60001); await service.sync(item.id);
  result = service.snapshot().accounts[0];
  assert.equal(historyRequests, 2); assert.equal(result.historyComplete, true); assert.equal(result.lastWarning, '');
  assert.equal(service.snapshot().totals[0].total, 5000);
});

test('old order-detail failures remain visible as warnings without stopping new receipts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T06:00:00Z') });
  let detailRequests = 0, detailAvailable = false;
  const { service, item } = customService(t, async (_account, _key, act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    if (act === 'orders') return { code: 1, data: params.start ? [] : [compatibleRow('new', '1')] };
    detailRequests++;
    if (!detailAvailable) throw Object.assign(Error('detail failed'), { statusCode: 400 });
    return { code: 1, ...compatibleRow('old', '1') };
  });
  service.store.mergeOrders(item, [normalizeEpayOrder(compatibleRow('old'), '1001')], [], () => false, Date.now() - 1000);
  await service.sync(item.id);
  let result = service.snapshot().accounts[0];
  assert.equal(result.lastError, ''); assert.match(result.lastWarning, /旧订单状态暂未核对/); assert.equal(result.initialized, true);
  await service.sync(item.id); assert.equal(detailRequests, 1);
  detailAvailable = true; t.mock.timers.tick(60001); await service.sync(item.id);
  result = service.snapshot().accounts[0]; assert.equal(result.lastWarning, '');
  assert.equal(service.store.order(item.id, 'Told').status, 'paid');
});

// Exercise the real API response validation as well as the background job.
function mockMerchant(reply) {
  return (account, key, act, params, options) => requestEpay(account, key, act, params, { ...options,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request(_url, _options, callback) {
      const body = Buffer.from(JSON.stringify(reply(act, params)));
      callback({ statusCode: 200, on(event, handler) { if (event === 'data') handler(body); if (event === 'end') handler(); return this; } });
      return { on() { return this; }, end() {} };
    }
  });
}

test('catchup API rejection keeps latest receipts live, preserves the gap, and recovers without duplicate alerts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T01:00:00Z') });
  let round = 0, available = false;
  const calls = [], sends = [];
  const { service, item } = customService(t, mockMerchant((act, params) => {
    calls.push({ round, act, start: params.start });
    if (act === 'query') return { code: 1, money: '130.00' };
    if (!params.start) return { code: 1, data: (round === 0 ? [0, 1] : round === 1 ? [4, 3] : [5, 4]).map(i => compatibleRow(i, '1')) };
    if (!round) return { code: 1, data: [] };
    if (!available) return { code: -1, msg: '接口查询频率限制，请稍后再试' };
    return { code: 1, data: [2, 1].map(i => compatibleRow(i, '1')) };
  }), { bots: () => [{ id: 'bot', enabled: true, tokenEnc: 'token', userIds: ['chat'] }], send: async (_bot, _chat, text) => sends.push(text) });
  service.save({ ...item, key: '', botIds: ['bot'] }, item.id);
  await service.sync(item.id); await service.deliver(); assert.equal(sends.length, 0);
  round = 1; await service.sync(item.id); await service.deliver();
  let result = service.snapshot().accounts[0];
  assert.equal(result.lastError, ''); assert.equal(result.failures, 0);
  assert.match(result.catchupWarning, /期间订单尚未补齐/); assert.match(result.lastWarning, /返回码 -1.*查询频率/);
  assert.equal(result.catchupOffset, 2); assert.equal(result.nextAt, Date.now() + 30000); assert.equal(sends.length, 2);
  // Even if the current page changes during the backoff, keep the missing page
  // cursor aligned and continue reading the newest orders on every interval.
  t.mock.timers.tick(30000); round = 2; await service.tick(); await new Promise(resolve => setImmediate(resolve)); await service.deliver();
  result = service.snapshot().accounts[0];
  assert.equal(result.catchupOffset, 3); assert.equal(result.lastError, ''); assert.equal(sends.length, 3);
  assert.equal(calls.filter(call => call.round > 0 && call.start).length, 1);
  available = true; t.mock.timers.tick(30001); await service.sync(item.id); await service.deliver();
  result = service.snapshot().accounts[0];
  assert.equal(calls.at(-1).start, 3); assert.equal(result.catchupOffset, 0);
  assert.equal(result.catchupWarning, ''); assert.equal(result.lastWarning, ''); assert.equal(result.catchupRetryAt, 0);
  assert.equal(service.snapshot({ view: 'orders' }).orders.total, 6); assert.equal(sends.length, 4);
  await service.sync(item.id); await service.deliver(); assert.equal(sends.length, 4);
});

test('a failing catchup page defers old history instead of issuing another pagination request', async t => {
  let round = 0;
  const calls = [];
  const { service, item } = customService(t, mockMerchant((act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    calls.push(params.start);
    if (round && params.start) return { code: -1, msg: '参数不支持' };
    return { code: 1, data: (params.start ? [-2, -1] : round ? [4, 3] : [0, 1]).map(i => compatibleRow(i, '1')) };
  }));
  await service.sync(item.id);
  round = 1; calls.length = 0; await service.sync(item.id);
  assert.deepEqual(calls, [0, 2]);
  const result = service.snapshot().accounts[0];
  assert.equal(result.historyComplete, false); assert.equal(result.historyOffset, 4);
  assert.equal(result.catchupOffset, 2); assert.match(result.catchupWarning, /尚未补齐/);
});

test('successful catchup pages keep an incomplete status until the remaining gap is closed', async t => {
  let round = 0;
  const { service, item } = customService(t, mockMerchant((act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    return { code: 1, data: (round === 0 ? params.start ? [] : [0, 1] : !params.start ? [6, 5] : params.start === 2 ? [4, 3] : [2, 1]).map(i => compatibleRow(i, '1')) };
  }));
  await service.sync(item.id); round = 1; await service.sync(item.id);
  let result = service.snapshot().accounts[0];
  assert.equal(result.catchupOffset, 4); assert.equal(result.lastError, ''); assert.match(result.catchupWarning, /正在补齐/);
  assert.equal(service.telegramAccounts()[0].status, 'incomplete');
  await service.sync(item.id); result = service.snapshot().accounts[0];
  assert.equal(result.catchupOffset, 0); assert.equal(result.catchupWarning, ''); assert.equal(result.lastWarning, '');
  assert.equal(service.telegramAccounts()[0].status, 'healthy'); assert.equal(service.snapshot({ view: 'orders' }).orders.total, 7);
});

test('restarting retains a catchup warning, cursor, and retry cooldown while newest orders keep syncing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T01:00:00Z') });
  let round = 0, available = false, paginationCalls = 0;
  const request = mockMerchant((act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    if (!params.start) return { code: 1, data: (round ? [4, 3] : [0, 1]).map(i => compatibleRow(i, '1')) };
    if (!round) return { code: 1, data: [] };
    paginationCalls++;
    return available ? { code: 1, data: [compatibleRow(2, '1'), compatibleRow(1, '1')] } : { code: -1, msg: '没有API查询权限' };
  });
  const { service, item, db } = customService(t, request);
  await service.sync(item.id); round = 1; await service.sync(item.id);
  const before = service.snapshot().accounts[0]; service.close();
  const restarted = createEpayService({ db, encrypt: value => value, decrypt: value => value, request });
  t.after(() => restarted.close());
  await restarted.sync(item.id);
  let result = restarted.snapshot().accounts[0];
  assert.equal(paginationCalls, 1); assert.equal(result.lastError, '');
  assert.equal(result.catchupWarning, before.catchupWarning); assert.equal(result.catchupOffset, before.catchupOffset);
  assert.equal(result.catchupRetryAt, before.catchupRetryAt);
  available = true; t.mock.timers.tick(60001); await restarted.sync(item.id);
  result = restarted.snapshot().accounts[0];
  assert.equal(paginationCalls, 2); assert.equal(result.catchupOffset, 0); assert.equal(result.catchupWarning, '');
});

test('catchup responses belonging to another merchant remain a hard error', async t => {
  let round = 0;
  const { service, item } = customService(t, mockMerchant((act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    return { code: 1, data: !params.start ? (round ? [4, 3] : [0, 1]).map(i => compatibleRow(i, '1'))
      : round ? [{ ...compatibleRow(2, '1'), pid: '1002' }] : [] };
  }));
  await service.sync(item.id); round = 1; await service.sync(item.id);
  const result = service.snapshot().accounts[0];
  assert.match(result.lastError, /所属商户/); assert.equal(service.store.order(item.id, 'T2'), undefined);
});

test('balance API rejection is separate from primary order errors and cached orders do not hide a real order failure', async t => {
  let failure = '';
  const { service, item } = customService(t, mockMerchant((act) => {
    if (act === failure) return { code: -1, msg: '没有API查询权限' };
    return act === 'query' ? { code: 1, money: '130.00' } : { code: 1, data: [compatibleRow(0, '1')] };
  }));
  await service.sync(item.id);
  failure = 'query'; await service.sync(item.id);
  let result = service.snapshot({ view: 'orders' });
  assert.equal(result.orders.total, 1); assert.equal(result.accounts[0].lastError, '');
  assert.match(result.accounts[0].balanceWarning, /返回码 -1.*查询权限/); assert.equal(result.balances[0].stale, 1);
  failure = 'orders'; await service.sync(item.id);
  result = service.snapshot({ view: 'orders' });
  assert.equal(result.orders.total, 1); assert.match(result.accounts[0].lastError, /读取最新订单失败.*返回码 -1.*查询权限/);
  failure = ''; await service.sync(item.id); assert.equal(service.snapshot().accounts[0].lastError, '');
});

test('a slow balance query cannot delay latest-order writes and a timeout preserves the last valid balance', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T01:00:00Z') });
  let balanceFailure, paid = false;
  const calls = [], sends = [];
  const { service, item } = customService(t, async (_account, _key, act, params) => {
    calls.push(act);
    if (act === 'query') {
      if (!paid) return { code: 1, money: '130.00' };
      return new Promise((_resolve, reject) => { balanceFailure = reject; });
    }
    return { code: 1, data: params.start ? [] : [compatibleRow('paid', paid ? '1' : '0')] };
  }, { bots: () => [{ id: 'bot', enabled: true, tokenEnc: 'token', userIds: ['chat'] }], send: async (_bot, _chat, text) => sends.push(text) });
  service.save({ ...item, key: '', botIds: ['bot'] }, item.id);
  await service.sync(item.id); const balanceAt = service.store.account(item.id).balanceAt;
  paid = true; t.mock.timers.tick(30000);
  const syncing = service.sync(item.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.store.order(item.id, 'Tpaid').status, 'paid');
  assert.equal(service.snapshot({ view: 'orders' }).orders.total, 1);
  balanceFailure(Object.assign(Error('易支付请求超时，请稍后重试'), { epaySafe: true }));
  await syncing; await service.deliver();
  const result = service.snapshot().accounts[0];
  assert.equal(result.lastError, ''); assert.equal(result.failures, 0); assert.equal(result.nextAt, Date.now() + 30000);
  assert.match(result.balanceWarning, /余额刷新失败.*请求超时/);
  assert.equal(result.balance, 13000); assert.equal(result.balanceAt, balanceAt);
  assert.equal(service.snapshot().balances[0].stale, 1);
  assert.equal(service.telegramAccounts()[0].status, 'balance_stale');
  assert.equal(sends.length, 1); assert.match(sends[0], /当前商户余额：<b>¥130.00<\/b>（待刷新）/);
  calls.length = 0; await service.sync(item.id);
  assert.deepEqual(calls, ['orders']); assert.equal(service.store.account(item.id).balanceAt, balanceAt);
});

test('failed balance refresh recovers after cooldown without replaying history, including after restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T01:00:00Z') });
  let available = false, queries = 0;
  const request = async (_account, _key, act, params) => {
    if (act === 'query') { queries++; if (!available) throw Object.assign(Error('易支付请求超时，请稍后重试'), { epaySafe: true }); return { code: 1, money: '140.00' }; }
    return { code: 1, data: params.start ? [] : [compatibleRow(0, '1')] };
  };
  const { service, item, db } = customService(t, request);
  await service.sync(item.id);
  let result = service.snapshot().accounts[0];
  assert.equal(result.lastError, ''); assert.equal(result.initialized, true);
  assert.equal(result.balance, null); assert.equal(result.balanceAt, ''); assert.match(result.balanceWarning, /余额刷新失败/);
  service.close();
  const restarted = createEpayService({ db, encrypt: value => value, decrypt: value => value, request });
  t.after(() => restarted.close());
  await restarted.sync(item.id); assert.equal(queries, 1);
  available = true; t.mock.timers.tick(60001); await restarted.sync(item.id);
  result = restarted.snapshot().accounts[0];
  assert.equal(queries, 2); assert.equal(result.balance, 14000); assert.equal(result.balanceWarning, '');
  assert.equal(result.balanceRetryAt, 0); assert.equal(result.lastWarning, ''); assert.equal(result.lastError, '');
  assert.equal(result.balanceAt, new Date().toISOString()); assert.equal(restarted.snapshot({ view: 'orders' }).orders.total, 1);
  assert.equal(restarted.telegramAccounts()[0].status, 'healthy');
});

test('a successful response with no valid balance never replaces the last valid value or its timestamp', async t => {
  let money = '130.00';
  const { service, item } = customService(t, async (_account, _key, act) => act === 'query' ? { code: 1, money } : { code: 1, data: [] });
  await service.sync(item.id); const balanceAt = service.store.account(item.id).balanceAt;
  money = 'unavailable'; await service.sync(item.id);
  const result = service.snapshot().accounts[0];
  assert.equal(result.balance, 13000); assert.equal(result.balanceAt, balanceAt);
  assert.match(result.balanceWarning, /未返回有效余额/); assert.equal(result.lastError, '');
});

test('editing or deleting a merchant during a balance read cancels it and ignores late results', async t => {
  for (const action of ['edit', 'delete']) {
    let release, requestSignal;
    const { service, item } = customService(t, async (_account, _key, act, _params, options) => {
      if (act === 'query') { requestSignal = options.signal; return new Promise(resolve => { release = resolve; }); }
      return { code: 1, data: [] };
    });
    const syncing = service.sync(item.id); await new Promise(resolve => setImmediate(resolve));
    if (action === 'edit') service.save({ ...item, key: '', note: 'edited' }, item.id);
    else service.remove({ ids: [item.id], confirm: 'delete-records' });
    assert.equal(requestSignal.aborted, true);
    release({ code: 1, money: '999.00' }); await syncing;
    const result = service.store.account(item.id);
    if (action === 'delete') assert.equal(result, null);
    else { assert.equal(result.note, 'edited'); assert.equal(result.balance, null); assert.equal(result.balanceAt, ''); }
  }
});

test('primary order-list rejection remains an error while a successful balance stays fresh', async t => {
  const { service, item } = customService(t, async (_account, _key, act) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    throw Object.assign(Error('订单列表查询失败'), { statusCode: 400 });
  });
  await service.sync(item.id);
  const snapshot = service.snapshot(), result = snapshot.accounts[0];
  assert.match(result.lastError, /订单列表查询失败/); assert.equal(result.initialized, false);
  assert.equal(result.lastSyncAt, ''); assert.equal(snapshot.balances[0].stale, 0);
});

test('supplemental responses from a different merchant are still rejected as integrity errors', async t => {
  const { service, item } = customService(t, async (_account, _key, act, params) => {
    if (act === 'query') return { code: 1, money: '130.00' };
    if (act === 'orders') return { code: 1, data: params.start ? [] : [compatibleRow('new', '1')] };
    return { code: 1, ...compatibleRow('old', '1'), pid: '1002' };
  });
  service.store.mergeOrders(item, [normalizeEpayOrder(compatibleRow('old'), '1001')], [], () => false, Date.now() - 1000);
  await service.sync(item.id);
  assert.match(service.snapshot().accounts[0].lastError, /所属商户/);
  assert.equal(service.store.order(item.id, 'Told').status, 'pending');
});
