import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createEpayService, normalizeEpayOrder, epayReceiptMessage } from '../server/epay.js';
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

test('account snapshots skip the order ledger query', async t => {
  const env = setup(t, '0');
  const item = env.service.save({ name: '账号页', url: 'https://pay.example.com/', pid: '1001', key: 'secret' });
  await env.service.sync(item.id);
  env.service.store.orders = () => { throw new Error('order query should be skipped'); };
  const snapshot = env.service.snapshot({ view: 'accounts' });
  assert.deepEqual(snapshot.orders, { records: [], total: 0, page: 1, pages: 1 });
  assert.equal(snapshot.accounts.length, 1);
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
function customService(t, request) {
  const db = new Database(':memory:'); t.after(() => db.close());
  const service = createEpayService({ db, encrypt: value => value, decrypt: value => value, request });
  const item = service.save({ name: '兼容站点', url: 'https://pay.example.com/', pid: '1001', key: 'secret' });
  return { service, item };
}

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
