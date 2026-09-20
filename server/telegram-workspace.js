import { randomBytes } from 'node:crypto';
import { telegramScopeAllowed } from '../shared/telegram-permissions.js';
import { WORKSPACE_SEARCH, filterWorkspaceRecords } from '../shared/workspace-search.js';
import { parseIpBatch } from './orchestration.js';
import net from 'node:net';

const sections = {
  guards: ['DNS 守护', 'dnsGuards'], dynamic: ['动态 IP 守护', 'dynamicGuards'],
  probes: ['探针节点', 'probes'], targets: ['检查目标', 'probeTargets'], policies: ['切换策略', 'failoverPolicies'],
  incidents: ['故障事件', 'incidents'], assets: ['IP 资产', 'ipAssets'], pools: ['备用 IP 池', 'ipPools'],
  usage: ['IP 使用记录', 'ipUsageRecords'], dns: ['解析管理', 'dnsBindings'], automation: ['自动化任务', 'automationTasks'],
  runs: ['自动化执行记录', 'automationRuns']
};
const resources = { guards: 'dns-guards', probes: 'probes', targets: 'probe-targets', policies: 'failover-policies', pools: 'ip-pools', assets: 'ip-assets' };
const labels = { online: '在线', offline: '离线', pending: '待接入', revoked: '已吊销', healthy: '正常', down: '故障', unknown: '未检查',
  queued: '待执行', checking: '检查中', waiting_probe: '等待探针', waiting_ip: '等待备用 IP', waiting_for_ip: '等待备用 IP',
  waiting_new_ip: '等待新 IP', waiting: '等待中', executing: '执行中', observing: '观察中', disabled: '已停用', command_error: '命令异常', resolve_error: '解析异常', cooldown: '冷却中', daily_limit: '达到每日上限',
  succeeded: '已完成', recovered: '已恢复', replaced: '已补位', degraded: '容量不足', error: '异常', failed: '失败',
  pending_approval: '待确认', allocating: '分配中', automating: '执行自动化', dns_updating: '写入 DNS', verifying: '验证中',
  stabilizing: '等待生效', rolling_back: '回滚中', rolled_back: '已回滚', consumed: '已使用', discarded: '已丢弃',
  done: '已结束', running: '执行中', cancelled: '已取消', processing: '处理中',
  resolving: '正在解析', probe_failed: '检查失败，待重试', capacity: '达到 IP 上限', ready: '检查通过，待写入', synced: '已同步' };
const finished = new Set(['succeeded', 'recovered', 'rolled_back', 'cancelled', 'done']);
const bad = new Set(['offline', 'down', 'error', 'failed', 'degraded', 'waiting_probe', 'waiting_ip', 'waiting_for_ip', 'unhealthy', 'command_error', 'resolve_error', 'daily_limit', 'query_error', 'limit']);
const dynamicLabels = { waiting_ip: '等待新 IP', verifying: '验证新 IP', executing: '执行换 IP', query_error: '查询异常', limit: '达到每日上限' };
const searchSection = (section) => ({ probes: 'nodes', dns: 'bindings' })[section] || section;
const short = (value, max = 80) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);
const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无';
const scopeOf = (section) => section === 'runs' ? 'automation' : section;
const status = (item, section) => item.enabled === false ? '已停用' : section === 'probes' && item.status === 'online' && Date.now() - Date.parse(item.lastSeenAt || 0) > 90000 ? '离线' : (section === 'dynamic' && dynamicLabels[item.status]) || labels[item.status || item.health] || item.status || item.health || '已配置';
const name = (item) => short(item.name || item.taskName || item.targetName || item.address || item.domain || item.id);
const sameValues = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const identity = (item) => JSON.stringify([item.accountId, item.domain, item.recordType]);

export function createTelegramWorkspace(deps) {
  const sessions = new Map(), buttons = new Map(), busy = new Set(), queue = [];
  let publicUrl = '';
  try {
    const parsed = new URL(deps.publicUrl);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) publicUrl = parsed.href;
  } catch { /* An optional invalid URL must not break menu navigation. */ }
  let running = 0;
  const ttl = 10 * 60 * 1000;
  function cleanup() {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expiresAt < now) sessions.delete(key);
    for (const [key, value] of buttons) if (value.expiresAt < now) buttons.delete(key);
    while (buttons.size > 20000) buttons.delete(buttons.keys().next().value);
  }
  const keyFor = (settings, chat, from) => `${settings.id}:${chat.id}:${from.id}`;
  function button(ctx, text, action) {
    const id = randomBytes(10).toString('hex');
    buttons.set(id, { ...action, sessionKey: ctx.key, expiresAt: Date.now() + ttl });
    return { text, callback_data: `tg2:${id}` };
  }
  const legacy = (text, callback_data) => ({ text, callback_data });
  function freshSettings(ctx) {
    return deps.readState(['telegramBots']).telegramBots.find((bot) => bot.id === ctx.settings.id);
  }
  function allowed(ctx, section) { return telegramScopeAllowed(ctx.settings, scopeOf(section)); }
  function canWrite(ctx) { return ['owner', 'admin', 'operator'].includes(deps.role(ctx.settings, ctx.from, ctx.chat)); }
  function assertAccess(ctx, section, write = false, op = '') {
    const settings = freshSettings(ctx);
    if (!settings || !deps.authorized(settings, ctx.from, ctx.chat) || !telegramScopeAllowed(settings, scopeOf(section))) throw new Error('此功能已关闭或你没有访问权限');
    ctx.settings = settings;
    if (write && !canWrite(ctx) && !(section === 'incidents' && ['execute', 'rollback'].includes(op) && deps.role(settings, ctx.from, ctx.chat) === 'approver')) throw new Error('当前用户没有操作权限');
  }
  function records(ctx, section) {
    const key = sections[section][1];
    let items = deps.readState([key])[key] || [];
    if (section === 'automation') items = items.filter((item) => ctx.settings.automationTaskIds?.includes(item.id));
    if (section === 'runs') items = items.filter((item) => ctx.settings.automationTaskIds?.includes(item.taskId));
    return items;
  }
  function get(ctx, section, id) {
    const item = records(ctx, section).find((entry) => entry.id === id);
    if (!item) throw new Error('记录已删除或不在当前机器人的授权范围内');
    return item;
  }
  async function show(ctx, text, rows, forceNew = false) {
    const body = { chat_id: ctx.chat.id, text: String(text).slice(0, 3900), reply_markup: { inline_keyboard: rows.filter((row) => row.length) } };
    if (ctx.messageId && !forceNew) {
      try { return await deps.call(ctx.token, 'editMessageText', { ...body, message_id: ctx.messageId }); }
      catch (error) { if (/message is not modified/i.test(error.message)) return; if (!/message.*(not found|can't be edited|cannot be edited)/i.test(error.message)) throw error; }
    }
    return deps.call(ctx.token, 'sendMessage', body);
  }
  const rootButton = (ctx) => button(ctx, '主菜单', { kind: 'root' });
  const listButton = (ctx, section) => button(ctx, '返回列表', { kind: 'list', section, page: ctx.session.pages[section] || 0 });
  function webButton(ctx, section, id = '') {
    if (!publicUrl) return button(ctx, '编辑规则', { kind: 'web', section, id });
    const url = new URL(publicUrl);
    url.searchParams.set('tgSection', section); if (id) url.searchParams.set('tgItem', id);
    return { text: '打开网页编辑', url: url.href };
  }
  async function root(ctx) {
    const link = (section, title) => allowed(ctx, section) ? button(ctx, title, { kind: 'list', section, page: 0 }) : null;
    const group = (title, members) => members.some((key) => allowed(ctx, key)) ? button(ctx, title, { kind: 'group', members }) : null;
    const rows = [
      [allowed(ctx, 'overview') ? button(ctx, '系统总览', { kind: 'overview', section: 'overview' }) : null, link('incidents', '故障事件')],
      [link('guards', 'DNS 守护'), link('dynamic', '动态 IP 守护')],
      [group('探针与检查', ['probes', 'targets', 'policies']), group('IP 资产与备用池', ['assets', 'pools', 'usage'])],
      [link('dns', '解析管理'), link('automation', '自动化任务')]
    ].map((row) => row.filter(Boolean));
    return show(ctx, `NuroSSH 操作菜单\n选择模块查看状态或执行操作。${rows.every((row) => !row.length) ? '\n当前机器人未开放管理功能；任务通知仍按各自配置发送。' : ''}`, rows);
  }
  async function overview(ctx) {
    const state = deps.readState(['probes', 'incidents', 'dnsGuards', 'dynamicGuards', 'ipAssets']);
    return show(ctx, `系统总览\n在线探针：${(state.probes || []).filter((item) => item.enabled !== false && status(item, 'probes') === '在线').length}\n活动故障：${(state.incidents || []).filter((item) => !finished.has(item.status)).length}\nDNS 守护：${state.dnsGuards?.length || 0}\n动态 IP 守护：${state.dynamicGuards?.length || 0}\nIP 资产：${state.ipAssets?.length || 0}`, [[button(ctx, '刷新', { kind: 'overview', section: 'overview' }), rootButton(ctx)]]);
  }
  async function list(ctx, section, page = 0) {
    const filter = ctx.session.filters[section] || {};
    const query = (filter.query || '').trim().toLowerCase();
    const related = query && section === 'pools' ? deps.readState(['ipAssets']) : {};
    const searched = section === 'automation' || section === 'runs'
      ? records(ctx, section).filter((item) => !query || [item.name, item.taskName].some((value) => String(value || '').toLowerCase().includes(query)))
      : filterWorkspaceRecords(searchSection(section), records(ctx, section), query, related);
    const items = filter.bad ? searched.filter((item) => bad.has(item.status || item.health) || status(item, section) === '离线') : searched;
    const pages = Math.max(1, Math.ceil(items.length / 8));
    page = Math.min(pages - 1, Math.max(0, page || 0)); ctx.session.pages[section] = page;
    const rows = items.slice(page * 8, page * 8 + 8).map((item) => [button(ctx, `${short(name(item), 38)} · ${status(item, section)}`, { kind: 'detail', section, id: item.id })]);
    rows.push([button(ctx, '搜索', { kind: 'search', section }), button(ctx, filter.bad ? '显示全部' : '仅看异常', { kind: 'filter', section })]);
    if (filter.query) rows.push([button(ctx, '清除搜索', { kind: 'clearSearch', section })]);
    if (pages > 1) rows.push([...(page ? [button(ctx, '上一页', { kind: 'list', section, page: page - 1 })] : []), ...(page + 1 < pages ? [button(ctx, '下一页', { kind: 'list', section, page: page + 1 })] : [])]);
    if (canWrite(ctx)) {
      if (section === 'assets') rows.push([legacy('批量添加 IP', 'asset_add:new')]);
      if (section === 'pools') rows.push([legacy('新建备用池', 'pool_create:new')]);
      if (section === 'dns') rows.push([button(ctx, '新建解析', { kind: 'createDns', section })]);
      if (section === 'incidents') rows.push([button(ctx, '清理已结束事件', { kind: 'confirm', section, op: 'clear' })]);
    }
    if (section === 'automation') rows.push([button(ctx, '执行记录', { kind: 'list', section: 'runs', page: 0 })]);
    rows.push([button(ctx, '刷新', { kind: 'list', section, page }), rootButton(ctx)]);
    return show(ctx, `${sections[section][0]} · ${items.length} 条\n第 ${page + 1} / ${pages} 页${filter.query ? `\n搜索：${short(filter.query)}` : ''}${filter.bad ? '\n仅显示异常' : ''}${!items.length ? '\n暂无匹配记录' : ''}`, rows);
  }
  async function detail(ctx, section, id) {
    const item = get(ctx, section, id), rows = [];
    const lines = [`${sections[section][0]}：${name(item)}`, `状态：${section === 'dynamic' && item.status === 'waiting_ip' ? '等待新 IP' : status(item, section)}`];
    const action = (text, kind, op) => button(ctx, text, { kind, section, id, op });
    if (item.domain) lines.push(`域名：${short(item.domain, 253)} · ${item.recordType || ''}`);
    if (item.address) lines.push(`地址：${short(item.address, 253)}`);
    if (section === 'guards') {
      lines.push(`活动 IP：${item.currentValues?.length || 0} / ${item.maxActiveIps || 50}`, `来源：${item.sources?.length || 0} 个`, `最近检查：${date(item.lastCheckAt)}`);
      lines.push(`备用池补位：${item.poolFillMode === 'fill' ? `补满 ${item.poolTargetCount || item.maxActiveIps || 50} 个健康 IP` : '故障补位'}`);
      rows.push([...(canWrite(ctx) ? [action('检查并修复', 'action', 'check')] : []), action('管理 IP', 'ips')]);
      rows.push([action('来源状态', 'sources'), action('检查记录', 'history')]);
    } else if (section === 'dynamic') {
      lines.push(`当前 IP：${short(item.currentIp || item.currentAddress || item.lastAddress || '暂无')}`, `下次执行：${date(item.nextAt)}`, `等待截止：${date(item.flow?.deadlineAt)}`);
      if (canWrite(ctx)) rows.push([action('立即检查', 'action', 'check'), action('手动换 IP', 'confirm', 'change')]);
      rows.push([action('执行记录', 'history')]);
    } else if (section === 'probes') lines.push(`地区 / 线路：${short(item.region)} / ${short(item.carrier)}`, `最后心跳：${date(item.lastSeenAt)}`);
    else if (section === 'targets') {
      const probes = deps.readState(['probes']).probes || [];
      lines.push(`最近检查：${date(item.lastCheckAt)}`, ...(item.probeIds || []).map((probeId) => `${short(probes.find((probe) => probe.id === probeId)?.name || probeId)}：${item.observations?.[probeId] ? item.observations[probeId].ok ? '成功' : '未通过' : '无结果'}`));
      if (canWrite(ctx)) rows.push([action('立即检查', 'action', 'check')]);
    } else if (section === 'policies') {
      const related = deps.readState(['ipPools', 'automationTasks', 'probeTargets']);
      lines.push(`备用池：${(item.poolIds || []).map((poolId) => name(related.ipPools.find((pool) => pool.id === poolId) || { id: poolId })).join('、') || '无'}`,
        `自动化：${short(related.automationTasks?.find((task) => task.id === item.automationTaskId)?.name || '无')}`,
        `检查目标：${related.probeTargets.filter((target) => target.policyId === id).map(name).join('、') || '无'}`);
    } else if (section === 'assets') {
      const pools = deps.readState(['ipPools']).ipPools.filter((pool) => pool.assetIds?.includes(id));
      lines.push(`关联备用池：${pools.map(name).join('、') || '无'}`);
      if (canWrite(ctx)) rows.push([action('删除空闲 IP', 'confirm', 'delete')]);
    } else if (section === 'pools') {
      lines.push(`库存：${item.assetIds?.length || 0} 个 IP`, `预警数量：${item.alertEnabled ? (item.alertThresholds || []).join('、') : '未启用'}`);
      lines.push('DNS 守护取用：跟随守护设置', `故障切换取用：${item.allocationMode === 'all' ? '全部可用 IP' : item.allocationMode === 'count' ? `每次 ${item.allocationCount} 个` : '每次一个'}`);
      rows.push([action('查看 IP', 'ips')]);
      if (canWrite(ctx)) rows.push([legacy('批量加入 IP', `pool_add:${id}`), legacy('修改预警', `pool_alert:${id}`)]);
    } else if (section === 'dns') {
      lines.push(`记录数：${(item.currentValues || item.recordValues || item.backupIps || []).length}`, `最近同步：${date(item.lastSyncAt)}`);
      rows.push([action('管理记录', 'ips')]);
    } else if (section === 'incidents') {
      lines.push(`备用 IP：${(item.allocatedIps || []).join(', ') || '尚未分配'}`);
      const role = deps.role(ctx.settings, ctx.from, ctx.chat);
      if (canWrite(ctx) || role === 'approver') {
        if (['pending_approval', 'failed', 'observing'].includes(item.status)) rows.push([action('确认执行 / 重试', 'confirm', 'execute')]);
        if (item.dnsChangeIds?.length && item.status !== 'rolled_back') rows.push([action('回滚', 'confirm', 'rollback')]);
        if (canWrite(ctx)) rows.push([action('清理事件', 'confirm', 'delete')]);
      }
    } else if (section === 'automation') {
      lines.push(`步骤：${item.steps?.length || 0}`, `并发：${item.concurrency || 1}`);
      if (canWrite(ctx)) rows.push([legacy('输入目标并执行', `task:${id}`)]);
    } else if (section === 'runs') {
      const live = deps.liveJob?.(id);
      lines.push(`总数：${live?.results.length ?? item.total ?? 0}`, `成功：${live?.results.filter((result) => result.ok).length ?? item.ok ?? 0}`, `失败：${live?.results.filter((result) => result.status === 'error').length ?? item.error ?? 0}`);
      if (live && live.status !== 'done' && canWrite(ctx)) rows.push([action('取消执行', 'confirm', 'canceljob')]);
    } else if (section === 'usage') lines.push(`使用时间：${date(item.startedAt)}`, `结束时间：${date(item.finishedAt)}`, `备用池：${short(item.poolName)}`);
    if (item.message) lines.push(short(item.message, 500));
    if (item.lastError) lines.push(`异常：${short(item.lastError, 500)}`);
    if (['guards', 'dynamic', 'probes', 'targets', 'policies', 'pools'].includes(section) && canWrite(ctx)) rows.push([button(ctx, item.enabled === false ? '启用' : '暂停', { kind: 'confirm', section, id, op: 'toggle', enabled: item.enabled === false }), webButton(ctx, section, id)]);
    rows.push([action('刷新', 'detail'), listButton(ctx, section), rootButton(ctx)]);
    return show(ctx, lines.join('\n'), rows);
  }
  async function ips(ctx, section, id, page = 0) {
    const item = get(ctx, section, id);
    const assetIds = section === 'pools' ? new Set(item.assetIds || []) : null;
    const values = section === 'pools' ? deps.readState(['ipAssets']).ipAssets.filter((asset) => assetIds.has(asset.id)).map((asset) => asset.address)
      : item.currentValues || item.recordValues || item.backupIps || [];
    const pages = Math.max(1, Math.ceil(values.length / 15)); page = Math.min(pages - 1, Math.max(0, page));
    const rows = [];
    if (canWrite(ctx) && section !== 'pools') {
      rows.push([button(ctx, '读取远程', { kind: 'action', section, id, op: 'sync' })]);
      if (['A', 'AAAA'].includes(item.recordType)) rows.push(['添加', '删除', '替换全部'].map((title, index) => button(ctx, `${title} IP`, { kind: 'input', section, id, op: ['add', 'remove', 'replace'][index] })));
    }
    if (pages > 1) rows.push([...(page ? [button(ctx, '上一页', { kind: 'ips', section, id, page: page - 1 })] : []), ...(page + 1 < pages ? [button(ctx, '下一页', { kind: 'ips', section, id, page: page + 1 })] : [])]);
    rows.push([button(ctx, '返回详情', { kind: 'detail', section, id }), rootButton(ctx)]);
    return show(ctx, `${name(item)} · ${values.length} 条记录\n当前保存的数据，第 ${page + 1}/${pages} 页\n\n${values.slice(page * 15, page * 15 + 15).map((value) => short(value, 180)).join('\n') || '暂无记录'}`, rows);
  }
  async function history(ctx, section, id, page = 0) {
    const item = get(ctx, section, id), key = section === 'guards' ? 'dnsGuardRuns' : 'dynamicGuardRuns';
    let result;
    if (deps.readGuardHistoryPage) result = deps.readGuardHistoryPage(key, id, page);
    else {
      const items = (deps.readState([key])[key] || []).filter((run) => run.guardId === id);
      const pages = Math.max(1, Math.ceil(items.length / 8)); page = Math.min(pages - 1, Math.max(0, page));
      result = { records: items.slice(page * 8, page * 8 + 8), total: items.length, page, pages };
    }
    const { records: items, total, pages } = result; page = result.page;
    return show(ctx, `${name(item)} · 执行记录 ${total} 条\n第 ${page + 1}/${pages} 页\n\n${items.map((run) => `${date(run.finishedAt || run.startedAt)} · ${status(run, section)}\n${short(run.message, 180)}`).join('\n\n') || '暂无记录'}`,
      [[...(page ? [button(ctx, '上一页', { kind: 'history', section, id, page: page - 1 })] : []), ...(page + 1 < pages ? [button(ctx, '下一页', { kind: 'history', section, id, page: page + 1 })] : [])], [button(ctx, '返回详情', { kind: 'detail', section, id }), rootButton(ctx)]]);
  }
  function call(ctx, method, route, params = {}, body = {}) { return deps.invoke(method, route, params, body, `telegram:${ctx.settings.id}:${ctx.from.id}`); }
  async function execute(ctx, action) {
    const { section, id, op } = action;
    assertAccess(ctx, section, true, op);
    if (op === 'clear') return deps.clearFinishedIncidents(action.ids || [], `telegram:${ctx.settings.id}:${ctx.from.id}`);
    if (op === 'create') return call(ctx, 'POST', '/api/orchestration/:resource', { resource: 'dns-bindings' }, { ...action.body, expectedValues: [] });
    const item = get(ctx, section, id);
    if (action.address && item.address !== action.address) throw new Error('IP 已变更，请重新确认');
    if (action.identity && identity(item) !== action.identity) throw new Error('目标配置已变化，请重新确认');
    if (op === 'toggle') {
      if ((item.enabled !== false) === action.enabled) throw new Error('状态已经变化，请刷新后操作');
      if (section === 'dynamic') return call(ctx, 'POST', '/api/dynamic-guards/:id/enabled', { id }, { enabled: action.enabled });
      return call(ctx, 'PUT', '/api/orchestration/:resource/:id', { resource: resources[section], id }, { ...item, enabled: action.enabled });
    }
    if (op === 'check') return call(ctx, 'POST', section === 'guards' ? '/api/dns-guards/:id/check-now' : section === 'dynamic' ? '/api/dynamic-guards/:id/check' : '/api/probe-targets/:id/check-now', { id });
    if (op === 'change') return call(ctx, 'POST', '/api/dynamic-guards/:id/change', { id }, { confirm: 'change-ip' });
    if (op === 'sync') return call(ctx, 'POST', section === 'guards' ? '/api/dns-guards/:id/sync' : '/api/dns-bindings/:id/sync', { id });
    if (op === 'write') {
      if (!sameValues(item.currentValues || [], action.expectedValues)) throw new Error('记录已变化，请重新读取并确认');
      if (section === 'guards') return call(ctx, 'PUT', '/api/dns-guards/:id/remote-values', { id }, { values: action.values, expectedValues: action.expectedValues });
      if (item.ddnsSources?.length) throw new Error('此解析配置了动态来源，请在网页编辑，避免手动记录与来源冲突');
      return call(ctx, 'PUT', '/api/orchestration/:resource/:id', { resource: 'dns-bindings', id }, { ...item, backupIps: action.values, recordValues: action.values, updateMode: 'replace', expectedValues: action.expectedValues });
    }
    if (section === 'incidents') {
      if (op === 'delete') return deps.clearFinishedIncidents([id], `telegram:${ctx.settings.id}:${ctx.from.id}`);
      return call(ctx, 'POST', op === 'rollback' ? '/api/incidents/:id/rollback' : '/api/incidents/:id/execute', { id });
    }
    if (op === 'delete' && section === 'assets') return call(ctx, 'DELETE', '/api/orchestration/:resource/:id', { resource: 'ip-assets', id });
    if (op === 'canceljob') return deps.cancelJob(id);
    throw new Error('不支持的操作');
  }
  function pump() {
    while (running < 4 && queue.length) {
      const job = queue.shift(); running++;
      void job().catch(() => {}).finally(() => { running--; pump(); });
    }
  }
  async function enqueue(ctx, action) {
    assertAccess(ctx, action.section, true, action.op);
    const key = `${action.section}:${action.id || 'all'}`;
    if (busy.has(key)) return show(ctx, '该任务的操作正在处理，请勿重复点击。', [[listButton(ctx, action.section), rootButton(ctx)]]);
    if (busy.size >= 36) throw new Error('当前操作较多，请稍后重试');
    busy.add(key);
    ctx.session.pending = null;
    let message;
    try { message = await show(ctx, '操作已受理，正在后台处理。', [[listButton(ctx, action.section), rootButton(ctx)]], true); }
    catch (error) { busy.delete(key); throw error; }
    const resultCtx = { ...ctx, messageId: message?.message_id };
    queue.push(async () => {
      try {
        const result = await execute(resultCtx, action);
        await show(resultCtx, `${['check', 'change', 'execute', 'rollback'].includes(action.op) ? '请求已提交，请查看最新状态' : '操作完成'}${result?.verificationPending ? '，后台正在确认远程写入结果' : ''}${result?.removed !== undefined ? `\n清理 ${result.removed} 条，保留 ${result.kept || 0} 条` : ''}`, [[...(action.id && action.op !== 'delete' ? [button(resultCtx, '查看最新状态', { kind: 'detail', section: action.section, id: action.id })] : []), listButton(resultCtx, action.section)]]).catch(() => {});
      } catch (error) { await show(resultCtx, `操作未完成：${short(error.message, 700)}`, [[listButton(resultCtx, action.section), rootButton(resultCtx)]]); }
      finally { busy.delete(key); }
    });
    pump();
  }
  async function confirm(ctx, action) {
    assertAccess(ctx, action.section, true, action.op);
    const item = action.id ? get(ctx, action.section, action.id) : null;
    const titles = { delete: '删除', clear: '清理已结束事件', execute: '执行 / 重试', rollback: '回滚', change: '执行换 IP API', canceljob: '取消执行', toggle: action.enabled ? '启用' : '暂停' };
    const next = { ...action, kind: 'execute', address: item?.address, identity: action.identity || (item ? identity(item) : ''),
      ...(action.op === 'clear' ? { ids: records(ctx, 'incidents').filter((entry) => finished.has(entry.status) || entry.status === 'failed').map((entry) => entry.id) } : {}) };
    ctx.session.pending = { ...next, nonce: randomBytes(12).toString('hex') };
    return show(ctx, `确认${titles[action.op] || '写入记录'}？\n${item ? name(item) : action.body ? `${action.body.domain} · ${action.body.recordType}` : `${next.ids?.length || 0} 条已结束事件，仍被占用的会保留`}${item?.domain ? `\n${short(item.domain, 253)}` : ''}${action.op === 'delete' && action.section === 'assets' ? '\n仅删除空闲资产，并从所有备用池移除；使用中 IP 受保护。' : ''}${action.values ? `\n修改后 ${action.values.length} 个 IP：\n${action.values.slice(0, 30).join('\n')}${action.values.length > 30 ? '\n…' : ''}` : ''}`,
      [[button(ctx, '确认', { ...next, nonce: ctx.session.pending.nonce }), button(ctx, '取消', { kind: action.id ? 'detail' : 'list', section: action.section, id: action.id })]]);
  }
  const menuAliases = { probes: { kind: 'group', members: ['probes', 'targets', 'policies'] }, root: { kind: 'root' }, overview: { kind: 'overview', section: 'overview' } };
  const detailAliases = { guard: 'guards', pool: 'pools', dns: 'dns', incident: 'incidents', run: 'runs' };
  function translate(raw, text) {
    if (raw.startsWith('menu:')) {
      const section = raw.slice(5); return menuAliases[section] || (sections[section] ? { kind: 'list', section, page: 0 } : null);
    }
    const [kind, id] = raw.split(':');
    if (detailAliases[kind]) return { kind: 'detail', section: detailAliases[kind], id };
    if (kind === 'guard_check') return { kind: 'action', section: 'guards', id, op: 'check' };
    if (kind === 'dns_sync') return { kind: 'action', section: 'dns', id, op: 'sync' };
    if (kind === 'dns_add' || kind === 'dns_replace') return { kind: 'input', section: 'dns', id, op: kind === 'dns_add' ? 'add' : 'replace' };
    if (kind === 'dns_create' || kind === 'dns_account' || kind === 'dns_type' || kind === 'dns_create_confirm') return { kind: 'createDns', section: 'dns' };
    if (kind === 'pool_toggle' || kind === 'pool_toggle_confirm') return { kind: 'togglePrompt', section: 'pools', id };
    if (kind === 'guard_toggle' || kind === 'guard_toggle_confirm') return { kind: 'togglePrompt', section: 'guards', id };
    if (kind === 'incident_execute' || kind === 'incident_rollback') return { kind: 'confirm', section: 'incidents', id, op: kind === 'incident_execute' ? 'execute' : 'rollback' };
    if (kind === 'canceljob') return { kind: 'confirm', section: 'runs', id, op: 'canceljob' };
    const command = text.split(/\s/)[0].split('@')[0];
    const commands = { '/start': 'root', '/menu': 'root', '菜单': 'root', '/status': 'overview', '总览': 'overview', '/probes': 'probes', '探针管理': 'probes', '/guards': 'guards', 'DNS守护': 'guards', '/dynamic': 'dynamic', '/targets': 'targets', '/policies': 'policies', '/assets': 'assets', '/pools': 'pools', '备用 IP 池': 'pools', '/dns': 'dns', '解析管理': 'dns', '/incidents': 'incidents', '故障事件': 'incidents', '/run': 'automation', '执行自动化': 'automation' };
    if (commands[text]) { const section = commands[text]; return menuAliases[section] || { kind: 'list', section, page: 0 }; }
    const section = commands[command]; return section ? menuAliases[section] || { kind: 'list', section, page: 0 } : null;
  }
  async function handle(update, token, settings) {
    cleanup();
    const callback = update.callback_query, message = update.message;
    const from = message?.from || callback?.from, chat = message?.chat || callback?.message?.chat;
    if (!from || !chat || !deps.authorized(settings, from, chat)) return false;
    const key = keyFor(settings, chat, from);
    let session = sessions.get(key);
    if (!session) { session = { filters: {}, pages: {}, pending: null }; sessions.set(key, session); }
    session.expiresAt = Date.now() + ttl;
    const ctx = { key, session, settings, from, chat, token, messageId: callback?.message?.message_id };
    const raw = String(callback?.data || ''), text = String(message?.text || '').trim();
    let action = raw.startsWith('tg2:') ? buttons.get(raw.slice(4)) : translate(raw, text);
    if (!action && !callback && /^\//.test(text)) {
      session.pending = null;
      deps.cancelLegacy?.(settings, chat, from);
      action = { kind: 'root' };
    }
    if (raw.startsWith('tg2:') && (!action || action.sessionKey !== key || action.expiresAt < Date.now())) {
      await deps.call(token, 'answerCallbackQuery', { callback_query_id: callback.id, text: '按钮已过期或属于其他用户，请发送 /menu。' }); return true;
    }
    if (!action && !callback && session.pending?.kind === 'searchInput') {
      action = { kind: 'list', section: session.pending.section, page: 0 };
      session.filters[action.section] = { ...session.filters[action.section], query: text.slice(0, 150) };
    } else if (!action && !callback && session.pending?.kind === 'dnsDomain') {
      try {
        assertAccess(ctx, 'dns', true);
        const domain = text.toLowerCase().replace(/\.$/, '');
        if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('请输入完整域名，不含协议或路径');
        const nonce = randomBytes(12).toString('hex');
        session.pending = { ...session.pending, kind: 'dnsType', domain, nonce };
        await show(ctx, `${domain}\n选择记录类型`, [['A', 'AAAA', 'CNAME', 'TXT'].map((recordType) => button(ctx, recordType, { kind: 'dnsType', section: 'dns', nonce, recordType })), [listButton(ctx, 'dns'), rootButton(ctx)]]);
      } catch (error) { await show(ctx, short(error.message, 500), [[rootButton(ctx)]]); }
      return true;
    } else if (!action && !callback && session.pending?.kind === 'dnsValues') {
      try {
        assertAccess(ctx, 'dns', true);
        const pending = session.pending, addressRecord = ['A', 'AAAA'].includes(pending.recordType);
        const values = addressRecord ? parseIpBatch(text) : [...new Set(text.split('\n').map((value) => value.trim()).filter(Boolean))];
        if (!values.length || values.length > (addressRecord ? 50 : 5000) || (pending.recordType === 'CNAME' && values.length !== 1)) throw new Error(addressRecord ? '请输入 1–50 个 IP 地址' : '记录值数量无效');
        if (addressRecord && values.some((value) => net.isIP(value) !== (pending.recordType === 'AAAA' ? 6 : 4))) throw new Error('记录值的地址类型不匹配');
        await confirm(ctx, { section: 'dns', op: 'create', values, body: { name: `${pending.domain} ${pending.recordType}`, accountId: pending.accountId, domain: pending.domain, recordType: pending.recordType, backupIps: addressRecord ? values : [], recordValues: addressRecord ? [] : values, updateMode: 'replace', enabled: true } });
      } catch (error) { await show(ctx, short(error.message, 500), [[rootButton(ctx)]]); }
      return true;
    } else if (!action && !callback && session.pending?.kind === 'ipInput') {
      try {
        const pending = session.pending; assertAccess(ctx, pending.section, true);
        const item = get(ctx, pending.section, pending.id);
        const values = parseIpBatch(text);
        if (values.some((value) => net.isIP(value) !== (item.recordType === 'AAAA' ? 6 : 4))) throw new Error('IP 地址类型与记录不匹配');
        const next = pending.op === 'replace' ? values : pending.op === 'add' ? [...new Set([...pending.expectedValues, ...values])] : pending.expectedValues.filter((value) => !values.includes(value));
        if (pending.section === 'dns' && !next.length) throw new Error('解析管理需至少保留一个记录值；删除整组解析请在网页操作');
        if (pending.section === 'dns' && next.length > (item.maxActiveIps || 50)) throw new Error(`超出此解析的 ${item.maxActiveIps || 50} 个 IP 上限，请先在网页调整配置`);
        await confirm(ctx, { kind: 'confirm', section: pending.section, id: pending.id, op: 'write', values: next, expectedValues: pending.expectedValues, identity: pending.identity });
      } catch (error) { await show(ctx, short(error.message, 500), [[rootButton(ctx)]]); }
      return true;
    }
    if (!action) {
      if (callback || /^\//.test(text)) session.pending = null;
      return false;
    }
    if (callback) await deps.call(token, 'answerCallbackQuery', { callback_query_id: callback.id });
    deps.cancelLegacy?.(settings, chat, from);
    try {
      if (action.section) assertAccess(ctx, action.section);
      if (action.kind === 'execute') {
        if (session.pending?.nonce !== action.nonce) throw new Error('确认已失效，请重新操作');
        session.pending = null; buttons.delete(raw.slice(4)); await enqueue(ctx, action); return true;
      }
      const previousPending = session.pending;
      session.pending = null;
      const { section, id, kind } = action;
      if (kind === 'root') await root(ctx);
      else if (kind === 'group') await show(ctx, '选择管理功能', [...action.members.filter((key) => allowed(ctx, key)).map((key) => [button(ctx, sections[key][0], { kind: 'list', section: key, page: 0 })]), [rootButton(ctx)]]);
      else if (kind === 'overview') await overview(ctx);
      else if (kind === 'list') await list(ctx, section, action.page);
      else if (kind === 'detail') await detail(ctx, section, id);
      else if (kind === 'ips') await ips(ctx, section, id, action.page);
      else if (kind === 'history') await history(ctx, section, id, action.page);
      else if (kind === 'filter' || kind === 'clearSearch') {
        const current = session.filters[section] || {};
        session.filters[section] = { ...current, ...(kind === 'filter' ? { bad: !current.bad } : { query: '' }) }; await list(ctx, section);
      } else if (kind === 'search') {
        const hint = WORKSPACE_SEARCH[searchSection(section)]?.placeholder || '搜索自动化任务名称';
        session.pending = { kind: 'searchInput', section }; await show(ctx, `${hint}：请输入关键词。`, [[listButton(ctx, section), rootButton(ctx)]]);
      } else if (kind === 'input') {
        assertAccess(ctx, section, true);
        const item = get(ctx, section, id);
        if (section === 'dns' && item.ddnsSources?.length) throw new Error('此解析配置了动态来源，请在网页编辑，避免手动记录与来源冲突');
        session.pending = { kind: 'ipInput', section, id, op: action.op, expectedValues: [...(item.currentValues || [])], identity: identity(item) };
        await show(ctx, `${name(item)}\n${action.op === 'add' ? '添加' : action.op === 'remove' ? '删除指定' : '替换全部'} IP：请每行输入一个 ${item.recordType} 地址，下一步会显示确认内容。`, [[button(ctx, '取消', { kind: 'ips', section, id }), rootButton(ctx)]]);
      } else if (kind === 'createDns') {
        assertAccess(ctx, section, true);
        const accounts = deps.readState(['dnsAccounts']).dnsAccounts.filter((account) => account.enabled !== false && account.credentialsEnc);
        const pages = Math.max(1, Math.ceil(accounts.length / 8)), page = Math.min(pages - 1, action.page || 0);
        await show(ctx, `选择 DNS 账号 · 第 ${page + 1}/${pages} 页`, [...accounts.slice(page * 8, page * 8 + 8).map((account) => [button(ctx, name(account), { kind: 'dnsAccount', section: 'dns', accountId: account.id })]),
          [...(page ? [button(ctx, '上一页', { kind: 'createDns', section, page: page - 1 })] : []), ...(page + 1 < pages ? [button(ctx, '下一页', { kind: 'createDns', section, page: page + 1 })] : [])], [listButton(ctx, 'dns'), rootButton(ctx)]]);
      } else if (kind === 'dnsAccount') {
        assertAccess(ctx, section, true);
        session.pending = { kind: 'dnsDomain', accountId: action.accountId };
        await show(ctx, '请输入要创建解析的完整域名。', [[listButton(ctx, 'dns'), rootButton(ctx)]]);
      } else if (kind === 'dnsType') {
        assertAccess(ctx, section, true);
        if (previousPending?.kind !== 'dnsType' || previousPending.nonce !== action.nonce) throw new Error('此选择已过期，请重新新建解析');
        session.pending = { ...previousPending, kind: 'dnsValues', recordType: action.recordType };
        await show(ctx, `${previousPending.domain} · ${action.recordType}\n请输入记录值，每行一个。`, [[listButton(ctx, 'dns'), rootButton(ctx)]]);
      } else if (kind === 'confirm') await confirm(ctx, action);
      else if (kind === 'togglePrompt') await confirm(ctx, { ...action, kind: 'confirm', op: 'toggle', enabled: get(ctx, section, id).enabled === false });
      else if (kind === 'action') await enqueue(ctx, action);
      else if (kind === 'sources') {
        const item = get(ctx, section, id);
        const sources = item.sources || [], pages = Math.max(1, Math.ceil(sources.length / 4)), page = Math.min(pages - 1, Math.max(0, action.page || 0));
        await show(ctx, `${name(item)} · 来源状态\n第 ${page + 1}/${pages} 页\n${sources.slice(page * 4, page * 4 + 4).map((source) => { const state = item.sourceState?.[source.id || source.domain]; return `${short(source.name || source.domain)}\n主：${short(source.domain, 253)}\n备：${short(source.backupDomain || '未设置', 253)}\n状态：${short(labels[state?.status] || state?.status || '未检查')}${state?.lastError ? `\n${short(state.lastError, 180)}` : ''}`; }).join('\n\n') || '未配置来源域名'}`, [[...(page ? [button(ctx, '上一页', { kind, section, id, page: page - 1 })] : []), ...(page + 1 < pages ? [button(ctx, '下一页', { kind, section, id, page: page + 1 })] : [])], [button(ctx, '返回详情', { kind: 'detail', section, id }), rootButton(ctx)]]);
      } else if (kind === 'web') await show(ctx, `请在网页的「${sections[section][0]}」编辑规则。管理员可配置 PUBLIC_APP_URL，启用直接打开网页的按钮。`, [[button(ctx, '返回详情', { kind: 'detail', section, id }), rootButton(ctx)]]);
      return true;
    } catch (error) { await show(ctx, short(error.message, 700), [[rootButton(ctx)]]); return true; }
  }
  return { handle, cleanup, async drain() { while (running || queue.length) await new Promise((resolve) => setTimeout(resolve, 1)); } };
}
