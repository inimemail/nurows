import crypto from 'node:crypto';
import fs from 'node:fs';
import { relayTgFrame } from '../shared/tg-frame-relay.js';
import { createTgRunnerClient } from './tg-hosting-runner.js';
import { TG_ACCOUNT_ID, hostingError, tgHostingAccount, tgHostingSettings, tgResumeOrder } from '../shared/tg-hosting.js';

export function createTgHostingService({ db, key, runner = createTgRunnerClient(), now = Date.now, restoreMarker = '' }) {
  db.exec(`CREATE TABLE IF NOT EXISTS tg_hosting_accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_hosting_settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tg_hosting_control(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
  let migrationId = '';
  if (restoreMarker && fs.existsSync(restoreMarker)) {
    // A damaged marker blocks TG startup without taking the whole panel down.
    migrationId = 'invalid-restored-marker';
    try { const marker = JSON.parse(fs.readFileSync(restoreMarker, 'utf8')); if (typeof marker.id === 'string' && TG_ACCOUNT_ID.test(marker.id)) migrationId = marker.id; } catch {}
  }
  const controlGet = db.prepare('SELECT value FROM tg_hosting_control WHERE id=1');
  const controlPut = db.prepare('INSERT OR REPLACE INTO tg_hosting_control VALUES(1,?)');
  const migrationHeld = () => Boolean(migrationId && controlGet.get()?.value !== migrationId);
  const list = db.prepare('SELECT value FROM tg_hosting_accounts ORDER BY name COLLATE NOCASE,id');
  const get = db.prepare('SELECT value FROM tg_hosting_accounts WHERE id=?');
  const put = db.prepare('INSERT INTO tg_hosting_accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,value=excluded.value');
  const del = db.prepare('DELETE FROM tg_hosting_accounts WHERE id=?');
  const settingGet = db.prepare('SELECT value FROM tg_hosting_settings WHERE id=1');
  const settingPut = db.prepare('INSERT OR REPLACE INTO tg_hosting_settings VALUES(1,?)');
  let recordsCache;
  const records = () => recordsCache ||= list.all().map(row => JSON.parse(row.value));
  const requireAccount = id => { const row = get.get(id); if (!row) throw hostingError('托管账号不存在', 404); return JSON.parse(row.value); };
  const settings = () => tgHostingSettings(settingGet.get() ? JSON.parse(settingGet.get().value) : {});
  const saveRow = item => { put.run(item.id, item.name, JSON.stringify(item)); recordsCache = null; };
  let initialized = false, initializing, lastRuntime = { accounts: [], connected: false }, lastPoll = 0, polling, deletion = null;
  const recordedStarts = new Map();
  const snapshotsKey = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'nurossh-tg-profile-backups-v1', 32)).toString('hex');
  async function initialize() {
    if (!runner.enabled) return false;
    if (initialized) return true;
    if (!initializing) initializing = runner.request('POST', '/configure', { key: snapshotsKey, settings: settings(), migrationHold: migrationHeld(), accounts: tgResumeOrder(records()).map(({ id, desired, lastRunningAt }) => ({ id, desired: migrationHeld() ? false : desired, profileExpected: Boolean(lastRunningAt) })) }, 30000)
      .then(() => { initialized = true; return true; }).finally(() => { initializing = null; });
    return initializing;
  }
  async function runtime(force = false) {
    if (!runner.enabled) return { accounts: [], connected: false, error: '托管组件尚未启用' };
    if (!force && now() - lastPoll < 3000) return lastRuntime;
    if (!polling) polling = Promise.resolve().then(async () => {
      try {
        await initialize(); lastRuntime = { ...await runner.request('GET', '/status'), connected: true };
        for (const row of lastRuntime.accounts) if (row.state === 'running' && row.startedAt) {
          if (recordedStarts.get(row.id) === row.startedAt) continue;
          const item = get.get(row.id); if (!item) continue;
          const account = JSON.parse(item.value);
          if (account.lastRunningAt !== row.startedAt) saveRow({ ...account, lastRunningAt: row.startedAt });
          recordedStarts.set(row.id, row.startedAt);
        }
      }
      catch (error) { initialized = false; lastRuntime = { accounts: [], connected: false, error: error.message }; }
      lastPoll = now(); return lastRuntime;
    }).finally(() => { polling = null; });
    return polling;
  }
  const operations = new Map();
  function forAccount(id, fn) {
    const result = (operations.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    operations.set(id, result);
    void result.finally(() => { if (operations.get(id) === result) operations.delete(id); }).catch(() => {});
    return result;
  }
  async function commandNow(id, action) {
    requireAccount(id);
    if (!['wake', 'sleep', 'snapshot'].includes(action)) throw hostingError('操作无效');
    if (action === 'wake' && migrationHeld()) throw hostingError('请先确认旧机器的 TG 托管已停止，再启用迁移会话', 409);
    await initialize();
    const before = requireAccount(id);
    // Keep the user's intent across a lost acknowledgement. A browser may have
    // started successfully even if the HTTP response was interrupted.
    if (action !== 'snapshot') saveRow({ ...before, desired: action === 'wake', lastOpenedAt: action === 'wake' ? new Date(now()).toISOString() : before.lastOpenedAt });
    try { return await runner.request('POST', `/accounts/${id}/${action}`, {}, 15000); }
    catch (error) {
      if (action !== 'snapshot' && error.statusCode >= 400 && error.statusCode < 500) saveRow({ ...requireAccount(id), desired: before.desired, lastOpenedAt: before.lastOpenedAt });
      throw error;
    } finally { lastPoll = 0; }
  }
  const command = (id, action) => forAccount(id, () => commandNow(id, action));
  const heartbeat = runner.enabled ? setInterval(() => { void runtime(true); }, 15000) : null;
  heartbeat?.unref();
  const service = {
    close() { clearInterval(heartbeat); },
    records, settings, runtime, requireAccount, runner, migrationHeld,
    async activateMigration(confirm) {
      if (confirm !== 'old-host-stopped') throw hostingError('请先确认旧机器已停止 TG 托管');
      if (!migrationHeld()) return { ok: true };
      await initialize();
      const ids = tgResumeOrder(records()).filter(item => item.desired).map(item => item.id);
      // Persist the explicit takeover decision first. A lost runner response must
      // not put the UI back into a hold while the new host is already starting.
      controlPut.run(migrationId); lastPoll = 0;
      try { await runner.request('POST', '/resume', { ids }, 30000); }
      catch (error) { initialized = false; throw error; }
      return { ok: true };
    },
    async save(input, id) {
      if (!id && records().length >= 10000) throw hostingError('托管账号已达上限');
      const old = id ? requireAccount(id) : null;
      if (old && old.version !== input.version) throw hostingError('账号已更新，请重新打开编辑', 409);
      const config = tgHostingAccount(input, old || {}), all = records();
      if (all.some(item => item.id !== id && (item.name.toLowerCase() === config.name.toLowerCase() || config.phone && item.phone === config.phone))) throw hostingError('账号名称或手机号已存在', 409);
      const item = { ...old, ...config, id: old?.id || crypto.randomUUID(), version: crypto.randomUUID(), desired: old?.desired || false, createdAt: old?.createdAt || new Date(now()).toISOString(), lastOpenedAt: old?.lastOpenedAt || '' };
      saveRow(item); return item;
    },
    async configure(input) {
      const value = tgHostingSettings({ ...settings(), ...input });
      if (runner.enabled) { await initialize(); await runner.request('PUT', '/settings', value); }
      settingPut.run(JSON.stringify(value)); return value;
    },
    command,
    async remove(ids, confirm) {
      if (confirm !== 'delete-tg-hosting' || !Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => !TG_ACCOUNT_ID.test(id)) || new Set(ids).size !== ids.length) throw hostingError('请确认要删除的托管账号');
      for (const id of ids) requireAccount(id);
      // Configuration must survive a failed profile deletion, including a lost runner response.
      for (const id of ids) await forAccount(id, async () => { requireAccount(id); await initialize(); await runner.request('DELETE', `/accounts/${id}`, {}, 120000); del.run(id); recordsCache = null; recordedStarts.delete(id); if (deletion?.running) deletion.completed++; });
      lastPoll = 0; return { ok: true };
    },
    beginRemove(ids, confirm) {
      if (deletion?.running) throw hostingError('删除正在处理，请稍后操作', 409);
      if (confirm !== 'delete-tg-hosting' || !Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => !TG_ACCOUNT_ID.test(id)) || new Set(ids).size !== ids.length) throw hostingError('请确认要删除的托管账号');
      for (const id of ids) requireAccount(id);
      deletion = { running: true, completed: 0, total: ids.length, error: '' };
      void service.remove([...ids], confirm).catch(error => { deletion.error = error.message; }).finally(() => { deletion.running = false; });
      return { ok: true, accepted: true };
    },
    async snapshot(query = {}) {
      const remote = await runtime(), all = records(), statuses = new Map(remote.accounts.map(item => [item.id, item]));
      const keyword = String(query.q || '').trim().toLowerCase(), filter = String(query.status || ''), group = String(query.group || '');
      const full = all.map(item => ({ ...item, runtime: statuses.get(item.id) || { state: remote.connected ? 'stopped' : 'unavailable' } }));
      const matches = full.filter(item => (!keyword || [item.name, item.phone, item.group, item.note].some(value => value.toLowerCase().includes(keyword))) && (!group || item.group === group) && (!filter || item.runtime.state === filter));
      const pages = Math.max(1, Math.ceil(matches.length / 30)), page = Math.min(pages, Math.max(1, Math.floor(Number(query.page)) || 1));
      return { accounts: matches.slice((page - 1) * 30, page * 30), total: matches.length, pages, page, groups: [...new Set(all.map(item => item.group).filter(Boolean))].sort(), settings: settings(), deletion: deletion && { ...deletion }, component: { enabled: runner.enabled, connected: remote.connected, error: remote.error || '', backupBusy: Boolean(remote.backupBusy), migrationHold: migrationHeld(), resources: remote.resources || null }, summary: { total: all.length, running: full.filter(item => item.runtime.state === 'running').length, sleeping: full.filter(item => item.runtime.state === 'stopped').length, queued: full.filter(item => item.runtime.state === 'queued').length } };
    }
  };
  return service;
}

export function registerTgHostingRoutes(app, service, verifyPassword, { sessionValid, now = Date.now } = {}) {
  const grants = new Map(), viewers = new Map(), idleSince = new Map();
  let checkingIdle = false, closing = false;
  let unlocking = false;
  const deny = () => { throw hostingError('TG 托管已锁定，请验证面板密码', 423); };
  function requireGrant(req, touch = true) {
    const token = req.headers['x-tg-hosting-unlock'], grant = grants.get(token);
    if (!grant || grant.session !== req.auth || !sessionValid(req) || grant.expires <= now() || grant.deadline <= now()) { if (grant && grant.expires <= now()) grants.delete(token); deny(); }
    if (touch) grant.expires = Math.min(grant.deadline, now() + 10 * 60000);
    return grant;
  }
  const route = fn => async (req, res) => { res.set('Cache-Control', 'no-store'); await fn(req, res); };
  app.get('/api/tg-hosting', route(async (req, res) => res.json(await service.snapshot(req.query))));
  app.post('/api/tg-hosting/unlock', route(async (req, res) => {
    if (unlocking) throw hostingError('安全验证正在处理，请稍后重试', 429);
    unlocking = true;
    try {
      await verifyPassword(req);
      if (!sessionValid(req) || res.destroyed) return;
      for (const [token, grant] of grants) if (grant.expires <= now() || grant.deadline <= now()) grants.delete(token);
      if (grants.size >= 100) throw hostingError('解锁会话过多', 429);
      const token = crypto.randomBytes(32).toString('hex'), expires = now() + 10 * 60000, deadline = now() + 30 * 60000;
      grants.set(token, { token, session: req.auth, expires, deadline }); res.json({ token, expiresAt: expires, deadline });
    } finally { unlocking = false; }
  }));
  const closeGrant = token => { grants.delete(token); for (const [ws, item] of viewers) if (item.token === token) ws.close(1000, '托管已锁定'); };
  app.post('/api/tg-hosting/lock', route((req, res) => { const token = req.headers['x-tg-hosting-unlock']; if (grants.get(token)?.session === req.auth) closeGrant(token); res.json({ ok: true }); }));
  app.post('/api/tg-hosting/accounts', route(async (req, res) => { requireGrant(req); res.status(201).json({ account: await service.save(req.body) }); }));
  app.put('/api/tg-hosting/accounts/:id', route(async (req, res) => { requireGrant(req); res.json({ account: await service.save(req.body, req.params.id) }); }));
  app.put('/api/tg-hosting/settings', route(async (req, res) => { requireGrant(req); res.json({ settings: await service.configure(req.body) }); }));
  app.post('/api/tg-hosting/activate-migration', route(async (req, res) => { requireGrant(req); res.json(await service.activateMigration(req.body.confirm)); }));
  app.post('/api/tg-hosting/delete-selection', route((req, res) => { requireGrant(req); res.json({ ids: service.records().map(item => item.id) }); }));
  app.get('/api/tg-hosting/accounts/:id', route(async (req, res) => { requireGrant(req, false); const item = service.requireAccount(req.params.id), remote = await service.runtime(); res.json({ runtime: remote.accounts.find(value => value.id === item.id) || { state: remote.connected ? 'stopped' : 'unavailable' } }); }));
  app.post('/api/tg-hosting/touch', route((req, res) => { requireGrant(req); res.json({ ok: true }); }));
  app.post('/api/tg-hosting/delete', route((req, res) => { requireGrant(req); res.status(202).json(service.beginRemove(req.body.ids, req.body.confirm)); }));
  app.post('/api/tg-hosting/accounts/:id/:action', route(async (req, res) => {
    requireGrant(req);
    if (!['wake', 'sleep', 'snapshot'].includes(req.params.action)) throw hostingError('操作不存在', 404);
    res.status(202).json(await service.command(req.params.id, req.params.action));
  }));
  app.post('/api/tg-hosting/view', route((req, res) => { const grant = requireGrant(req); if (service.migrationHeld()) throw hostingError('请先完成迁移接管确认', 409); service.requireAccount(req.body?.id); res.json({ protocol: `nurossh-tg.${grant.token}` }); }));
  async function checkIdle() {
    if (checkingIdle || closing) return;
    const viewed = new Set([...viewers.values()].map(viewer => viewer.id));
    const candidates = service.records().filter(item => item.mode === 'sleep' && item.desired && !viewed.has(item.id));
    const ids = new Set(candidates.map(item => item.id));
    for (const id of idleSince.keys()) if (!ids.has(id)) idleSince.delete(id);
    if (!candidates.length) return;
    checkingIdle = true;
    try {
      const remote = await service.runtime();
      const statuses = new Map(remote.accounts.map(row => [row.id, row.state]));
      for (const item of candidates) {
        const state = statuses.get(item.id);
        if (!remote.connected || remote.backupBusy || state !== 'running') { idleSince.delete(item.id); continue; }
        const since = idleSince.get(item.id);
        if (since === undefined) { idleSince.set(item.id, now()); continue; }
        if (closing || now() - since < 60000 || [...viewers.values()].some(viewer => viewer.id === item.id)) continue;
        const current = service.requireAccount(item.id);
        if (current.mode === 'sleep' && current.desired) await service.command(item.id, 'sleep');
        idleSince.delete(item.id);
      }
    } catch {} finally { checkingIdle = false; }
  }
  const timer = setInterval(() => {
    for (const [token, grant] of grants) if (grant.expires <= now() || grant.deadline <= now()) closeGrant(token);
    void checkIdle();
  }, 5000); timer.unref();
  return {
    connect(ws, req, sessionSockets) {
      const token = String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).find(value => value.startsWith('nurossh-tg.'))?.slice(11);
      let grant, account;
      try { req.headers['x-tg-hosting-unlock'] = token; grant = requireGrant(req); if (service.migrationHeld()) throw hostingError('迁移会话尚未启用', 409); account = service.requireAccount(new URL(req.url, 'http://localhost').searchParams.get('id')); }
      catch { ws.close(1008, '请重新解锁 TG 托管'); return; }
      for (const [peer, item] of viewers) if (item.id === account.id) { ws.close(1008, '该账号已有操作窗口，请先关闭原窗口'); return; }
      idleSince.delete(account.id);
      const upstream = service.runner.connect(account.id);
      viewers.set(ws, { id: account.id, token });
      let live = false;
      const valid = () => sessionSockets.authorized(ws) && grants.get(token) === grant && grant.expires > now() && grant.deadline > now();
      upstream.on('open', () => { if (!valid()) { upstream.close(); return; } live = true; });
      upstream.on('message', (data, binary) => { if (!valid()) { upstream.close(); return; } relayTgFrame(upstream, ws, data, { binary }); });
      ws.on('message', (data, binary) => { if (!valid() || !live) return; relayTgFrame(ws, upstream, data, { binary, limit: 1024 * 1024 }); });
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true; viewers.delete(ws); try { upstream.close(); } catch {}

      };
      ws.once('close', finish); ws.once('error', finish);
      upstream.once('error', () => ws.close(1011, '浏览器尚未就绪，请稍后重新连接'));
      upstream.once('close', () => ws.close());
    },
    checkIdle,
    close() { closing = true; clearInterval(timer); idleSince.clear(); for (const ws of viewers.keys()) ws.close(); }
  };
}
