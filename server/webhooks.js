import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createWebhookStore, WEBHOOK_ACTIVE } from './webhook-store.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const active = (run) => run && WEBHOOK_ACTIVE.includes(run.status);
const safeRun = (run) => { if (!run) return null; const { snapshot, ...safe } = run; return safe; };
const safeTask = (task) => { const { commandEnc, tokenEnc, tokenHash, ...safe } = task; return { ...safe, commandConfigured: Boolean(commandEnc) }; };
const hash = (token) => createHash('sha256').update(token).digest();
const integer = (value, low, high) => { if (!Number.isInteger(Number(value)) || Number(value) < low || Number(value) > high) fail(`数值须为 ${low}–${high} 的整数`); return Number(value); };

export function createWebhookService(deps) {
  const store = createWebhookStore(deps.db);
  let revision = Date.now(), running = 0, lastPrune = 0;
  const queue = [], controllers = new Map(), completion = new Map(), submitted = new Set();
  const guards = () => deps.guards?.() || [];
  const linked = (id) => guards().find((guard) => guard.webhookTaskId === id);
  const task = (id) => store.task(id) || fail('Webhook 任务不存在', 404);
  const touch = () => { revision++; };
  const getRun = (id) => store.run(id) || fail('执行记录不存在', 404);
  function save(input, id) {
    const previous = id ? task(id) : null;
    if (previous && input.version !== previous.version) fail('任务已被修改，请重新打开编辑', 409);
    const name = String(input.name || '').trim();
    if (!name || name.length > 120 || /[\x00-\x1f]/.test(name)) fail('请填写任务名称，最多 120 字符');
    const tasks = store.taskSummaries();
    if (tasks.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) fail('任务名称已存在', 409);
    if (!previous && tasks.length >= 1000) fail('最多保存 1000 个任务');
    const command = String(input.command || '').trim();
    if ((!command && !previous?.commandEnc) || command.length > 32768 || command.includes('\0')) fail('请填写命令，最多 32768 字符');
    const serverId = String(input.serverId || '');
    if (serverId && !deps.servers().some((item) => item.id === serverId)) fail('执行服务器不存在');
    const botIds = [...new Set(Array.isArray(input.botIds) ? input.botIds : [])];
    if (botIds.length > 50 || botIds.some((id) => !deps.bots().some((item) => item.id === id))) fail('请选择有效的通知机器人');
    for (const key of ['enabled', 'externalEnabled', 'allowGet']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('开关值无效');
    const token = previous ? '' : randomBytes(32).toString('base64url');
    const item = { ...previous, id: id || randomUUID(), name, serverId, timeout: integer(input.timeout ?? 30, 5, 3600),
      note: String(input.note || '').trim().slice(0, 1000), enabled: input.enabled !== false, externalEnabled: input.externalEnabled !== false,
      allowGet: input.allowGet === true, botIds, commandEnc: command ? deps.encrypt(command) : previous.commandEnc,
      ...(token ? { tokenEnc: deps.encrypt(token), tokenHash: hash(token).toString('hex') } : {}),
      version: randomUUID(), createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.saveTask(item); touch(); return safeTask(item);
  }
  function snapshot({ search = '', page = 1 } = {}) {
    const live = new Map(store.activeSummaries().map((run) => [run.taskId, run]));
    const servers = deps.servers().map(({ id, name, host }) => ({ id, name, host }));
    const names = new Map(servers.map((item) => [item.id, `${item.name} · ${item.host}`]));
    const associations = new Map(guards().filter((guard) => guard.webhookTaskId).map((guard) => [guard.webhookTaskId, guard.id]));
    const latest = new Map(store.latestSummaries().map((run) => [run.taskId, run]));
    const all = store.taskSummaries().map((item) => ({ ...item, location: names.get(item.serverId) || (item.serverId ? '服务器已删除' : '面板本机'), run: live.get(item.id) || latest.get(item.id) || null, guardId: associations.get(item.id) || '' }));
    const keyword = String(search).trim().toLowerCase();
    const filtered = keyword ? all.filter((item) => [item.name, item.note, item.location].some((value) => value.toLowerCase().includes(keyword))) : all;
    const pages = Math.max(1, Math.ceil(filtered.length / 50)); page = Math.min(pages, Math.max(1, Number.isSafeInteger(Number(page)) ? Number(page) : 1));
    return { revision, tasks: filtered.slice((page - 1) * 50, page * 50), total: all.length, matched: filtered.length, active: live.size, page, pages, settings: store.settings(), servers,
      bots: deps.bots().map(({ id, name, enabled, tokenEnc, userIds }) => ({ id, name, enabled, configured: Boolean(tokenEnc), hasRecipients: Boolean(userIds?.length) })) };
  }
  function newRun(item, source, guardId = '') {
    return { id: randomUUID(), taskId: item.id, taskName: item.name, serverId: item.serverId, source, guardId, status: 'queued', created: Date.now(), startedAt: '', finishedAt: '', message: '等待执行', snapshot: item };
  }
  function trigger(id, source = 'panel', requestKey = '') {
    const item = task(id);
    if (!item.enabled) fail('任务已停用', 409);
    if (typeof requestKey !== 'string' || requestKey.length > 128 || /[\x00-\x1f]/.test(requestKey)) fail('请求标识无效');
    const priorId = store.priorRequest(id, requestKey);
    if (priorId) return { run: safeRun(getRun(priorId)), duplicate: true };
    const current = store.active(id);
    if (current) { store.call(id, current.id, requestKey, source, true); return { run: safeRun(current), duplicate: true }; }
    const guard = linked(id);
    if (guard && (guard.enabled === false || guard.flow || guard.manualRequested)) {
      if (guard.enabled === false) fail('关联的动态守护已停用', 409);
      // A flow restored from an older version must also hold the task lock.
      const restored = newRun(item, source, guard.id); restored.status = 'waiting_guard'; restored.startedAt = guard.flow?.startedAt || '';
      restored.message = '关联守护正在等待或验证新 IP'; store.saveRun(restored); store.call(id, restored.id, requestKey, source, true); touch();
      return { run: safeRun(restored), duplicate: true };
    }
    if (queue.length >= store.settings().queueLimit) fail('任务队列已满，请稍后重试', 429);
    const run = newRun(item, source, guard?.id); store.saveRun(run); store.call(id, run.id, requestKey, source, false); touch();
    if (guard) {
      run.status = 'waiting_guard'; run.message = '已交给动态守护，按冷却时间与每日额度执行'; store.saveRun(run);
      try { deps.requestGuard(guard.id); } catch (error) { finish(run, { status: 'failed', message: error.message }); throw error; }
    } else { queue.push({ run }); pump(); }
    return { run: safeRun(store.run(run.id)), duplicate: false };
  }
  function finish(run, result) {
    Object.assign(run, result, { finishedAt: new Date().toISOString() }); delete run.snapshot;
    store.saveRun(run); touch();
    if (!run.guardId) Promise.resolve().then(() => deps.notify?.(store.task(run.taskId), safeRun(run))).catch((error) => deps.logError?.(error));
  }
  function pump() {
    while (running < store.settings().concurrency && queue.length) {
      const entry = queue.shift(), run = store.run(entry.run.id);
      if (!active(run)) { entry.resolve?.({ ok: false, uncertain: false, error: '任务已取消' }); continue; }
      running++; submitted.add(run.id);
      const controller = new AbortController(); controllers.set(run.id, controller);
      const config = run.snapshot;
      run.status = 'running'; run.startedAt ||= new Date().toISOString(); run.message = '正在执行命令'; store.saveRun(run); touch();
      let outputWriteFailed = false;
      Promise.resolve().then(() => deps.execute(config, controller.signal, (output) => {
        // Output persistence must not throw from a child-process stream event.
        // The final result still gets a separate persistence attempt.
        if (outputWriteFailed) return;
        try { store.writeOutput(run.id, output); }
        catch (error) { outputWriteFailed = true; deps.logError?.(error); }
      })).catch((error) => { deps.logError?.(error); return { ok: false, status: 'uncertain', uncertain: true, error: '执行结果待确认', output: '' }; }).then((result) => {
        // Keep the queue state machine total even when an injected/custom
        // executor returns an incomplete value instead of throwing.
        if (!result || typeof result !== 'object') result = { ok: false, status: 'uncertain', uncertain: true, error: '执行器未返回结果', output: '' };
        if (!['success', 'failed', 'timeout', 'cancelled', 'uncertain'].includes(result.status)) {
          result = { ...result, status: result.ok === true ? 'success' : 'uncertain', uncertain: result.ok === true ? Boolean(result.uncertain) : true };
        }
        run.commandStatus = result.status; run.exitCode = result.exitCode ?? null; run.message = result.error || '命令执行完成';
        store.saveRun(run, String(result.output || '').slice(-70000));
        if (controller.signal.aborted) finish(run, { status: 'cancelled', message: '执行已停止；已提交的请求无法撤回' });
        else if (run.guardId) { run.status = 'waiting_guard'; run.message = '命令已结束，等待守护确认新 IP'; store.saveRun(run); touch(); }
        else finish(run, { status: result.status, message: result.error || '命令执行完成' });
        entry.resolve?.(result);
      }).catch((error) => {
        deps.logError?.(error);
        entry.resolve?.({ ok: false, status: 'uncertain', uncertain: true, error: '执行结果保存失败，请确认实际结果' });
      }).finally(() => { controllers.delete(run.id); submitted.delete(run.id); running--; pump(); });
    }
  }
  function executeForGuard(id, guard) {
    const item = task(id);
    if (!item.enabled) return Promise.resolve({ ok: false, uncertain: false, error: 'Webhook 任务已停用' });
    let run = store.active(id);
    if (run && run.guardId !== guard.id) return Promise.resolve({ ok: false, uncertain: false, error: 'Webhook 任务已被其他流程占用' });
    if (run && completion.has(run.id)) return completion.get(run.id);
    if (queue.length >= store.settings().queueLimit) return Promise.resolve({ ok: false, uncertain: false, error: 'Webhook 执行队列已满' });
    run ||= newRun(item, 'dynamic', guard.id); run.snapshot = item;
    run.status = 'queued'; run.flowId = guard.flow?.id || ''; run.attempts = (run.attempts || 0) + 1;
    store.saveRun(run); touch();
    const promise = new Promise((resolve) => { queue.push({ run, resolve }); pump(); });
    completion.set(run.id, promise); promise.finally(() => completion.delete(run.id)); return promise;
  }
  function tick() {
    const byId = new Map(guards().map((guard) => [guard.id, guard]));
    for (const run of store.activeSummaries()) {
      if (!run.guardId || submitted.has(run.id) || run.status === 'queued') continue;
      const guard = byId.get(run.guardId);
      if (!guard) { finish(run, { status: 'cancelled', message: '关联守护已删除，流程结束' }); continue; }
      if (!guard.flow && !guard.manualRequested && !guard.pendingChange) {
        finish(run, { status: guard.status === 'healthy' ? 'success' : guard.enabled === false ? 'cancelled' : ['limit', 'command_error'].includes(guard.status) ? 'failed' : 'uncertain', message: guard.message || '守护流程已结束' });
      } else if (run.message !== guard.message) { run.message = guard.message; run.guardStatus = guard.status; store.saveRun(run); touch(); }
    }
    if (Date.now() - lastPrune >= 60000) { store.prune(); lastPrune = Date.now(); }
    pump();
  }
  // Persisted queued/running commands are never replayed after a restart.
  for (const run of store.actives()) {
    if (run.guardId && linked(run.taskId)?.id === run.guardId) { run.status = 'waiting_guard'; run.commandStatus = 'uncertain'; run.message = '服务已恢复，交由守护确认 IP，不重放旧命令'; store.saveRun(run); }
    else finish(run, { status: 'uncertain', message: '服务中断，执行结果待确认；未自动重试' });
  }
  return {
    store, save, snapshot, trigger, executeForGuard, tick,
    telegramTasks: () => { const names = new Map(deps.servers().map((server) => [server.id, server.name])); const latest = new Map(store.latestSummaries().map((run) => [run.taskId, run])); return store.taskSummaries().map((item) => ({ ...item, location: names.get(item.serverId) || (item.serverId ? '服务器已删除' : '面板本机'), run: latest.get(item.id), status: latest.get(item.id)?.status || 'idle' })); },
    choices: () => store.taskSummaries().map(({ id, name, enabled, timeout }) => ({ id, name, enabled, timeout })),
    detail: (id) => { const item = task(id); return { ...safeTask(item), command: deps.decrypt(item.commandEnc) }; },
    token: (id, reset = false) => {
      const item = task(id);
      if (reset) { const token = randomBytes(32).toString('base64url'); Object.assign(item, { tokenEnc: deps.encrypt(token), tokenHash: hash(token).toString('hex'), version: randomUUID() }); store.saveTask(item); touch(); }
      return deps.decrypt(item.tokenEnc);
    },
    authenticate(id, token, getTrigger = false) {
      const item = store.task(id);
      let valid = false;
      if (item?.externalEnabled && typeof token === 'string' && token.length <= 256) {
        const expected = Buffer.from(String(item.tokenHash || ''), 'hex');
        // Treat a damaged credential as invalid instead of allowing a
        // timingSafeEqual length exception to escape as an HTTP 500.
        valid = expected.length === 32 && timingSafeEqual(hash(token), expected);
      }
      if (!valid) fail('调用凭证无效或外部调用已关闭', 401);
      if (getTrigger && !item.allowGet) fail('未开启 GET 兼容调用，请使用 POST', 405);
      return item;
    },
    status: (id, runId) => {
      task(id); const run = runId ? getRun(runId) : store.active(id) || store.latestRun(id);
      if (run && run.taskId !== id) fail('执行记录不存在', 404);
      return safeRun(run);
    },
    output: (id) => ({ ...safeRun(getRun(id)), output: store.output(id) }),
    cancel(id) {
      const run = getRun(id); if (!active(run)) fail('执行已结束', 409);
      if (run.guardId) deps.stopGuard?.(run.guardId);
      if (controllers.has(id)) controllers.get(id).abort();
      else { finish(run, { status: 'cancelled', message: run.guardId ? '守护已停用；已提交请求无法撤回' : '已取消排队' }); pump(); }
      return safeRun(store.run(id));
    },
    remove(id) { task(id); if (store.active(id)) fail('任务仍在执行，请先停止', 409); if (linked(id)) fail('任务已关联动态守护，请先解除关联', 409); store.deleteTask(id); touch(); },
    settings(input) { store.saveSettings({ concurrency: integer(input.concurrency, 1, 50), queueLimit: integer(input.queueLimit, 10, 2000) }); touch(); pump(); },
    clear(id) { if (id) task(id); store.clear(id); touch(); }
  };
}

export function registerWebhookRoutes(app, service, { publicOnly = false } = {}) {
  const route = (handler) => async (req, res, next) => { try { res.set('Cache-Control', 'no-store'); await handler(req, res); } catch (error) { next(error); } };
  if (publicOnly) {
    const attempts = new Map(), calls = new Map();
    const limit = (map, key, maximum) => {
      const now = Date.now();
      let entry = map.get(key);
      if (!entry || entry.until <= now) {
        if (map.size >= 5000) { for (const [id, value] of map) if (value.until <= now) map.delete(id); if (map.size >= 5000) fail('调用过于频繁，请稍后重试', 429); }
        entry = { count: 0, until: now + 60000 }; map.set(key, entry);
      }
      if (++entry.count > maximum) fail('调用过于频繁，请稍后重试', 429);
    };
    const auth = (req, getTrigger) => {
      limit(attempts, req.socket?.remoteAddress || 'unknown', 600);
      const headerToken = /^Bearer /i.test(req.headers.authorization || '');
      const item = service.authenticate(req.params.id, headerToken ? req.headers.authorization.slice(7) : req.method === 'GET' ? req.query.token : '', getTrigger || (req.method === 'GET' && !headerToken));
      limit(calls, item.id, 120);
      return item;
    };
    app.post('/hooks/:id/run', route((req, res) => { auth(req); const result = service.trigger(req.params.id, 'webhook', req.headers['idempotency-key'] || ''); res.status(202).json({ accepted: true, executionId: result.run.id, status: result.run.status, duplicate: result.duplicate }); }));
    app.get('/hooks/:id/run', route((req, res) => { auth(req, true); const result = service.trigger(req.params.id, 'webhook', req.headers['idempotency-key'] || ''); res.status(202).json({ accepted: true, executionId: result.run.id, status: result.run.status, duplicate: result.duplicate }); }));
    app.get('/hooks/:id/status', route((req, res) => { auth(req); const run = service.status(req.params.id, req.query.executionId); res.json(run ? { executionId: run.id, status: run.status, commandStatus: run.commandStatus, guardStatus: run.guardStatus, created: run.created, startedAt: run.startedAt, finishedAt: run.finishedAt } : { status: 'idle' }); }));
    return;
  }
  app.get('/api/webhooks', route((req, res) => res.json(service.snapshot(req.query))));
  app.get('/api/webhooks/choices', route((_req, res) => res.json({ tasks: service.choices() })));
  app.put('/api/webhooks/settings', route((req, res) => { service.settings(req.body); res.json({ ok: true }); }));
  app.get('/api/webhooks/history', route((req, res) => res.json(service.store.history(req.query.kind, req.query.taskId, req.query.page))));
  app.post('/api/webhooks/history/clear', route((req, res) => { if (req.body?.confirm !== true) fail('请确认清理记录'); service.clear(req.body.taskId); res.json({ ok: true }); }));
  app.get('/api/webhooks/runs/:id', route((req, res) => res.json(service.output(req.params.id))));
  app.post('/api/webhooks/runs/:id/stop', route((req, res) => res.json(service.cancel(req.params.id))));
  app.post('/api/webhooks', route((req, res) => res.status(201).json(service.save(req.body))));
  app.get('/api/webhooks/:id', route((req, res) => res.json(service.detail(req.params.id))));
  app.put('/api/webhooks/:id', route((req, res) => res.json(service.save(req.body, req.params.id))));
  app.get('/api/webhooks/:id/token', route((req, res) => res.json({ token: service.token(req.params.id) })));
  app.post('/api/webhooks/:id/token/reset', route((req, res) => { if (req.body?.confirm !== true) fail('请确认重置 Token'); res.json({ token: service.token(req.params.id, true) }); }));
  app.post('/api/webhooks/:id/run', route((req, res) => res.status(202).json(service.trigger(req.params.id, req.auth?.username?.startsWith('telegram:') ? 'telegram' : 'panel', req.headers?.['idempotency-key'] || ''))));
  app.delete('/api/webhooks/:id', route((req, res) => { if (req.body?.confirm !== true) fail('请确认删除任务'); service.remove(req.params.id); res.json({ ok: true }); }));
}
