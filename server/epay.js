import { randomUUID } from 'node:crypto';
import { createEpayStore } from './epay-store.js';
import { normalizeEpayUrl, requestEpay } from './epay-api.js';
import { bulkDeleteIds } from './bulk-delete.js';
import { EPAY_CURRENCIES, EPAY_CHANNELS, EPAY_STATUSES, epayCents, epayBalanceCents, epayDate, epayDay, epayMoney, epayOrderStatus } from '../shared/epay.js';

const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const clean = (value, max = 120) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
const safe = item => { const { keyEnc, ...rest } = item; return { ...rest, configured: Boolean(keyEnc) }; };
const escape = value => clean(value, 200).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const snapshotFields = ['lastSyncAt', 'lastAttemptAt', 'balanceAt', 'balance', 'balanceWarning', 'balanceRetryAt', 'failures', 'nextAt', 'lastError', 'lastWarning', 'historyWarning', 'orderWarning', 'catchupWarning', 'historyRetryAt', 'orderRetryAt', 'catchupRetryAt', 'initialized', 'historyOffset', 'historyComplete', 'historyUnsupported', 'historySignature', 'pageSize', 'catchupOffset'];

export function normalizeEpayOrder(input, pid) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('订单接口返回了无效记录');
  if (input.pid !== undefined && String(input.pid) !== String(pid)) throw Object.assign(Error('订单所属商户与配置不符，已停止同步'), { statusCode: 400, epayIntegrity: true });
  const trade_no = clean(input.trade_no || input.out_trade_no, 128), cents = epayCents(input.money);
  if (!trade_no || cents === null) fail('订单缺少有效订单号或金额，未计入统计');
  const created_at = epayDate(input.addtime || input.created_at), paid_at = epayDate(input.endtime || input.paid_at);
  if (!created_at) fail('订单创建时间无效，未计入统计');
  return { trade_no, out_trade_no: clean(input.out_trade_no, 128), name: clean(input.name, 200), channel: clean(input.type, 40),
    cents, status: epayOrderStatus(input.status), created_at, paid_at, paid_day: paid_at ? epayDay(paid_at) : '' };
}

export function epayBalanceGroups(accounts, now = Date.now()) {
  const groups = new Map();
  for (const item of accounts) {
    const group = groups.get(item.currency) || { currency: item.currency, balance: 0, known: 0, total: 0, stale: 0 };
    group.total++;
    if (Number.isSafeInteger(item.balance)) {
      group.balance += item.balance; group.known++;
      // Order/history failures must not label a freshly read balance as stale.
      if (item.balanceWarning || !Number.isFinite(Date.parse(item.balanceAt || '')) || now - Date.parse(item.balanceAt) > Math.max(item.interval * 3000, 120000)) group.stale++;
    }
    groups.set(item.currency, group);
  }
  return [...groups.values()].map(group => ({ ...group, balance: group.known ? group.balance : null }));
}

export function epayReceiptMessage(account, order, accounts) {
  const balance = epayBalanceGroups(accounts).map(group => `${epayMoney(group.balance, group.currency)}${group.known < group.total ? `（仅 ${group.known}/${group.total} 个账号）` : ''}${group.stale ? ` · ${group.stale} 个余额待刷新` : ''}`).join(' / ') || '暂无账号';
  return ['💰 <b>易支付 · 收款成功</b>', '', `🏷 商户：${escape(account.name)}`,
    `💵 金额：<b>${epayMoney(order.cents, account.currency)}</b> · ${escape(EPAY_CHANNELS[order.channel] || order.channel || '其他方式')}`,
    `📦 商品：${escape(order.name || '未提供')}`, `🧾 订单：<code>${escape(order.trade_no)}</code>`, '',
    `🏦 当前商户余额：<b>${epayMoney(account.balance, account.currency)}</b>${epayBalanceGroups([account])[0]?.stale ? '（待刷新）' : ''}`,
    `💎 全部商户总余额：<b>${balance}</b>`, '余额为各接口最近一次查询结果，不是累计收款额。', '',
    `🕒 支付时间：${order.paid_at ? new Date(order.paid_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '接口未提供'}`].join('\n');
}

export function createEpayService(deps) {
  const store = createEpayStore(deps.db), running = new Map();
  const request = deps.request || requestEpay;
  // Revalidate legacy generic and balance-only failures through the bounded
  // scheduler after an upgrade instead of preserving a 15-minute order backoff.
  // Keep the error until a successful sync; paused accounts and actual order
  // failures retain their existing retry schedule.
  for (const item of store.accounts()) {
    const legacyError = item.lastError === '易支付查询失败，请检查商户号、密钥以及商户 API 查询权限' || item.lastError?.startsWith('读取商户余额失败：');
    if (item.enabled && legacyError && item.nextAt) {
      store.saveAccount({ ...item, nextAt: 0 });
    }
  }
  let activeTests = 0, sending = false, cursor = 0, lastPrune = 0, accountCache = null;
  const accounts = () => accountCache ||= store.accounts();
  const invalidate = () => { accountCache = null; };
  const bots = () => deps.bots?.() || [];
  const requireAccount = id => store.account(id) || fail('易支付商户不存在', 404);
  function normalize(input, old) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('商户配置无效');
    const name = clean(input.name), url = normalizeEpayUrl(input.url), pid = String(input.pid ?? '').trim(), key = String(input.key || '').trim();
    if (!name || String(input.name).length > 120) fail('请填写商户名称，最多 120 字符');
    if (!/^\d{1,20}$/.test(pid)) fail('商户号应为 1–20 位数字');
    if ((!key && !old?.keyEnc) || key.length > 512 || /\s/.test(key)) fail('请填写有效的商户密钥，最多 512 字符');
    if (old && (old.url !== url || old.pid !== pid)) fail('网站或商户号不能直接修改，请新增账号以免混合订单数据');
    const interval = Number(input.interval ?? 30);
    if (!Number.isInteger(interval) || interval < 15 || interval > 3600) fail('监听间隔应为 15–3600 秒的整数');
    if (!EPAY_CURRENCIES.includes(input.currency || 'CNY')) fail('请选择支持的币种');
    if (old && old.currency !== (input.currency || 'CNY')) fail('已有账号的币种不能修改，请新增账号');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('监听开关值无效');
    const botIds = Array.isArray(input.botIds) ? [...new Set(input.botIds)] : [];
    if (botIds.length > 20 || botIds.some(id => typeof id !== 'string' || !bots().some(bot => bot.id === id))) fail('请选择有效的通知机器人');
    return { name, url, pid, interval, currency: input.currency || 'CNY', enabled: input.enabled !== false, botIds,
      note: clean(input.note, 500), keyEnc: key ? deps.encrypt(key) : old.keyEnc };
  }
  function save(input, id = '') {
    const old = id ? requireAccount(id) : null;
    if (old && input.version !== old.version) fail('商户配置已更新，请重新打开编辑', 409);
    const config = normalize(input, old), all = accounts();
    if (!old && all.length >= 100) fail('最多添加 100 个商户账号');
    if (all.some(item => item.id !== id && (item.name.toLowerCase() === config.name.toLowerCase() || item.url === config.url && item.pid === config.pid))) fail('商户名称或网站与商户号已存在，请勿重复添加', 409);
    running.get(id)?.abort();
    const now = Date.now(), item = { initialized: false, historyOffset: 0, historyComplete: false, historyUnsupported: false,
      balance: null, balanceAt: '', lastSyncAt: '', lastError: '', failures: 0, pageSize: 50, catchupOffset: 0,
      ...old, ...config, id: old?.id || randomUUID(), version: randomUUID(), createdAt: old?.createdAt || new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(), nextAt: now };
    if (input.key) Object.assign(item, { balanceRetryAt: 0, balanceWarning: '', historyRetryAt: 0, orderRetryAt: 0, catchupRetryAt: 0, historyWarning: '', orderWarning: '', catchupWarning: '', lastWarning: '' });
    store.saveAccount(item); invalidate(); return safe(item);
  }
  async function test(input, id = '', options = {}) {
    if (activeTests >= 3) fail('正在测试其他商户，请稍后重试', 429);
    const old = id ? requireAccount(id) : null, config = normalize(input, old);
    activeTests++;
    try {
      const signal = AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(20000)]);
      signal.throwIfAborted();
      const key = deps.decrypt(config.keyEnc);
      if (!key) fail('商户密钥无法解密，请重新填写');
      const info = await request(config, key, 'query', {}, { signal });
      signal.throwIfAborted();
      const result = await request(config, key, 'orders', { limit: 1, num: 1, page: 1, start: 0 }, { signal });
      signal.throwIfAborted();
      if (!Array.isArray(result.data)) fail('商户信息可读取，但订单列表接口不兼容');
      return { ok: true, balance: epayBalanceCents(info.money ?? info.balance), currency: config.currency, message: '连接成功，商户信息与订单查询接口均可用' };
    } catch (error) { throw Object.assign(Error(error.statusCode === 400 ? error.message : '连接测试失败，请检查商户 API、密钥和网络'), { statusCode: 400 }); }
    finally { activeTests--; }
  }
  function patch(id, version, fields) {
    const current = store.account(id);
    if (!current || current.version !== version) return false;
    store.saveAccount({ ...current, ...fields }); invalidate(); return true;
  }
  function recipients(item) {
    return bots().filter(bot => item.botIds.includes(bot.id) && bot.enabled !== false && bot.tokenEnc)
      .flatMap(bot => [...new Set(bot.userIds || [])].map(chatId => ({ botId: bot.id, chatId: String(chatId) })));
  }
  async function sync(id) {
    if (running.has(id) || running.size >= 3) return false;
    let item = requireAccount(id);
    if (!item.enabled) return false;
    const controller = new AbortController(); running.set(id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]), version = item.version;
    const valid = () => !signal.aborted && store.account(id)?.version === version;
    let stage = '读取最新订单', balanceTask;
    const balanceController = new AbortController();
    try {
      const key = deps.decrypt(item.keyEnc);
      if (!key) fail('商户密钥无法解密，请重新填写');
      const now = Date.now();
      if ((item.balanceRetryAt || 0) <= now) {
        // Balance is independent of the order ledger. Start both requests in
        // this merchant's existing slot and handle rejection immediately, so a
        // slow balance endpoint cannot prevent the latest orders being saved.
        const balanceSignal = AbortSignal.any([signal, balanceController.signal]);
        balanceTask = Promise.resolve().then(() => request(item, key, 'query', {}, { signal: balanceSignal }))
          .then(info => ({ info, at: new Date().toISOString(), cancelled: balanceSignal.aborted }), error => ({ error, cancelled: balanceController.signal.aborted || controller.signal.aborted }));
      }
      const notifyRecipients = recipients(item), created = Date.parse(item.createdAt), fetched = new Set();
      const shouldNotify = (row, old) => {
        if (!item.initialized) return false;
        if (row.paid_at && Date.parse(row.paid_at) >= created) return true;
        // Initial paid history is a baseline, not a new collection event.
        return item.initialized && Boolean(old?.status === 'pending');
      };
      const fetchPage = async (offset, history = false) => {
        const size = item.pageSize || 50;
        stage = history ? '补查历史订单' : offset ? '补查期间订单' : '读取最新订单';
        const result = await request(item, key, 'orders', { limit: size, num: size, page: Math.floor(offset / size) + 1, start: offset }, { signal });
        if (!valid()) throw Error('configuration changed');
        if (!Array.isArray(result.data) || result.data.length > 1000) fail('易支付订单列表格式不兼容');
        const rows = result.data.map(row => normalizeEpayOrder(row, item.pid));
        // Some legacy installations cap pages below the requested limit.
        if (!item.initialized && offset === 0 && rows.length && rows.length < size) item.pageSize = rows.length;
        const signature = rows.length ? `${rows[0].trade_no}:${rows.at(-1).trade_no}` : '';
        if (offset && rows.length && (signature === item.headSignature || history && signature === item.historySignature)) {
          item.historyUnsupported = true; item.historyComplete = false; item.catchupOffset = 0;
          return { rows: [], known: 0, repeated: true, signature };
        }
        const merged = store.mergeOrders(item, rows, notifyRecipients, (row, old) => shouldNotify(row, old) || (!history && item.initialized && !old && !row.paid_at && Date.parse(row.created_at) >= created), now);
        for (const row of rows) fetched.add(row.trade_no);
        return { rows, ...merged, signature };
      };
      stage = '读取最新订单';
      const first = await fetchPage(0);
      item.headSignature = first.signature;
      const newHead = first.rows.length - first.known;
      if (!item.initialized) {
        item.historyOffset = first.rows.length; item.historyComplete = first.rows.length < item.pageSize;
      } else {
        if (item.catchupOffset) item.catchupOffset += newHead;
        if (!item.catchupOffset && first.rows.length === item.pageSize && first.known < first.rows.length) item.catchupOffset = item.pageSize;
      }
      // The current balance and newest orders are the monitoring path.
      // Supplemental history/detail support varies by site; failures there
      // remain visible but must not undo a successful current-order sync.
      const supplemental = async (kind, message, task) => {
        if ((item[`${kind}RetryAt`] || 0) > now) return;
        try {
          signal.throwIfAborted(); await task();
          item[`${kind}Warning`] = ''; item[`${kind}RetryAt`] = 0;
        } catch (error) {
          if (controller.signal.aborted || store.account(id)?.version !== version || error.epayIntegrity) throw error;
          item[`${kind}Warning`] = message + (error.epaySafe ? ` ${error.message}` : '');
          item[`${kind}RetryAt`] = Date.now() + Math.max(60000, Math.min(300000, item.interval * 2000));
        }
      };
      if (item.catchupOffset && !item.historyUnsupported) {
        await supplemental('catchup', '最新订单已同步，期间订单尚未补齐，统计和通知可能不完整，将稍后重试。', async () => {
          const catchup = await fetchPage(item.catchupOffset);
          item.catchupOffset = catchup.repeated || catchup.known || catchup.rows.length < item.pageSize ? 0 : item.catchupOffset + item.pageSize;
        });
        if (item.catchupOffset && !item.catchupWarning) item.catchupWarning = '最新订单已同步，正在补齐期间订单，统计和通知可能暂不完整。';
      } else {
        item.catchupWarning = ''; item.catchupRetryAt = 0;
      }
      // Prioritize gaps in recent orders over old history, and do not request
      // an overlapping page twice when the catchup endpoint is failing.
      if (!item.catchupOffset && !item.historyComplete && !item.historyUnsupported && item.historyOffset) {
        await supplemental('history', '最新订单已同步，历史订单暂未补齐，将稍后重试。', async () => {
          const history = await fetchPage(item.historyOffset, true);
          if (!history.repeated) {
            item.historySignature = history.signature; item.historyOffset += history.rows.length;
            item.historyComplete = history.rows.length < item.pageSize;
          }
        });
      } else if (item.historyComplete || item.historyUnsupported) {
        item.historyWarning = ''; item.historyRetryAt = 0;
      }
      const pending = store.pending(id).filter(row => !fetched.has(row.trade_no));
      if (pending.length) {
        await supplemental('order', '最新订单已同步，部分旧订单状态暂未核对，将稍后重试。', async () => {
          for (const row of pending) {
            stage = '核对旧订单状态';
            const result = await request(item, key, 'order', { trade_no: row.trade_no }, { signal });
            if (!valid()) { signal.throwIfAborted(); throw Error('configuration changed'); }
            const order = normalizeEpayOrder(result, item.pid);
            if (order.trade_no !== row.trade_no) throw Object.assign(Error('订单查询返回了不同订单号，已停止同步'), { statusCode: 400, epayIntegrity: true });
            store.mergeOrders(item, [order], notifyRecipients, shouldNotify, now);
          }
        });
      } else {
        item.orderWarning = ''; item.orderRetryAt = 0;
      }
      if (controller.signal.aborted || store.account(id)?.version !== version) return false;
      item.initialized = true; item.lastSyncAt = new Date(now).toISOString(); item.lastAttemptAt = item.lastSyncAt;
      item.lastError = ''; item.failures = 0; item.nextAt = Date.now() + item.interval * 1000;
    } catch (error) {
      if (controller.signal.aborted || store.account(id)?.version !== version) return false;
      item.failures = Math.min(10, (item.failures || 0) + 1);
      item.lastError = `${stage}失败：${error.statusCode === 400 || error.epaySafe ? error.message : signal.aborted ? '同步超时，将自动重试' : '接口或网络请求失败，将自动重试'}`;
      item.lastAttemptAt = new Date().toISOString(); item.nextAt = Date.now() + Math.min(900000, item.interval * 1000 * 2 ** item.failures);
    } finally {
      try {
        // Abort an unnecessary balance request after a primary order failure.
        // Always await it before releasing the slot to keep concurrency bounded.
        if (item.lastError) balanceController.abort();
        const result = balanceTask && await balanceTask;
        if (!controller.signal.aborted && store.account(id)?.version === version) {
          if (result && !result.cancelled) {
            const balance = result.info && epayBalanceCents(result.info.money ?? result.info.balance);
            if (!result.error && Number.isSafeInteger(balance)) {
              item.balance = balance; item.balanceAt = result.at; item.balanceWarning = ''; item.balanceRetryAt = 0;
            } else {
              const reason = result.error?.epaySafe ? ` ${result.error.message}` : result.error ? '' : ' 接口未返回有效余额。';
              item.balanceWarning = `余额刷新失败，保留上次结果；订单监听独立运行。${reason}`;
              item.balanceRetryAt = Date.now() + Math.max(60000, Math.min(300000, item.interval * 2000));
            }
          }
          item.lastWarning = [item.balanceWarning, item.catchupWarning, item.historyWarning, item.orderWarning].filter(Boolean).join(' ');
          patch(id, version, Object.fromEntries([...snapshotFields, 'headSignature'].map(field => [field, item[field]])));
        }
      }
      finally { running.delete(id); }
    }
    return true;
  }
  async function deliver() {
    if (sending) return;
    sending = true;
    try {
      for (const notice of store.due(Date.now())) {
        const item = store.account(notice.account_id), bot = bots().find(bot => bot.id === notice.bot_id);
        const order = item && store.order(item.id, notice.trade_no);
        if (!item || !order || !item.enabled || !item.botIds.includes(notice.bot_id) || !bot || bot.enabled === false || !bot.tokenEnc || !(bot.userIds || []).some(id => String(id) === notice.chat_id)) {
          store.notification(notice.id, 'cancelled'); continue;
        }
        store.notification(notice.id, 'sending');
        try {
          await deps.send(bot, notice.chat_id, epayReceiptMessage(item, order, accounts()));
          store.notification(notice.id, 'sent');
        } catch (error) {
          // Ambiguous delivery is never blindly replayed: Telegram may already
          // have accepted it. Show a visible warning instead of duplicate money alerts.
          store.notification(notice.id, error.definite && notice.attempts < 4 ? 'pending' : error.definite ? 'failed' : 'uncertain', Date.now() + Math.min(300000, 15000 * 2 ** notice.attempts));
        }
      }
    } finally { sending = false; }
  }
  async function tick() {
    const all = accounts(), now = Date.now();
    for (let i = 0; i < all.length && running.size < 3; i++) {
      const item = all[(cursor + i) % all.length];
      if (item.enabled && (item.nextAt || 0) <= now && !running.has(item.id)) void sync(item.id).catch(() => {});
    }
    if (all.length) cursor = (cursor + 3) % all.length;
    if (now - lastPrune > 60000) { store.prune(now); lastPrune = now; }
    await deliver();
  }
  function snapshot(query = {}) {
    const view = query.view || 'overview';
    if (!['overview', 'orders', 'accounts'].includes(view)) fail('易支付页面视图无效');
    if (query.status && !Object.hasOwn(EPAY_STATUSES, query.status)) fail('订单状态无效');
    for (const field of ['from', 'to']) if (query[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(query[field]) || epayDay(`${query[field]}T00:00:00+08:00`) !== query[field])) fail('订单日期无效');
    if (query.from && query.to && query.from > query.to) fail('开始日期不能晚于结束日期');
    const all = accounts().map(item => ({ ...safe(item), syncing: running.has(item.id) }));
    const totals = store.totals(), selected = query.accountId ? all.filter(item => item.id === query.accountId) : all;
    const groups = new Map();
    for (const account of selected) {
      const group = groups.get(account.currency) || { currency: account.currency, total: 0, today: 0, yesterday: 0, month: 0, paidCount: 0, orders: 0 };
      const row = totals.find(row => row.accountId === account.id);
      if (row) for (const key of ['total', 'today', 'yesterday', 'month', 'paidCount', 'orders']) group[key] += row[key] || 0;
      groups.set(account.currency, group);
    }
    // Overview and accounts only render rollups. Load orders on demand in the
    // order tab/dialog instead of counting the ledger on every poll.
    const orders = view !== 'orders' ? { records: [], total: 0, page: 1, pages: 1 } : store.orders(query);
    return { accounts: all, totals, summary: [...groups.values()], balances: epayBalanceGroups(selected),
      orders, notifications: store.notificationSummary(), serverTime: Date.now(),
      bots: bots().map(({ id, name, enabled, tokenEnc, userIds }) => ({ id, name, enabled, configured: Boolean(tokenEnc), hasRecipients: Boolean(userIds?.length) })) };
  }
  function remove(body) {
    const ids = bulkDeleteIds(body), existing = accounts().filter(item => ids.has(item.id));
    for (const item of existing) running.get(item.id)?.abort();
    store.remove(existing.map(item => item.id)); invalidate(); return { deletedCount: existing.length };
  }
  return { store, save, test, sync, tick, deliver, snapshot, remove,
    telegramAccounts: () => { const totals = new Map(store.totals().map(row => [row.accountId, row]));
      return accounts().map(item => ({ ...safe(item), ...totals.get(item.id), status: item.lastError ? 'error' : item.catchupWarning ? 'incomplete' : item.balanceWarning ? 'balance_stale' : item.initialized ? 'healthy' : 'queued' })); },
    request(id) {
      const item = requireAccount(id);
      if (!item.enabled) fail('请先启用商户监听');
      if (running.has(id)) return { queued: true };
      item.nextAt = 0; store.saveAccount(item); invalidate(); void tick().catch(() => {}); return { queued: true };
    },
    close() { for (const controller of running.values()) controller.abort(); }
  };
}

export function registerEpayRoutes(app, service) {
  const route = handler => async (req, res, next) => { try { res.set('Cache-Control', 'no-store'); await handler(req, res); } catch (error) { next(error); } };
  app.get('/api/epay', route((req, res) => res.json(service.snapshot(req.query))));
  app.post('/api/epay/test', route(async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try { res.json(await service.test(req.body, req.body?.id || '', { signal: controller.signal })); }
    finally { res.removeListener('close', cancel); }
  }));
  app.post('/api/epay/accounts', route((req, res) => res.status(201).json({ item: service.save(req.body) })));
  app.put('/api/epay/accounts/:id', route((req, res) => res.json({ item: service.save(req.body, req.params.id) })));
  app.post('/api/epay/accounts/:id/sync', route((req, res) => res.status(202).json(service.request(req.params.id))));
  app.post('/api/epay/delete', route((req, res) => res.json(service.remove(req.body))));
}
