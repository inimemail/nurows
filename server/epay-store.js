import { epayDay } from '../shared/epay.js';

export function createEpayStore(db) {
  const hasTotals = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='epay_totals'").get());
  db.exec(`
    CREATE TABLE IF NOT EXISTS epay_accounts (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS epay_orders (
      account_id TEXT NOT NULL, trade_no TEXT NOT NULL, out_trade_no TEXT NOT NULL, name TEXT NOT NULL,
      channel TEXT NOT NULL, cents INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      paid_at TEXT NOT NULL, paid_day TEXT NOT NULL, first_seen INTEGER NOT NULL, checked_at INTEGER NOT NULL,
      PRIMARY KEY(account_id,trade_no));
    CREATE INDEX IF NOT EXISTS epay_order_time ON epay_orders(created_at DESC,trade_no);
    CREATE INDEX IF NOT EXISTS epay_order_account_time ON epay_orders(account_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS epay_order_pending ON epay_orders(account_id,status,checked_at);
    CREATE INDEX IF NOT EXISTS epay_order_paid_day ON epay_orders(status,paid_day,account_id);
    CREATE TABLE IF NOT EXISTS epay_notifications (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, trade_no TEXT NOT NULL,
      bot_id TEXT NOT NULL, chat_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, created INTEGER NOT NULL,
      UNIQUE(account_id,trade_no,bot_id,chat_id));
    CREATE INDEX IF NOT EXISTS epay_notification_due ON epay_notifications(state,next_at);
    CREATE INDEX IF NOT EXISTS epay_notification_retention ON epay_notifications(created);
    UPDATE epay_notifications SET state='uncertain' WHERE state='sending';
  `);
  // Build the rollups once for existing installations. Their updates and order
  // writes share one transaction, so a crash cannot leave money counted twice.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS epay_totals (
        account_id TEXT PRIMARY KEY, orders INTEGER NOT NULL, total INTEGER NOT NULL,
        paid_count INTEGER NOT NULL, pending_count INTEGER NOT NULL, refunded_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS epay_daily (
        account_id TEXT NOT NULL, paid_day TEXT NOT NULL, cents INTEGER NOT NULL,
        PRIMARY KEY(account_id,paid_day));
      CREATE INDEX IF NOT EXISTS epay_daily_day ON epay_daily(paid_day,account_id);
    `);
    if (!hasTotals) db.exec(`
      INSERT INTO epay_totals SELECT account_id,COUNT(*),
        SUM(CASE WHEN status='paid' THEN cents ELSE 0 END),
        SUM(status='paid'),SUM(status='pending'),SUM(status='refunded')
        FROM epay_orders GROUP BY account_id;
      INSERT INTO epay_daily SELECT account_id,paid_day,SUM(cents)
        FROM epay_orders WHERE status='paid' AND paid_day<>'' GROUP BY account_id,paid_day;
    `);
  })();
  const statements = new Map();
  const sql = query => { if (!statements.has(query)) statements.set(query, db.prepare(query)); return statements.get(query); };
  const account = id => { const row = sql('SELECT body FROM epay_accounts WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; };
  let totalsCache = null;
  const invalidate = () => { totalsCache = null; };
  const saveAccount = item => sql('INSERT INTO epay_accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity,body=excluded.body').run(item.id, `${item.url}|${item.pid}`, JSON.stringify(item));
  const order = (accountId, tradeNo) => sql('SELECT * FROM epay_orders WHERE account_id=? AND trade_no=?').get(accountId, tradeNo);
  function totals() {
    const day = epayDay(), yesterday = epayDay(Date.now() - 86400000), month = day.slice(0, 7);
    if (totalsCache?.day === day) return totalsCache.rows;
    const monthStart = `${month}-01`, since = yesterday < monthStart ? yesterday : monthStart;
    const nextMonth = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const rows = sql(`SELECT t.account_id AS accountId,t.orders,t.total,t.paid_count AS paidCount,
      t.pending_count AS pendingCount,t.refunded_count AS refundedCount,
      COALESCE(d.today,0) AS today,COALESCE(d.yesterday,0) AS yesterday,COALESCE(d.month,0) AS month
      FROM epay_totals t LEFT JOIN (SELECT account_id,
        SUM(CASE WHEN paid_day=? THEN cents ELSE 0 END) AS today,
        SUM(CASE WHEN paid_day=? THEN cents ELSE 0 END) AS yesterday,
        SUM(CASE WHEN paid_day LIKE ? THEN cents ELSE 0 END) AS month
        FROM epay_daily WHERE paid_day>=? AND paid_day<? GROUP BY account_id
      ) d ON d.account_id=t.account_id`).all(day, yesterday, `${month}%`, since, nextMonth);
    totalsCache = { day, rows }; return rows;
  }
  function adjustTotals(id, row, old) {
    const paid = value => value?.status === 'paid' ? value.cents : 0;
    const delta = status => Number(row.status === status) - Number(old?.status === status);
    sql(`INSERT INTO epay_totals VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
      orders=orders+excluded.orders,total=total+excluded.total,paid_count=paid_count+excluded.paid_count,
      pending_count=pending_count+excluded.pending_count,refunded_count=refunded_count+excluded.refunded_count`)
      .run(id, old ? 0 : 1, paid(row) - paid(old), delta('paid'), delta('pending'), delta('refunded'));
    if (old?.status === row.status && old?.cents === row.cents && old?.paid_day === row.paid_day) return;
    const adjustDay = (value, sign) => {
      if (value?.status !== 'paid' || !value.paid_day) return;
      sql(`INSERT INTO epay_daily VALUES(?,?,?) ON CONFLICT(account_id,paid_day) DO UPDATE SET cents=cents+excluded.cents`)
        .run(id, value.paid_day, sign * value.cents);
    };
    adjustDay(old, -1); adjustDay(row, 1);
  }
  function mergeOrders(item, rows, recipients, shouldNotify, now) {
    let known = 0, changed = false;
    db.transaction(() => {
      for (const row of rows) {
        const old = order(item.id, row.trade_no);
        if (old) known++;
        // A late unpaid snapshot must never downgrade a confirmed payment.
        if (old && ['paid', 'refunded'].includes(old.status) && ['pending', 'unknown'].includes(row.status)) row.status = old.status;
        if (old?.paid_at && !row.paid_at) { row.paid_at = old.paid_at; row.paid_day = old.paid_day; }
        const different = !old || ['status', 'cents', 'name', 'created_at', 'paid_at', 'paid_day', 'channel', 'out_trade_no'].some(key => old[key] !== row[key]);
        if (!different) {
          // Only unresolved orders need a last-checked cursor. Repeated paid
          // snapshots should not rewrite historical rows or their indexes.
          if (old.status === 'pending') sql('UPDATE epay_orders SET checked_at=? WHERE account_id=? AND trade_no=?').run(now, item.id, row.trade_no);
          continue;
        }
        sql(`INSERT INTO epay_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,trade_no) DO UPDATE SET
          out_trade_no=excluded.out_trade_no,name=excluded.name,channel=excluded.channel,cents=excluded.cents,
          status=excluded.status,created_at=excluded.created_at,paid_at=excluded.paid_at,paid_day=excluded.paid_day,checked_at=excluded.checked_at`)
          .run(item.id, row.trade_no, row.out_trade_no, row.name, row.channel, row.cents, row.status, row.created_at, row.paid_at, row.paid_day, old?.first_seen || now, now);
        adjustTotals(item.id, row, old);
        changed = true;
        if (row.status === 'paid' && old?.status !== 'paid' && old?.status !== 'refunded' && shouldNotify(row, old)) {
          for (const recipient of recipients) sql(`INSERT OR IGNORE INTO epay_notifications(account_id,trade_no,bot_id,chat_id,state,next_at,created) VALUES(?,?,?,?,'pending',?,?)`)
            .run(item.id, row.trade_no, recipient.botId, recipient.chatId, now, now);
        }
      }
    })();
    if (changed) invalidate();
    return { known, changed };
  }
  function orders({ accountId = '', search = '', status = '', from = '', to = '', page = 1 } = {}) {
    const clauses = [], params = [];
    if (accountId) { clauses.push('account_id=?'); params.push(accountId); }
    if (status) { clauses.push('status=?'); params.push(status); }
    if (from) { clauses.push('created_at>=?'); params.push(new Date(`${from}T00:00:00+08:00`).toISOString()); }
    if (to) { clauses.push('created_at<?'); params.push(new Date(Date.parse(`${to}T00:00:00+08:00`) + 86400000).toISOString()); }
    if (search) { clauses.push("(name LIKE ? ESCAPE '\\' OR trade_no LIKE ? ESCAPE '\\' OR out_trade_no LIKE ? ESCAPE '\\')");
      const query = `%${String(search).slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`; params.push(query, query, query); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = sql(`SELECT COUNT(*) AS n FROM epay_orders${where}`).get(...params).n, pages = Math.max(1, Math.ceil(total / 30));
    page = Math.max(1, Math.min(pages, Number.isSafeInteger(Number(page)) ? Number(page) : 1));
    return { records: sql(`SELECT * FROM epay_orders${where} ORDER BY created_at DESC,trade_no DESC LIMIT 30 OFFSET ?`).all(...params, (page - 1) * 30), total, page, pages };
  }
  return {
    account, saveAccount, orders, order, totals, mergeOrders,
    accounts: () => sql('SELECT body FROM epay_accounts ORDER BY rowid DESC').all().map(row => JSON.parse(row.body)),
    pending: id => sql("SELECT trade_no FROM epay_orders WHERE account_id=? AND status='pending' ORDER BY checked_at LIMIT 2").all(id),
    due: now => sql("SELECT * FROM epay_notifications WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 10").all(now),
    notification(id, state, next = 0) { sql('UPDATE epay_notifications SET state=?,attempts=attempts+1,next_at=? WHERE id=?').run(state, next, id); },
    notificationSummary: () => sql("SELECT state,COUNT(*) AS count FROM epay_notifications WHERE state IN ('pending','uncertain','failed') GROUP BY state").all(),
    remove(ids) { db.transaction(() => { for (const id of ids) {
      for (const table of ['epay_notifications', 'epay_orders', 'epay_daily', 'epay_totals']) sql(`DELETE FROM ${table} WHERE account_id=?`).run(id);
      sql('DELETE FROM epay_accounts WHERE id=?').run(id);
    } })(); invalidate(); },
    prune(now) { sql("DELETE FROM epay_notifications WHERE id IN (SELECT id FROM epay_notifications WHERE state IN ('sent','cancelled','failed','uncertain') AND created<? LIMIT 500)").run(now - 7 * 86400000); }
  };
}
