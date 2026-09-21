import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { domainToASCII } from 'node:url';
import { beijingDate, validRenewalDate, renewalDays, renewalStage, renewalAmount, renewalIdentityIndex, renewalDuplicateField, renewalBotIds, DEFAULT_RENEWAL_SETTINGS, RENEWAL_CURRENCIES } from '../shared/renewals.js';

const MAX_RECORDS = 5000;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const clean = (value, max) => String(value ?? '').trim().slice(0, max);

export function validateRenewalSettings(input, bots, previousBotIds = []) {
  if (!Array.isArray(input.days) || input.days.length > 20 || input.days.some((day) => !Number.isInteger(day) || day < 0 || day > 365)) fail('提醒天数须为 0–365 的整数，最多 20 个');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || '')) fail('请选择有效的通知时间');
  if (input.botIds != null && (!Array.isArray(input.botIds) || input.botIds.length > 50 || input.botIds.some((id) => typeof id !== 'string' || !id))) fail('请选择有效的通知机器人');
  let botIds = [...new Set(input.botIds || [])];
  if (bots) {
    const available = new Set(bots.map((bot) => bot.id));
    if (botIds.some((id) => !available.has(id) && !previousBotIds.includes(id))) fail('关联的通知机器人不存在，请重新选择');
    botIds = botIds.filter((id) => available.has(id));
  }
  return { days: [...new Set(input.days)].sort((a, b) => b - a), time: input.time, botIds };
}

export function normalizeRenewalState(state = {}) {
  let renewalSettings;
  try { renewalSettings = validateRenewalSettings(state.renewalSettings || DEFAULT_RENEWAL_SETTINGS); }
  catch { renewalSettings = structuredClone(DEFAULT_RENEWAL_SETTINGS); }
  return { renewals: Array.isArray(state.renewals) ? state.renewals.slice(0, MAX_RECORDS) : [], renewalSettings,
    renewalRevision: Number.isSafeInteger(state.renewalRevision) ? state.renewalRevision : 0 };
}

export function renewalSnapshot(state) {
  return { renewals: (state.renewals || []).map(({ deliveries, immediateDate, ...record }) => record),
    renewalSettings: state.renewalSettings || DEFAULT_RENEWAL_SETTINGS, renewalRevision: state.renewalRevision || 0 };
}

function validateAddress(value) {
  const address = clean(value, 254);
  if (!address || net.isIP(address)) return address;
  if (/[\s/:?#@\\]/.test(address)) fail('请填写有效的 IP 或域名，不含协议、端口和路径');
  const domain = domainToASCII(address.replace(/\.$/, '')).toLowerCase();
  if (!domain || domain.length > 253 || !domain.includes('.') || /^\d+(\.\d+){3}$/.test(domain)
    || domain.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) fail('请填写有效的 IP 或域名，不含协议、端口和路径');
  return domain;
}

export function validateRenewal(input, bots, previous = null, now = Date.now()) {
  if (input.notificationEnabled !== undefined && typeof input.notificationEnabled !== 'boolean') fail('请选择有效的续费通知开关');
  const notificationEnabled = input.notificationEnabled ?? previous?.notificationEnabled ?? true;
  const name = clean(input.name, 120);
  if (!name) fail('服务器名称不能为空');
  const dueDate = clean(input.dueDate, 32);
  if (dueDate && !validRenewalDate(dueDate)) fail('请选择有效的到期日期（2000–2199 年）');
  const price = clean(input.price, 32);
  if (price && (!/^\d{1,10}(\.\d{1,2})?$/.test(price) || !Number.isFinite(Number(price)))) fail('续费价格须为非负金额，最多两位小数');
  if (!RENEWAL_CURRENCIES.includes(input.currency)) fail('请选择支持的币种');
  const requestedBots = [...new Set(Array.isArray(input.botIds) ? input.botIds : [])];
  const availableBots = new Set(bots.map((bot) => bot.id));
  if (requestedBots.length > 50 || requestedBots.some((id) => typeof id !== 'string' || (!availableBots.has(id) && !previous?.botIds?.includes(id)))) fail('关联的通知机器人不存在，请重新选择');
  const botIds = requestedBots.filter((id) => availableBots.has(id));
  const reset = !previous || previous.dueDate !== dueDate;
  const deliveries = reset ? {} : Object.fromEntries(Object.entries(previous.deliveries || {}).filter(([key]) => {
    // Keep inherited deliveries across ordinary edits and notification mode
    // changes so choosing the same recipient again does not replay a node.
    try { return availableBots.has(JSON.parse(key)[0]); } catch { return false; }
  }));
  return { id: previous?.id || randomUUID(), version: randomUUID(), name, address: validateAddress(input.address),
    price: price ? Number(price).toFixed(2) : '', currency: input.currency, dueDate, botIds, notificationEnabled, note: clean(input.note, 1000), deliveries,
    immediateDate: reset || (notificationEnabled && previous?.notificationEnabled === false) || botIds.some((id) => !previous?.botIds?.includes(id)) ? beijingDate(now) : previous.immediateDate,
    notificationError: deliveryWarning(deliveries), createdAt: previous?.createdAt || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
}

function deliveryWarning(deliveries) {
  const states = Object.values(deliveries);
  if (states.some((entry) => entry.status === 'uncertain')) return '部分 TG 通知结果未确认，本节点不重复发送';
  if (states.some((entry) => entry.status === 'failed' && entry.attempts >= 3)) return '部分 TG 通知失败，已达重试上限；请检查机器人及接收人配置';
  if (states.some((entry) => entry.status === 'failed')) return '部分 TG 通知失败，将有限重试；请检查机器人及接收人配置';
  if (states.some((entry) => entry.status === 'sending')) return '通知正在发送；若进程中断，本节点不会重复发送';
  return '';
}

function assertUniqueRenewal(item, records) {
  const field = renewalDuplicateField(item, renewalIdentityIndex(records, item.id));
  if (field) fail(field === 'name' ? '服务器名称已存在，请使用其他名称' : 'IP / 域名已存在，请勿重复添加', 409);
}

export function registerRenewalRoutes(app, deps, service) {
  const route = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  const snapshot = () => ({ ...renewalSnapshot(deps.read()), bots: deps.bots().map((bot) => ({ id: bot.id, name: bot.name, enabled: bot.enabled !== false, configured: Boolean(bot.tokenEnc), hasRecipients: Boolean(bot.userIds?.length) })) });
  app.get('/api/renewals', route((_req, res) => res.json(snapshot())));
  app.put('/api/renewals/settings', route((req, res) => {
    const bots = deps.bots();
    deps.update((draft) => {
      if (req.body.revision !== draft.renewalRevision) fail('记录已更新，请刷新后再保存设置', 409);
      const previous = draft.renewalSettings.botIds || [];
      const settings = validateRenewalSettings({ ...req.body, botIds: req.body.botIds ?? previous }, bots, previous);
      if (settings.botIds.some((id) => !previous.includes(id))) {
        const today = beijingDate();
        for (const item of draft.renewals) if (item.notificationEnabled !== false && !item.botIds?.length) item.immediateDate = today;
      }
      draft.renewalSettings = settings;
    });
    res.json(snapshot());
    service.tick();
  }));
  app.post('/api/renewals', route((req, res) => {
    const item = validateRenewal(req.body, deps.bots());
    deps.update((draft) => {
      if (draft.renewals.length >= MAX_RECORDS) fail('最多保存 5000 条续费记录');
      assertUniqueRenewal(item, draft.renewals);
      draft.renewals.push(item);
    });
    res.json(snapshot());
    service.tick();
  }));
  app.put('/api/renewals/:id', route((req, res) => {
    const bots = deps.bots();
    deps.update((draft) => {
      const index = draft.renewals.findIndex((item) => item.id === req.params.id);
      if (index < 0) fail('续费记录不存在', 404);
      if (draft.renewals[index].version !== req.body.version) fail('记录已被修改，请重新打开编辑', 409);
      const item = validateRenewal(req.body, bots, draft.renewals[index]);
      assertUniqueRenewal(item, draft.renewals);
      draft.renewals[index] = item;
    });
    res.json(snapshot());
    service.tick();
  }));
  app.post('/api/renewals/delete', route((req, res) => {
    if (req.body.confirm !== true) fail('请先确认删除');
    deps.update((draft) => {
      if (req.body.revision !== draft.renewalRevision) fail('记录已更新，请重新确认删除范围', 409);
      if (req.body.all === true) draft.renewals = [];
      else {
        if (!Array.isArray(req.body.ids) || !req.body.ids.length || req.body.ids.length > MAX_RECORDS) fail('请选择要删除的记录');
        const ids = new Set(req.body.ids);
        draft.renewals = draft.renewals.filter((item) => !ids.has(item.id));
      }
    });
    res.json(snapshot());
  }));
}

const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function renewalMessage(items, now = Date.now()) {
  return '🔔 <b>服务器续费提醒</b>\n\n' + items.map((item) => {
    const days = renewalDays(item.dueDate, now);
    const status = days === 0 ? '🔴 <b>今天到期</b>' : days === 1 ? '🟠 <b>明天到期</b>' : `🟡 <b>还有 ${days} 天到期</b>`;
    return [`🖥 <b>${escapeHtml(item.name)}</b>`, item.address ? `🌐 地址：${escapeHtml(item.address)}` : '',
      item.price !== '' ? `💰 续费：${escapeHtml(renewalAmount(item))}` : '', `📅 到期：${item.dueDate}`, status].filter(Boolean).join('\n');
  }).join('\n\n');
}

// One scheduler, bounded sequential batches, no per-record timers. Persist the
// attempt before sending: an interrupted/ambiguous send is never blindly replayed.
export function createRenewalService(deps) {
  let running = null, rerun = false;
  const now = () => deps.now?.() ?? Date.now();
  const eligible = (item, settings, key, time) => {
    const stage = renewalStage(item, settings, time);
    if (stage === null) return null;
    const localTime = new Date(time + 8 * 3600000).toISOString().slice(11, 16);
    if (localTime < settings.time && item.immediateDate !== beijingDate(time)) return null;
    const delivery = item.deliveries?.[key];
    if (delivery?.stage <= stage) {
      if (delivery.status !== 'failed' || delivery.stage < stage || delivery.attempts >= 3 || delivery.retryAt > time) return null;
    }
    return stage;
  };
  async function run() {
    let batches = 0;
    do {
      rerun = false;
      const snapshot = deps.read(), time = now();
      if (!snapshot.renewals?.length || !snapshot.renewalSettings.days.length) return;
      const candidates = snapshot.renewals.filter((item) => renewalBotIds(item, snapshot.renewalSettings).length && renewalStage(item, snapshot.renewalSettings, time) !== null);
      if (!candidates.length) return;
      const groups = new Map();
      const bots = new Map(deps.bots().filter((bot) => bot.enabled !== false && bot.tokenEnc).map((bot) => [bot.id, bot]));
      let queued = 0;
      candidateLoop: for (const item of candidates) for (const botId of renewalBotIds(item, snapshot.renewalSettings)) {
        const bot = bots.get(botId);
        if (!bot) continue;
        for (const chatId of new Set(bot.userIds || [])) {
          const key = JSON.stringify([botId, String(chatId)]);
          if (eligible(item, snapshot.renewalSettings, key, time) === null) continue;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item.id);
          // Bound queue memory as well as network work; unsent records remain
          // eligible for the next minute instead of allocating a huge fan-out.
          if (++queued >= 200) break candidateLoop;
        }
      }
      for (const [key, ids] of groups) {
        const [botId, chatId] = JSON.parse(key);
        let cursor = 0;
        while (cursor < ids.length && batches < 20) {
          const current = deps.read(), at = now();
          const bot = deps.bots().find((entry) => entry.id === botId && entry.enabled !== false && entry.tokenEnc && entry.userIds?.map(String).includes(chatId));
          if (!bot) break;
          const byId = new Map(current.renewals.map((item) => [item.id, item]));
          const chunk = [];
          while (cursor < ids.length) {
            const item = byId.get(ids[cursor]);
            if (!item || !renewalBotIds(item, current.renewalSettings).includes(botId) || eligible(item, current.renewalSettings, key, at) === null) { cursor++; continue; }
            if (chunk.length && renewalMessage([...chunk, item], at).length > 3500) break;
            chunk.push(item); cursor++;
            if (chunk.length >= 10) break;
          }
          if (!chunk.length) continue;
          const attemptId = randomUUID();
          deps.update((draft) => {
            for (const item of chunk) {
              const record = draft.renewals.find((entry) => entry.id === item.id);
              record.deliveries ||= {};
              const stage = eligible(record, draft.renewalSettings, key, at);
              const attempts = record.deliveries[key]?.stage === stage ? record.deliveries[key].attempts || 0 : 0;
              record.deliveries[key] = { stage, status: 'sending', attempts: attempts + 1, attemptId, at };
              record.notificationError = deliveryWarning(record.deliveries);
            }
          });
          batches++;
          let failure;
          try { await deps.send(bot, chatId, renewalMessage(chunk, at)); }
          catch (error) { failure = error; }
          deps.update((draft) => {
            for (const original of chunk) {
              const record = draft.renewals.find((entry) => entry.id === original.id);
              const delivery = record?.deliveries?.[key];
              if (!delivery || delivery.attemptId !== attemptId) continue;
              if (!failure) { delivery.status = 'sent'; }
              else {
                // A definite API rejection may retry; network timeouts are
                // ambiguous and must not produce duplicate reminders on restart.
                delivery.status = failure.definite ? 'failed' : 'uncertain';
                delivery.retryAt = now() + Math.max(5 * 60000, Number(failure.retryAfter || 0) * 1000);
              }
              record.notificationError = deliveryWarning(record.deliveries);
            }
          });
        }
        if (batches >= 20) break;
      }
    } while (rerun && batches < 20);
  }
  return { tick() {
    if (running) { rerun = true; return running; }
    running = run().catch((error) => deps.logError?.(error)).finally(() => { running = null; });
    return running;
  } };
}
