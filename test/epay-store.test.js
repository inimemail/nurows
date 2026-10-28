import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createEpayStore } from '../server/epay-store.js';
import { normalizeEpayOrder } from '../server/epay.js';

const row = (trade_no, status = 1, money = '2.50', endtime = '2026-10-28 10:00:00') => normalizeEpayOrder({
  trade_no, status, money, endtime, addtime: '2026-10-28 09:00:00', name: '服务', type: 'alipay'
}, '1001');
function setup(t) {
  const queries = [], db = new Database(':memory:', { verbose: value => queries.push(value) });
  t.after(() => db.close());
  const store = createEpayStore(db);
  const merge = rows => store.mergeOrders({ id: 'account' }, rows, [], () => false, Date.now());
  return { db, store, merge, queries };
}

test('incremental money totals stay exact across payment, correction, refund, duplicates and removal', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T06:00:00Z') });
  const { store, merge } = setup(t);
  merge([row('one', 0), row('two', 1, '3.00')]);
  assert.deepEqual(store.totals()[0], { accountId: 'account', orders: 2, total: 300, paidCount: 1, pendingCount: 1, refundedCount: 0, today: 300, yesterday: 0, month: 300 });
  merge([row('one', 1)]); merge([row('one', 1)]);
  assert.equal(store.totals()[0].total, 550);
  merge([row('one', 1, '2.75', '2026-10-27 11:00:00')]);
  assert.equal(store.totals()[0].today, 300);
  assert.equal(store.totals()[0].yesterday, 275);
  assert.equal(store.totals()[0].total, 575);
  merge([row('two', 2, '3.00')]);
  assert.deepEqual(store.totals()[0], { accountId: 'account', orders: 2, total: 275, paidCount: 1, pendingCount: 0, refundedCount: 1, today: 0, yesterday: 275, month: 275 });
  // An old unpaid response cannot reverse a confirmed payment or its totals.
  merge([row('one', 0, '2.75')]); assert.equal(store.totals()[0].total, 275);
  store.remove(['account']); assert.deepEqual(store.totals(), []);
});

test('accounting reads use bounded daily rollups and unchanged paid snapshots do not write', t => {
  const { db, store, merge, queries } = setup(t);
  merge([row('one')]); store.totals();
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  const result = merge([row('one')]);
  assert.equal(result.changed, false);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  merge([row('two')]); queries.length = 0; store.totals();
  assert.ok(queries.some(query => query.includes('FROM epay_totals')));
  assert.ok(queries.every(query => !query.includes('FROM epay_orders')));
  queries.length = 0; store.totals(); assert.equal(queries.length, 0);
});

test('existing order ledgers migrate once and service restarts never recount payments', t => {
  const { db, store, merge } = setup(t);
  merge([row('one'), row('two', 0)]);
  const expected = store.totals();
  db.exec('DROP TABLE epay_daily; DROP TABLE epay_totals;');
  const upgraded = createEpayStore(db);
  assert.deepEqual(upgraded.totals(), expected);
  assert.deepEqual(createEpayStore(db).totals(), expected);
  upgraded.mergeOrders({ id: 'account' }, [row('two', 1)], [], () => false, Date.now());
  assert.equal(upgraded.totals()[0].total, 500);
});

test('a failed order batch rolls back both the ledger and cumulative totals', t => {
  const { db, store, merge } = setup(t);
  merge([row('one')]); const expected = store.totals();
  db.exec(`CREATE TRIGGER reject_test BEFORE INSERT ON epay_orders WHEN NEW.trade_no='reject'
    BEGIN SELECT RAISE(ABORT,'test write failure'); END;`);
  assert.throws(() => merge([row('two'), row('reject')]), /test write failure/);
  assert.equal(store.order('account', 'two'), undefined);
  assert.deepEqual(store.totals(), expected);
  assert.deepEqual(createEpayStore(db).totals(), expected);
});

test('daily totals refresh across Beijing midnight and the first day of a new month', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T15:59:00Z') });
  const { store, merge } = setup(t);
  merge([row('one', 1, '2.50', '2026-10-31 23:00:00')]);
  assert.equal(store.totals()[0].today, 250); assert.equal(store.totals()[0].month, 250);
  t.mock.timers.setTime(Date.parse('2026-10-31T16:01:00Z'));
  assert.equal(store.totals()[0].today, 0); assert.equal(store.totals()[0].yesterday, 250);
  assert.equal(store.totals()[0].month, 0); assert.equal(store.totals()[0].total, 250);
});

test('notification cleanup is bounded and never deletes outstanding delivery or financial orders', t => {
  const { db, store, merge } = setup(t);
  merge([row('one')]);
  const insert = db.prepare(`INSERT INTO epay_notifications(account_id,trade_no,bot_id,chat_id,state,next_at,created) VALUES('account',?,'bot','chat',?,0,0)`);
  db.transaction(() => { for (let i = 0; i < 600; i++) insert.run(String(i), 'cancelled'); insert.run('outstanding', 'pending'); })();
  store.prune(Date.now());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM epay_notifications').get().n, 101);
  store.prune(Date.now());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM epay_notifications').get().n, 1);
  assert.equal(store.due(Date.now())[0].trade_no, 'outstanding');
  assert.equal(store.order('account', 'one').cents, 250);
  assert.equal(store.totals()[0].total, 250);
});
