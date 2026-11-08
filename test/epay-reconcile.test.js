import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createEpayService, normalizeEpayOrder } from '../server/epay.js';

const raw = (id, status = 1) => ({ pid: '1001', trade_no: id, money: '2.50', status, addtime: '2026-11-09 09:00:00', endtime: '2026-11-09 09:01:00' });
function setup(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T02:00:00Z') });
  const db = new Database(':memory:'); t.after(() => db.close());
  let rows = [raw('deleted'), raw('kept')], detail = 'missing';
  const calls = [];
  const service = createEpayService({ db, encrypt: x => x, decrypt: x => x, request: async (_, _key, act, params = {}) => {
    calls.push([act, params]);
    if (act === 'query') return { money: '100.00' };
    if (act === 'orders') return { data: rows.slice(params.start, params.start + params.limit) };
    if (detail === 'timeout') throw Object.assign(Error('timeout'), { epaySafe: true });
    if (detail === 'denied') throw Object.assign(Error('no permission'), { statusCode: 400 });
    const row = rows.find(row => row.trade_no === params.trade_no);
    if (row) return row;
    if (detail === 'mismatch') return raw('wrong');
    throw Object.assign(Error('订单不存在'), { epayOrderMissing: true });
  } });
  const item = service.save({ name: '商户', url: 'https://pay.example.com', pid: '1001', key: 'key', interval: 15 });
  const due = () => service.store.saveAccount({ ...service.store.account(item.id), historyComplete: true, reconcileNextAt: 0 });
  const next = ms => t.mock.timers.tick(ms);
  return { db, service, item, calls, due, next, rows(value) { rows = value; }, detail(value) { detail = value; } };
}

test('remote deletion needs a complete scan and two explicit absences; totals and pending notices update atomically', async t => {
  const e = setup(t); await e.service.sync(e.item.id);
  e.db.prepare("INSERT INTO epay_notifications(account_id,trade_no,bot_id,chat_id,state,next_at,created) VALUES(?, 'deleted','bot','chat','pending',0,0)").run(e.item.id);
  e.rows([raw('kept')]); e.due();
  await e.service.sync(e.item.id); // full candidate scan
  assert.ok(e.service.store.order(e.item.id, 'deleted'));
  await e.service.sync(e.item.id); // first explicit absence
  await e.service.sync(e.item.id); // no immediate second call
  assert.equal(e.calls.filter(([act]) => act === 'order').length, 1);
  assert.ok(e.service.store.order(e.item.id, 'deleted'));
  e.next(60001); await e.service.sync(e.item.id);
  assert.equal(e.service.store.order(e.item.id, 'deleted'), undefined);
  assert.equal(e.service.store.totals()[0].total, 250); assert.equal(e.service.store.totals()[0].today, 250);
  assert.equal(e.service.store.totals()[0].orders, 1);
  assert.equal(e.db.prepare("SELECT state FROM epay_notifications WHERE trade_no='deleted'").get().state, 'cancelled');
  assert.ok(e.service.store.account(e.item.id).reconciledAt);
  // Even after seven-day notification pruning, a reappearing paid order is not
  // treated as a fresh receipt. Only a minimal deletion tombstone is kept.
  e.service.store.mergeOrders(e.item, [normalizeEpayOrder(raw('deleted'), '1001')], [{ botId: 'new', chatId: 'chat' }], () => true, Date.now());
  assert.equal(e.db.prepare("SELECT COUNT(*) AS n FROM epay_notifications WHERE bot_id='new'").get().n, 0);
});

test('timeouts, permission errors and a different order response never authorize deletion', async t => {
  const e = setup(t); await e.service.sync(e.item.id); e.rows([]); e.due(); await e.service.sync(e.item.id);
  for (const failure of ['timeout', 'denied', 'mismatch']) {
    e.detail(failure); e.next(300001); await e.service.sync(e.item.id);
    assert.ok(e.service.store.order(e.item.id, 'deleted')); assert.equal(e.service.store.totals()[0].total, 500);
  }
});

test('an order reappearing in the latest page clears a deletion suspicion', async t => {
  const e = setup(t); await e.service.sync(e.item.id); e.rows([]); e.due(); await e.service.sync(e.item.id); await e.service.sync(e.item.id);
  e.rows([raw('deleted'), raw('kept')]); e.next(60001); await e.service.sync(e.item.id);
  assert.equal(e.service.store.totals()[0].orders, 2);
  assert.ok(e.service.store.account(e.item.id).reconciledAt);
});

test('reconciliation is delayed thirty minutes, paginated and bounded to two confirmations per sync', async t => {
  const e = setup(t); e.rows(Array.from({ length: 60 }, (_, i) => raw(String(i))));
  await e.service.sync(e.item.id); await e.service.sync(e.item.id);
  assert.equal(e.service.store.orders({ accountId: e.item.id }).total, 60);
  assert.equal(e.service.store.account(e.item.id).reconcileId, undefined);
  e.rows([]); e.next(1800001); await e.service.sync(e.item.id); e.calls.length = 0;
  await e.service.sync(e.item.id);
  assert.equal(e.calls.filter(([act]) => act === 'order').length, 2);
  assert.equal(e.service.store.orders({ accountId: e.item.id }).total, 60);
  const plan = e.db.prepare("EXPLAIN QUERY PLAN SELECT trade_no FROM epay_order_audit WHERE account_id=? AND generation='' AND next_at<=? ORDER BY next_at,trade_no LIMIT 2").all(e.item.id, Date.now());
  assert.ok(plan.some(row => row.detail.includes('epay_audit_due')));
});

test('a restart preserves deletion confirmations and never resurrects removed orders', async t => {
  const e = setup(t); await e.service.sync(e.item.id); e.rows([raw('kept')]); e.due();
  await e.service.sync(e.item.id); await e.service.sync(e.item.id);
  assert.ok(e.service.store.order(e.item.id, 'deleted')); e.service.close(); e.next(60001);
  const restarted = createEpayService({ db: e.db, encrypt: x => x, decrypt: x => x, request: async (_, _key, act, params) => {
    if (act === 'query') return { money: '100' };
    if (act === 'orders') return { data: [raw('kept')] };
    if (params.trade_no === 'kept') return raw('kept');
    throw Object.assign(Error('订单不存在'), { epayOrderMissing: true });
  } });
  await restarted.sync(e.item.id);
  assert.equal(restarted.store.order(e.item.id, 'deleted'), undefined);
  assert.equal(restarted.store.totals()[0].total, 250); restarted.close();
});

test('unsupported pagination retains all local orders', async t => {
  const e = setup(t); await e.service.sync(e.item.id); e.rows([]); e.due();
  e.service.store.saveAccount({ ...e.service.store.account(e.item.id), historyUnsupported: true });
  await e.service.sync(e.item.id);
  assert.match(e.service.store.account(e.item.id).reconcileWarning, /不支持可靠分页/);
  assert.equal(e.calls.filter(([act]) => act === 'order').length, 0);
  assert.equal(e.service.store.totals()[0].total, 500);
});

test('editing a merchant during a pending second confirmation ignores the late missing-order response', async t => {
  const e = setup(t); await e.service.sync(e.item.id); e.rows([]); e.due(); await e.service.sync(e.item.id); await e.service.sync(e.item.id);
  e.next(60001); e.service.close(); let reject, signal;
  const service = createEpayService({ db: e.db, encrypt: x => x, decrypt: x => x, request: async (_, _key, act, _params, options) => {
    if (act === 'query') return { money: '100' };
    if (act === 'orders') return { data: [] };
    signal = options.signal; return new Promise((_resolve, no) => { reject = no; });
  } });
  const pending = service.sync(e.item.id); await new Promise(resolve => setImmediate(resolve));
  service.save({ ...service.store.account(e.item.id), key: '', note: 'edited during audit' }, e.item.id);
  assert.equal(signal.aborted, true); reject(Object.assign(Error('订单不存在'), { epayOrderMissing: true })); await pending;
  assert.equal(service.store.totals()[0].orders, 2); assert.ok(service.store.order(e.item.id, 'deleted'));
  assert.equal(service.store.account(e.item.id).note, 'edited during audit'); service.close();
});

test('new orders during a multi-page audit shift its cursor without falsely reporting repeated pagination', async t => {
  const e = setup(t), history = Array.from({ length: 6 }, (_, i) => raw(String(i)));
  e.rows(history); await e.service.sync(e.item.id); e.due();
  e.service.store.saveAccount({ ...e.service.store.account(e.item.id), pageSize: 2 });
  await e.service.sync(e.item.id); assert.equal(e.service.store.account(e.item.id).reconcileOffset, 2);
  e.rows([raw('new-1'), raw('new-2'), ...history]);
  await e.service.sync(e.item.id);
  assert.equal(e.service.store.account(e.item.id).reconcileOffset, 6);
  assert.equal(e.service.store.account(e.item.id).reconcileWarning, '');
  for (let i = 0; i < 3; i++) await e.service.sync(e.item.id);
  assert.equal(e.service.store.totals()[0].orders, 8); assert.ok(e.service.store.account(e.item.id).reconciledAt);
  assert.equal(e.calls.filter(([act]) => act === 'order').length, 0);
});
