import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeOtpAccount, OTP_MAX_ACCOUNTS } from '../shared/authenticator.js';
const scrypt = promisify(crypto.scrypt);

export async function encodeAuthenticatorBackup(accounts, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw Error('导出密码至少 12 个字符');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = await scrypt(passphrase, salt, 32);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('nurossh-authenticator-v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(accounts), 'utf8'), cipher.final()]);
    return { format: 'nurossh-authenticator', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  } finally { key.fill(0); }
}

export async function decodeAuthenticatorBackup(backup, passphrase) {
  if (!backup || backup.format !== 'nurossh-authenticator' || backup.version !== 1 || typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw Error('备份格式或密码无效');
  const decode = (name, size) => {
    const value = backup[name];
    if (typeof value !== 'string' || value.length > 2000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error('备份文件无效');
    const buffer = Buffer.from(value, 'base64');
    if (size && buffer.length !== size) throw Error('备份文件无效');
    return buffer;
  };
  const salt = decode('salt', 16), iv = decode('iv', 12), tag = decode('tag', 16), data = decode('data');
  const key = await scrypt(passphrase, salt, 32);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('nurossh-authenticator-v1')); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch { throw Error('备份密码错误或文件已损坏'); } finally { key.fill(0); }
}

export function createAuthenticatorStore(db, encrypt, decrypt) {
  db.exec(`CREATE TABLE IF NOT EXISTS authenticator_accounts (
    id TEXT PRIMARY KEY, issuer TEXT NOT NULL, account TEXT NOT NULL, note TEXT NOT NULL,
    algorithm TEXT NOT NULL, digits INTEGER NOT NULL, period INTEGER NOT NULL,
    secret_enc TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS authenticator_settings (id INTEGER PRIMARY KEY CHECK(id=1), idle_minutes INTEGER NOT NULL);
    INSERT OR IGNORE INTO authenticator_settings VALUES (1, 5);
    CREATE TABLE IF NOT EXISTS authenticator_audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  const all = db.prepare('SELECT * FROM authenticator_accounts ORDER BY position, created_at, id');
  const metadata = db.prepare('SELECT id,issuer,account,note,algorithm,digits,period,revision FROM authenticator_accounts ORDER BY position,created_at,id');
  const orderedIds = db.prepare('SELECT id FROM authenticator_accounts ORDER BY position,created_at,id');
  const count = db.prepare('SELECT COUNT(*) AS n FROM authenticator_accounts');
  const get = db.prepare('SELECT * FROM authenticator_accounts WHERE id=?');
  const readSettings = db.prepare('SELECT idle_minutes FROM authenticator_settings WHERE id=1');
  const findFingerprint = db.prepare('SELECT id FROM authenticator_accounts WHERE fingerprint=?');
  const nextPosition = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM authenticator_accounts');
  const insertAccount = db.prepare('INSERT INTO authenticator_accounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const updateAccount = db.prepare('UPDATE authenticator_accounts SET issuer=?,account=?,note=?,algorithm=?,digits=?,period=?,secret_enc=?,fingerprint=?,revision=revision+1 WHERE id=?');
  const updatePosition = db.prepare('UPDATE authenticator_accounts SET position=? WHERE id=?');
  const deleteAccount = db.prepare('DELETE FROM authenticator_accounts WHERE id=?');
  const updateSettings = db.prepare('UPDATE authenticator_settings SET idle_minutes=? WHERE id=1');
  const deleteOldAudit = db.prepare('DELETE FROM authenticator_audit WHERE created_at<?');
  const insertAudit = db.prepare('INSERT INTO authenticator_audit(action,created_at) VALUES (?,?)');
  const trimAudit = db.prepare('DELETE FROM authenticator_audit WHERE id NOT IN (SELECT id FROM authenticator_audit ORDER BY id DESC LIMIT 1000)');
  const readAudit = db.prepare('SELECT action,created_at FROM authenticator_audit ORDER BY id DESC LIMIT 100');
  const meta = row => ({ id: row.id, issuer: row.issuer, account: row.account, note: row.note, algorithm: row.algorithm, digits: row.digits, period: row.period, revision: row.revision });
  const settings = () => ({ idleMinutes: readSettings.get().idle_minutes });
  const pruneAudit = () => deleteOldAudit.run(Date.now() - 7 * 86400000);
  pruneAudit();
  const reveal = row => ({ ...meta(row), secret: decrypt(JSON.parse(row.secret_enc)) });
  const requireRow = id => { const row = get.get(id); if (!row) throw Error('验证器不存在，请刷新后重试'); return row; };
  const checkRevision = (row, revision) => { if (row.revision !== revision) throw Error('验证器已被修改，请刷新后重试'); };
  function save(input, id = '') {
    const existing = id ? requireRow(id) : null;
    if (existing) checkRevision(existing, input?.revision);
    const config = normalizeOtpAccount(input, existing);
    if (!existing && count.get().n >= OTP_MAX_ACCOUNTS) throw Error(`最多保存 ${OTP_MAX_ACCOUNTS} 个验证器`);
    const fingerprint = config.secret ? crypto.createHash('sha256').update(config.secret).digest('hex') : existing.fingerprint;
    const duplicate = findFingerprint.get(fingerprint);
    if (duplicate && duplicate.id !== id) throw Error('此密钥已添加，请勿重复保存');
    const secretEnc = config.secret ? JSON.stringify(encrypt(config.secret)) : existing.secret_enc;
    const nextId = id || crypto.randomUUID();
    if (existing) updateAccount
      .run(config.issuer, config.account, config.note, config.algorithm, config.digits, config.period, secretEnc, fingerprint, id);
    else insertAccount.run(nextId, config.issuer, config.account, config.note, config.algorithm, config.digits, config.period, secretEnc, fingerprint,
      nextPosition.get().n, 1, new Date().toISOString());
    return nextId;
  }
  return {
    list: () => ({ accounts: metadata.all(), settings: settings() }),
    audit(action) {
      const time = Date.now();
      pruneAudit();
      insertAudit.run(action, time);
      trimAudit.run();
    },
    history: () => { pruneAudit(); return readAudit.all(); },
    secrets: () => all.all().map(reveal),
    account: id => reveal(requireRow(id)), save,
    remove(id, revision) { checkRevision(requireRow(id), revision); deleteAccount.run(id); },
    settings,
    configure(minutes) { if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw Error('锁定时间必须为 1 至 30 分钟'); updateSettings.run(minutes); },
    reorder(id, targetId, placement) {
      if (!['before', 'after'].includes(placement)) throw Error('排序参数无效');
      requireRow(id); requireRow(targetId);
      if (id === targetId) return;
      const ids = orderedIds.all().map(row => row.id).filter(value => value !== id);
      ids.splice(ids.indexOf(targetId) + (placement === 'after' ? 1 : 0), 0, id);
      db.transaction(() => ids.forEach((id, i) => updatePosition.run(i, id)))();
    },
    import(items) {
      if (!Array.isArray(items) || !items.length || items.length > OTP_MAX_ACCOUNTS) throw Error('导入文件中的验证器数量无效');
      db.transaction(() => { for (const item of items) save(item); })();
    }
  };
}

export function registerAuthenticatorRoutes(app, store, verifyPassword, { now = Date.now, sessionValid = () => true } = {}) {
  const grants = new Map();
  const pending = new WeakSet();
  let expensive = 0;
  const privateJob = fn => async (req, res) => {
    // Leave capacity in Node's default worker pool for DNS and file operations.
    if (pending.has(req.auth) || expensive >= 2) { const error = Error('安全操作正在处理，请稍后重试'); error.statusCode = 429; throw error; }
    pending.add(req.auth); expensive++;
    try { await fn(req, res); } finally { pending.delete(req.auth); expensive--; }
  };
  const duration = () => store.settings().idleMinutes * 60000;
  const snapshot = () => ({ ...store.list(), serverTime: now() });
  const requireGrant = req => {
    const token = req.headers['x-authenticator-unlock'];
    const grant = typeof token === 'string' ? grants.get(token) : null;
    if (!grant || grant.session !== req.auth || !sessionValid(req) || grant.expires <= now() || grant.deadline <= now()) {
      if (grant && (grant.expires <= now() || grant.deadline <= now() || (grant.session === req.auth && !sessionValid(req)))) grants.delete(token);
      const error = Error('验证器已锁定，请重新解锁'); error.statusCode = 423; throw error;
    }
    grant.expires = Math.min(grant.deadline, now() + duration());
    return grant;
  };
  const route = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (error) { res.status(error.statusCode || 400).json({ error: error.code ? '验证器操作失败，请稍后重试' : error.message || '验证器操作失败' }); }
  };
  app.get('/api/authenticator', route((_req, res) => res.json(snapshot())));
  app.get('/api/authenticator/history', route((req, res) => { requireGrant(req); res.json({ records: store.history() }); }));
  app.post('/api/authenticator/unlock', route(privateJob(async (req, res) => {
    await verifyPassword(req);
    if (res.destroyed) return;
    if (!sessionValid(req)) { const error = Error('登录已失效，请重新登录'); error.statusCode = 401; throw error; }
    for (const [key, grant] of grants) if (grant.expires <= now() || grant.deadline <= now()) grants.delete(key);
    if (grants.size >= 100) { const error = Error('解锁会话过多，请稍后重试'); error.statusCode = 429; throw error; }
    const accounts = store.secrets();
    const token = crypto.randomBytes(32).toString('hex');
    const grant = { session: req.auth, deadline: now() + 30 * 60000, expires: now() + duration() };
    grants.set(token, grant);
    store.audit('unlock');
    res.json({ ...snapshot(), accounts, token, expiresAt: grant.expires, deadline: grant.deadline });
  })));
  app.post('/api/authenticator/lock', route((req, res) => {
    const token = req.headers['x-authenticator-unlock'];
    if (grants.get(token)?.session === req.auth) grants.delete(token);
    res.json({ ok: true });
  }));
  app.post('/api/authenticator/touch', route((req, res) => { const grant = requireGrant(req); res.json({ expiresAt: grant.expires }); }));
  app.post('/api/authenticator/session', route((req, res) => { requireGrant(req); res.json({ ...snapshot(), accounts: store.secrets() }); }));
  app.post('/api/authenticator', route((req, res) => { requireGrant(req); const id = store.save(req.body); store.audit('create'); res.status(201).json({ ...snapshot(), item: store.account(id) }); }));
  app.put('/api/authenticator/settings', route((req, res) => { requireGrant(req); store.configure(req.body?.idleMinutes); res.json(snapshot()); }));
  app.put('/api/authenticator/order', route((req, res) => { requireGrant(req); store.reorder(req.body?.id, req.body?.targetId, req.body?.placement); res.json(snapshot()); }));
  app.post('/api/authenticator/import', route(privateJob(async (req, res) => {
    requireGrant(req);
    const accounts = await decodeAuthenticatorBackup(req.body?.backup, req.body?.passphrase);
    requireGrant(req); store.import(accounts); store.audit('import'); res.json({ ...snapshot(), accounts: store.secrets() });
  })));
  app.post('/api/authenticator/export', route(privateJob(async (req, res) => {
    requireGrant(req); await verifyPassword(req);
    requireGrant(req);
    const backup = await encodeAuthenticatorBackup(store.secrets(), req.body?.passphrase);
    requireGrant(req); store.audit('export'); res.json({ backup });
  })));
  app.post('/api/authenticator/:id/reveal', route(privateJob(async (req, res) => { requireGrant(req); await verifyPassword(req); requireGrant(req); const item = store.account(req.params.id); store.audit('reveal'); res.json({ item }); })));
  app.put('/api/authenticator/:id', route((req, res) => { requireGrant(req); const id = store.save(req.body, req.params.id); store.audit('edit'); res.json({ ...snapshot(), item: store.account(id) }); }));
  app.delete('/api/authenticator/:id', route((req, res) => { requireGrant(req); store.remove(req.params.id, req.body?.revision); store.audit('delete'); res.json(snapshot()); }));
}
