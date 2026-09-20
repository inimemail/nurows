import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import net from 'node:net';
import { spawn } from 'node:child_process';

export const DYNAMIC_DEFAULTS = {
  name: '', domain: '', recordType: 'A', probeIds: [], botIds: [], enabled: true,
  checkType: 'ping', port: 443, interval: 30, checkRounds: 3, attemptsPerRound: 3, timeout: 5,
  waitTimeout: 300, queryInterval: 5, commandTimeout: 90, cooldown: 0, maxDaily: 5
};
const iso = (now) => new Date(now).toISOString();
const integer = (value, min, max, fallback) => {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`数值须为 ${min}～${max} 的整数`);
  return number;
};
export const dynamicDay = (now) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export const dynamicDailyCount = (guard, now) => guard.daily?.date === dynamicDay(now) ? guard.daily.count : 0;

export function normalizeDynamicGuard(input, existing, state, encrypt, now = Date.now()) {
  const rawDomain = String(input.domain || '').trim().replace(/\.$/, '');
  if (/[\s/:\\?#@]/.test(rawDomain)) throw new Error('请填写有效的 DDNS 域名，不含协议、路径或端口');
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (net.isIP(domain) || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) throw new Error('请填写有效的 DDNS 域名，不含协议、路径或端口');
  if (state.dynamicGuards?.some((guard) => guard.id !== existing?.id && guard.domain === domain && guard.recordType === (input.recordType === 'AAAA' ? 'AAAA' : 'A'))) throw new Error('该域名和地址类型已有守护任务，请编辑现有任务，避免重复换 IP');
  const probeIds = [...new Set(Array.isArray(input.probeIds) ? input.probeIds : [])];
  if (input.enabled !== false && (!probeIds.length || probeIds.some((id) => !state.probes?.some((probe) => probe.id === id && probe.enabled !== false)))) throw new Error('请选择有效的检查探针');
  const botIds = [...new Set(Array.isArray(input.botIds) ? input.botIds : [])];
  if (input.enabled !== false && botIds.some((id) => !state.telegramBots?.some((bot) => bot.id === id && bot.enabled !== false && bot.tokenEnc))) throw new Error('请选择有效的通知机器人');
  const command = String(input.command || '').trim();
  if ((!command && !existing?.commandEnc) || command.length > 32768 || command.includes('\0')) throw new Error('请填写换 IP API 命令，最多 32768 字符');
  if (!['ping', 'tcp'].includes(input.checkType || 'ping')) throw new Error('检查方式仅支持 Ping 或 TCP');
  const config = {
    name: String(input.name || domain).trim().slice(0, 100), domain, recordType: input.recordType === 'AAAA' ? 'AAAA' : 'A',
    probeIds, botIds, enabled: input.enabled !== false, checkType: input.checkType || 'ping',
    port: integer(input.port, 1, 65535, 443), interval: integer(input.interval, 5, 86400, 30),
    checkRounds: integer(input.checkRounds, 1, 10, 3), attemptsPerRound: integer(input.attemptsPerRound, 1, 10, 3),
    timeout: integer(input.timeout, 1, 60, 5), waitTimeout: integer(input.waitTimeout, 0, 86400, 300),
    queryInterval: integer(input.queryInterval, 5, 3600, 5), commandTimeout: integer(input.commandTimeout, 1, 600, 90),
    cooldown: integer(input.cooldown, 0, 86400, 0), maxDaily: integer(input.maxDaily, 0, 10000, 5)
  };
  const identityChanged = existing && (existing.domain !== domain || existing.recordType !== config.recordType);
  return {
    ...DYNAMIC_DEFAULTS, ...existing, ...config, id: existing?.id || randomUUID(),
    commandEnc: command ? encrypt(command) : existing.commandEnc,
    revision: (existing?.revision || 0) + 1, createdAt: existing?.createdAt || iso(now), updatedAt: iso(now),
    currentIp: identityChanged ? '' : existing?.currentIp || '', cycle: null, pendingChange: null, manualRequested: false,
    flow: identityChanged ? null : existing?.flow || null,
    status: config.enabled ? (existing?.flow && !identityChanged ? 'waiting_ip' : 'queued') : 'disabled',
    message: config.enabled ? '等待检查' : '已停用', nextAt: now
  };
}

export function sanitizeDynamicGuard(guard, now = Date.now()) {
  const { commandEnc, cycle, ...safe } = guard;
  return { ...safe, commandConfigured: Boolean(commandEnc), todayCount: dynamicDailyCount(guard, now),
    status: guard.enabled === false ? 'disabled' : guard.status,
    cycle: cycle ? { id: cycle.id, address: cycle.address, startedAt: cycle.startedAt } : null };
}

export function dynamicProbeTargets(guards = [], probeId) {
  return guards.flatMap((guard) => {
    const cycle = guard.cycle;
    if (guard.enabled === false || !cycle || cycle.result || !cycle.probeIds.includes(probeId) || cycle.observations[probeId]) return [];
    return [{ id: cycle.id, guardId: guard.id, address: cycle.address, allowPrivate: false,
      checkType: guard.checkType, port: guard.port, timeout: guard.timeout,
      checkRounds: guard.checkRounds, attemptsPerRound: guard.attemptsPerRound, interval: 5, checkNowAt: cycle.id }];
  });
}

export function acceptDynamicReports(state, probeId, reports, now = Date.now()) {
  const byId = new Map((state.dynamicGuards || []).filter((guard) => guard.enabled !== false && guard.cycle?.probeIds.includes(probeId)).map((guard) => [guard.cycle.id, guard]));
  let accepted = false;
  for (const raw of reports) {
    const guard = byId.get(raw.targetId);
    if (!guard || raw.checkMarker !== guard.cycle.id || guard.cycle.result) continue;
    const success = raw.ok === true && Number(raw.attempts) >= 1;
    const failure = raw.ok === false && raw.rounds === guard.checkRounds && raw.attemptsPerRound === guard.attemptsPerRound
      && raw.roundsCompleted === guard.checkRounds && raw.attempts === guard.checkRounds * guard.attemptsPerRound;
    if (!success && !failure) continue;
    // DNS lookup errors and missing tooling are not complete reachability evidence.
    if (failure && (!raw.resolvedAddresses?.includes(guard.cycle.address)
      || /no such file|not found|permission denied|operation not permitted|getaddrinfo|name or service not known/i.test(String(raw.error || '')))) continue;
    guard.cycle.observations[probeId] = { ok: success, checkedAt: iso(now) };
    if (success) guard.cycle.result = 'healthy';
    else if (guard.cycle.probeIds.every((id) => guard.cycle.observations[id]?.ok === false)) guard.cycle.result = 'failed';
    accepted = true;
  }
  return accepted;
}

export async function resolveDynamicIp(domain, recordType = 'A') {
  const resolver = new Resolver({ timeout: 1500, tries: 2 });
  const timer = setTimeout(() => resolver.cancel(), 5000);
  try {
    const values = [...new Set(await (recordType === 'AAAA' ? resolver.resolve6(domain) : resolver.resolve4(domain)))];
    if (values.length !== 1) throw new Error(values.length ? '域名返回多个 IP，请使用仅对应一台 VPS 的 DDNS 域名' : '域名没有可用 IP');
    return values[0];
  } finally { clearTimeout(timer); }
}

// GNU timeout remains alive if the panel restarts, so an orphaned command has
// the same hard deadline. The panel also bounds its output and process group.
export function executeDynamicCommand(command, timeoutSeconds, spawnProcess = spawn) {
  return new Promise((resolve) => {
    let output = '', finished = false, timedOut = false;
    let child, timer, hardTimer;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(hardTimer);
      resolve({ ...result, output });
    };
    const terminate = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
    try {
      child = spawnProcess('timeout', ['--signal=TERM', '--kill-after=5', `${timeoutSeconds}s`, 'bash', '--noprofile', '--norc', '-c', command], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => { output = (output + chunk).slice(-8192); });
      }
      child.once('error', () => finish({ ok: false, uncertain: false, error: '无法启动命令，请确认面板环境已安装 bash、curl 和 GNU coreutils（timeout）' }));
      child.once('close', (code) => finish({ ok: code === 0 && !timedOut, uncertain: timedOut || code === 124 || code === 137 || code === null,
        error: code === 0 && !timedOut ? '' : `命令未正常完成（退出码 ${code ?? '未知'}）` }));
      timer = setTimeout(() => {
        timedOut = true; terminate('SIGTERM');
        hardTimer = setTimeout(() => { terminate('SIGKILL'); finish({ ok: false, uncertain: true, error: '命令执行超时，等待确认 IP 变化' }); }, 5000);
      }, timeoutSeconds * 1000 + 1000);
    } catch { finish({ ok: false, uncertain: false, error: '无法启动换 IP 命令' }); }
  });
}

export function createDynamicGuardService(deps, options = {}) {
  const now = options.now || Date.now;
  const resolveIp = options.resolveIp || resolveDynamicIp;
  const execute = options.execute || executeDynamicCommand;
  const preparing = new Set(), resolving = new Set(), commands = new Map(), nextDue = new Map();
  const maxPrepare = options.maxPrepare || 10, maxCommands = options.maxCommands || 4, maxChecks = options.maxChecks || 10;
  const get = (id) => deps.readDynamicGuard ? deps.readDynamicGuard(id) : deps.readState(['dynamicGuards']).dynamicGuards?.find((guard) => guard.id === id);
  const probesNow = () => deps.readDynamicProbeStatus?.() || deps.readState(['probes']).probes || [];
  const update = deps.updateDynamicGuardState || deps.updateState;
  const change = (id, revision, mutate, withHistory = false) => {
    const current = get(id);
    if (!current || (revision !== null && current.revision !== revision)) return false;
    let changed = false;
    update((draft) => {
      const guard = draft.dynamicGuards?.find((item) => item.id === id);
      if (guard && (revision === null || guard.revision === revision)) { mutate(guard, draft); guard.updatedAt = iso(now()); changed = true; }
      return draft;
    }, withHistory, id);
    if (changed) nextDue.delete(id);
    return changed;
  };
  const record = (guard, state, patch) => {
    const run = state.dynamicGuardRuns?.find((item) => item.id === guard.flow?.id);
    if (run) Object.assign(run, patch);
  };
  const wait = (guard, status, message, delay, address = guard.currentIp) => {
    const due = now() + delay * 1000;
    nextDue.set(guard.id, due);
    // Repeated old-IP answers and the same transient DNS error should not
    // serialize the entire application database on every five-second poll.
    if (guard.status === status && guard.message === message && guard.currentIp === address && !guard.cycle) return;
    change(guard.id, guard.revision, (item) => { item.currentIp = address; item.cycle = null; item.status = status; item.message = message; item.nextAt = due; });
  };
  const notice = (id, key, message) => {
    const guard = get(id);
    if (!guard || guard.notificationKeys?.includes(key) || guard.notificationKey === key) return;
    change(id, null, (item) => { item.notificationKeys = [...(item.notificationKeys || []), key].slice(-12); });
    Promise.resolve(deps.notifyDynamicGuard?.(guard, message)).catch(() => {});
  };
  const readiness = (guard, probes) => guard.probeIds.length && guard.probeIds.every((id) => probes.some((probe) => probe.id === id
    && probe.enabled !== false && probe.status === 'online' && now() - Date.parse(probe.lastSeenAt) < 90000));

  function submit(guard, reason, waitExpired = false) {
    const time = now(), count = dynamicDailyCount(guard, time);
    if (commands.has(guard.id)) return;
    if (guard.maxDaily && count >= guard.maxDaily) {
      wait(guard, 'limit', '达到每日换 IP 上限，继续观察当前 IP', guard.interval);
      if (guard.manualRequested) change(guard.id, guard.revision, (item) => { item.manualRequested = false; });
      notice(guard.id, `limit:${dynamicDay(time)}`, `今日换 IP 已达上限 ${count}/${guard.maxDaily}，暂停提交，次日重新确认状态。`);
      return;
    }
    const nextAllowed = Math.max(Number(guard.lastSubmittedAt || 0) + guard.cooldown * 1000, guard.commandNotBefore || 0);
    if (nextAllowed > time) {
      change(guard.id, guard.revision, (item) => { item.cycle = null; item.status = 'cooldown'; item.message = '冷却中，到期后重新确认当前 IP'; item.nextAt = nextAllowed; });
      return;
    }
    if (commands.size >= maxCommands) {
      queueCommand(guard, waitExpired);
      return;
    }
    let command;
    try { command = deps.decryptSecret(guard.commandEnc); if (!command?.trim()) throw new Error('empty command'); }
    catch {
      change(guard.id, guard.revision, (item) => { item.cycle = null; item.manualRequested = false; item.status = 'command_error'; item.message = '命令解密失败，请重新保存命令'; item.nextAt = time + item.interval * 1000; });
      notice(guard.id, 'decrypt-error', '换 IP 命令解密失败，请重新保存命令。');
      return;
    }
    const executionId = randomUUID();
    // Reserve the attempt and persist uncertainty BEFORE starting external I/O.
    const saved = change(guard.id, guard.revision, (item, state) => {
      item.currentIp = guard.currentIp;
      item.pendingChange = null;
      item.flow ||= { id: randomUUID(), initialIp: item.currentIp, startedAt: iso(time), attempts: 0 };
      const flow = item.flow;
      Object.assign(flow, { oldIp: item.currentIp, executionId, commandState: 'executing', submittedAt: time,
        deadlineAt: item.waitTimeout ? time + (item.commandTimeout + 6 + item.waitTimeout) * 1000 : 0, attempts: flow.attempts + 1 });
      item.commandNotBefore = time + (item.commandTimeout + 6) * 1000;
      item.daily = { date: dynamicDay(time), count: count + 1 };
      item.lastSubmittedAt = time; item.cycle = null; item.manualRequested = false;
      item.status = 'executing'; item.message = '正在执行换 IP API 命令';
      state.dynamicGuardRuns ||= [];
      if (!state.dynamicGuardRuns.some((run) => run.id === flow.id)) state.dynamicGuardRuns.unshift({ id: flow.id, guardId: item.id, guardName: item.name, domain: item.domain, oldIp: flow.initialIp, startedAt: flow.startedAt, status: 'processing' });
      record(item, state, { attempts: flow.attempts, message: reason, status: 'processing' });
      // Keep all unfinished flows, and at most 1000 completed records.
      let completed = 0;
      state.dynamicGuardRuns = state.dynamicGuardRuns.filter((run) => run.status === 'processing' || completed++ < 1000);
    }, true);
    if (!saved) return;
    if (waitExpired) notice(guard.id, `wait-timeout:${get(guard.id).flow.id}`, `等待 ${guard.waitTimeout} 秒仍未出现新 IP，已安排再次提交。`);
    const work = Promise.resolve().then(() => execute(command, guard.commandTimeout)).catch(() => ({ ok: false, uncertain: true, error: '命令执行结果未知', output: '' }))
      .then((result) => {
        const current = get(guard.id);
        if (current?.flow?.executionId !== executionId) return;
        change(guard.id, null, (item, state) => {
          const flow = item.flow;
          flow.commandState = result.ok ? 'submitted' : 'uncertain';
          flow.executionId = '';
          item.commandNotBefore = now();
          flow.submittedAt = now();
          flow.deadlineAt = item.waitTimeout ? now() + item.waitTimeout * 1000 : 0;
          item.status = result.ok ? 'waiting_ip' : 'command_error';
          item.message = result.ok ? '请求已提交，等待域名出现新 IP' : `${result.error || '命令失败'}；先查询 IP，避免重复提交`;
          item.nextAt = now();
          record(item, state, { output: String(result.output || '').slice(-8192), message: item.message, commandOk: result.ok });
          if (item.enabled === false) { item.status = 'disabled'; item.message = '已停用；上次命令已结束，停止后续检查与重试'; }
        }, true);
        if (!result.ok) notice(guard.id, `command-error:${current.flow.id}`, '换 IP 命令未正常完成，先等待并确认 IP 变化；不会立即重复提交。');
      }).catch((error) => deps.logError?.(error)).finally(() => commands.delete(guard.id));
    commands.set(guard.id, work);
  }

  function queueCommand(guard, waitExpired = false) {
    if (guard.pendingChange && !guard.cycle) return;
    change(guard.id, guard.revision, (item) => {
      item.pendingChange = { address: item.currentIp, checkedAt: now(), waitExpired };
      item.cycle = null; item.status = 'queued'; item.message = '等待 API 命令执行空位'; item.nextAt = now();
    });
  }

  async function processGuard(snapshot) {
    let guard = get(snapshot.id);
    if (!guard || commands.has(guard.id)) return;
    const time = now();
    if (guard.flow?.commandState === 'executing') {
      change(guard.id, guard.revision, (item) => {
        item.flow.commandState = 'uncertain'; item.flow.executionId = ''; item.cycle = null;
        item.status = item.enabled === false ? 'disabled' : 'waiting_ip';
        item.message = item.enabled === false ? '已停用；上次命令结果待确认，启用后继续查询' : '服务恢复，先确认上次换 IP 结果'; item.nextAt = time;
      });
      guard = get(guard.id);
    }
    if (guard.enabled === false) return;
    let probes = probesNow();
    if (guard.cycle) {
      if (guard.cycle.result === 'healthy') {
        const flow = guard.flow;
        change(guard.id, guard.revision, (item, state) => {
          item.status = 'healthy'; item.message = item.flow ? '新 IP 已通过检查，换 IP 完成' : '当前 IP 正常';
          item.lastCheckAt = iso(time); item.cycle = null; item.nextAt = time + item.interval * 1000;
          if (item.flow) record(item, state, { status: 'succeeded', newIp: item.currentIp, finishedAt: iso(time), message: item.message });
          item.flow = null; item.notificationKey = ''; item.pendingChange = null;
          item.notificationKeys = (item.notificationKeys || []).filter((key) => key.startsWith('limit:'));
        }, Boolean(flow));
        if (flow) notice(guard.id, `success:${flow.id}`, `${flow.initialIp} → ${guard.currentIp}\n换 IP 完成，任意探针一次成功即通过。\n耗时 ${Math.round((time - Date.parse(flow.startedAt)) / 1000)} 秒 · 本次尝试 ${flow.attempts} 次\n今日 ${dynamicDailyCount(guard, time)}/${guard.maxDaily || '不限'}${guard.maxDaily ? `，剩余 ${Math.max(0, guard.maxDaily - dynamicDailyCount(guard, time))} 次` : ''}`);
        return;
      }
      if (!readiness(guard, probes)) {
        change(guard.id, guard.revision, (item) => { item.cycle = null; item.status = 'waiting_probe'; item.message = '负责探针离线，等待恢复后重新检查'; item.nextAt = time + 5000; });
        return;
      }
      if (guard.cycle.result === 'failed') {
        // Freshly resolve again before submitting; a changing DDNS target must
        // not be replaced based on evidence for its previous IP.
        const address = await resolveIp(guard.domain, guard.recordType);
        const fresh = get(guard.id);
        if (fresh?.revision !== guard.revision || fresh?.cycle?.id !== guard.cycle.id) return;
        if (!readiness(fresh, probesNow())) { wait(fresh, 'waiting_probe', '负责探针离线，等待恢复后重新检查', 5); return; }
        if (address !== guard.currentIp) {
          change(guard.id, guard.revision, (item) => { item.cycle = null; item.currentIp = address; item.nextAt = now(); });
          return;
        }
        submit(guard, guard.flow ? '新 IP 所有探针全部轮次失败，继续换 IP' : '所有探针全部轮次失败');
        return;
      }
      if (time - guard.cycle.startedAt > (guard.checkRounds * guard.timeout + guard.checkRounds - 1 + 30) * 1000) {
        change(guard.id, guard.revision, (item) => { item.cycle = null; item.status = 'waiting_probe'; item.message = '探针回报不完整，重新检查，不触发换 IP'; item.nextAt = time + 5000; });
      }
      return;
    }
    if (guard.nextAt > time) return;
    const address = await resolveIp(guard.domain, guard.recordType);
    const fresh = get(guard.id);
    if (!fresh || fresh.revision !== guard.revision || fresh.enabled === false) return;
    probes = probesNow();
    guard = { ...fresh, currentIp: address };
    if (guard.manualRequested) { submit(guard, '手动请求换 IP'); return; }
    if (guard.pendingChange) {
      const pending = guard.pendingChange;
      if (!pending.waitExpired && address === pending.address && now() - pending.checkedAt <= 30000 && readiness(guard, probes)) {
        submit(guard, '全部探针检查失败，API 队列空位已可用'); return;
      }
      change(guard.id, guard.revision, (item) => { item.pendingChange = null; });
      guard.pendingChange = null;
    }
    if (guard.flow && address === guard.flow.oldIp) {
      // Unknown submission after restart cannot overlap the old command's
      // hard deadline. Offline probes cannot trigger another automatic change.
      if (guard.flow.deadlineAt && now() >= guard.flow.deadlineAt && readiness(guard, probes)) {
        submit(guard, `等待 ${guard.waitTimeout} 秒仍无新 IP，重新提交`, true);
      } else {
        const ready = readiness(guard, probes);
        wait(guard, ready ? 'waiting_ip' : 'waiting_probe', ready ? '解析仍为旧 IP，等待新 IP' : '等待负责探针恢复', guard.queryInterval, address);
      }
      return;
    }
    if (!readiness(guard, probes)) {
      wait(guard, 'waiting_probe', '等待负责探针上线', 5, address);
      return;
    }
    const scheduled = deps.readDynamicGuardSchedule?.() || deps.readState(['dynamicGuards']).dynamicGuards || [];
    if (scheduled.filter((item) => item.enabled !== false && item.cycle).length >= maxChecks) {
      wait(guard, 'queued', '等待检查空位', guard.queryInterval, address);
      return;
    }
    change(guard.id, guard.revision, (item) => {
      item.currentIp = address; item.lastResolvedAt = iso(now());
      item.cycle = { id: `dynamic-${randomUUID()}`, address, probeIds: [...item.probeIds], observations: {}, startedAt: now() };
      item.status = item.flow ? 'verifying' : 'checking'; item.message = item.flow ? '正在验证新 IP' : '正在检查当前 IP';
    });
  }

  function tick(requestedId = '') {
    if (requestedId) nextDue.delete(requestedId);
    const guards = requestedId ? [get(requestedId)].filter(Boolean) : deps.readDynamicGuardSchedule?.() || deps.readState(['dynamicGuards']).dynamicGuards || [];
    const allGuards = requestedId ? deps.readDynamicGuardSchedule?.() || deps.readState(['dynamicGuards']).dynamicGuards || [] : guards;
    const ids = new Set(allGuards.map((guard) => guard.id));
    for (const id of nextDue.keys()) if (!ids.has(id)) nextDue.delete(id);
    const checksFull = allGuards.filter((item) => item.enabled !== false && item.cycle).length >= maxChecks;
    // Rotate by due time so slow/failing tasks cannot starve other targets.
    for (const guard of guards.filter((item) => (item.enabled !== false || item.flow?.commandState === 'executing') && !preparing.has(item.id) && !commands.has(item.id)
      && (item.cycle || (nextDue.get(item.id) ?? item.nextAt) <= now() || item.flow?.commandState === 'executing')).sort((a, b) => Number(Boolean(a.cycle)) - Number(Boolean(b.cycle)) || (a.nextAt || 0) - (b.nextAt || 0))) {
      if (checksFull && !guard.cycle && !guard.flow && !guard.manualRequested && !guard.pendingChange) continue;
      if (commands.size >= maxCommands && (guard.cycle?.result === 'failed' || guard.manualRequested || guard.pendingChange)) {
        const current = get(guard.id);
        if (current) queueCommand(current);
        continue;
      }
      const needsDns = !guard.cycle || guard.cycle.result === 'failed';
      if (needsDns && resolving.size >= maxPrepare) continue;
      preparing.add(guard.id);
      if (needsDns) resolving.add(guard.id);
      Promise.resolve().then(() => processGuard(guard)).catch((error) => {
        const fresh = get(guard.id);
        if (fresh?.revision !== guard.revision) return;
        wait(fresh, 'query_error', `查询或处理失败：${String(error.message).slice(0, 200)}`, Math.max(5, fresh.queryInterval));
      }).catch((error) => deps.logError?.(error)).finally(() => { preparing.delete(guard.id); resolving.delete(guard.id); });
    }
  }
  function request(id, manual = false) {
    const guard = get(id);
    if (!guard) throw new Error('任务不存在');
    if (guard.enabled === false) throw new Error('请先启用任务');
    if (commands.has(id) || guard.flow?.commandState === 'executing') throw new Error('换 IP 命令正在执行，请勿重复提交');
    if (manual && (guard.flow || guard.manualRequested)) throw new Error('已有换 IP 流程，等待新 IP 或自动超时重试');
    if (manual && guard.maxDaily && dynamicDailyCount(guard, now()) >= guard.maxDaily) throw new Error('今日换 IP 次数已达上限');
    if (!manual && (preparing.has(id) || guard.cycle)) return;
    change(id, null, (item) => { item.revision++; item.cycle = null; item.pendingChange = null; item.nextAt = now(); item.manualRequested = manual || item.manualRequested; });
    tick(id);
  }
  return { tick, request, isExecuting: (id) => commands.has(id),
    async drain() { while (preparing.size || commands.size) await new Promise((resolve) => setTimeout(resolve, 1)); } };
}

export function registerDynamicGuardRoutes(app, deps, service) {
  const update = deps.updateDynamicGuardState || deps.updateState;
  const route = (handler) => (req, res) => {
    try { handler(req, res); } catch (error) { res.status(400).json({ error: error.message }); }
  };
  app.get('/api/dynamic-guards', route((_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (deps.readDynamicGuardStatus) { res.json(deps.readDynamicGuardStatus()); return; }
    const state = deps.readState(['dynamicGuards', 'probes', 'telegramBots']);
    res.json({ guards: (state.dynamicGuards || []).map((guard) => sanitizeDynamicGuard(guard)),
      probes: (state.probes || []).map(({ id, name, enabled, status, lastSeenAt }) => ({ id, name, enabled, status, lastSeenAt })),
      bots: (state.telegramBots || []).map(({ id, name, enabled, tokenEnc }) => ({ id, name, enabled, configured: Boolean(tokenEnc) })), serverTime: Date.now() });
  }));
  app.get('/api/dynamic-guards/:id/history', route((req, res) => {
    const records = deps.readDynamicGuardHistory ? deps.readDynamicGuardHistory(req.params.id)
      : (deps.readState(['dynamicGuardRuns']).dynamicGuardRuns || []).filter((run) => run.guardId === req.params.id);
    const pages = Math.max(1, Math.ceil(records.length / 50));
    const requested = Number(req.query.page);
    const page = Math.min(pages, Number.isSafeInteger(requested) && requested > 0 ? requested : 1);
    res.json({ records: records.slice((page - 1) * 50, page * 50), total: records.length, page, pages });
  }));
  app.get('/api/dynamic-guards/:id/command', route((req, res) => {
    const guard = deps.readState(['dynamicGuards']).dynamicGuards?.find((item) => item.id === req.params.id);
    if (!guard) throw new Error('任务不存在');
    res.set('Cache-Control', 'no-store');
    res.json({ command: deps.decryptSecret(guard.commandEnc) });
  }));
  const save = (req, res) => {
    const state = deps.readState(['dynamicGuards', 'probes', 'telegramBots']);
    const existing = req.params.id ? state.dynamicGuards?.find((item) => item.id === req.params.id) : null;
    if (req.params.id && !existing) throw new Error('任务不存在');
    if (existing && (service.isExecuting(existing.id) || existing.flow?.commandState === 'executing')) throw new Error('API 命令正在执行，结束后可编辑；等待新 IP 时可以编辑');
    const next = normalizeDynamicGuard(req.body, existing, state, deps.encryptSecret);
    update((draft) => {
      draft.dynamicGuards ||= [];
      if (existing) {
        const index = draft.dynamicGuards.findIndex((item) => item.id === existing.id);
        if (existing.flow && !next.flow) {
          const run = draft.dynamicGuardRuns?.find((item) => item.id === existing.flow.id);
          if (run) Object.assign(run, { status: 'cancelled', finishedAt: iso(Date.now()), message: '目标已修改，结束旧目标的等待流程' });
        }
        if (next.flow) next.flow.deadlineAt = next.waitTimeout ? Math.max(next.flow.submittedAt, next.commandNotBefore || 0) + next.waitTimeout * 1000 : 0;
        draft.dynamicGuards[index] = next;
      } else draft.dynamicGuards.push(next);
      return draft;
    }, true);
    service.tick(next.id);
    res.json({ ok: true, guard: sanitizeDynamicGuard(next) });
  };
  app.post('/api/dynamic-guards', route(save));
  app.put('/api/dynamic-guards/:id', route(save));
  app.post('/api/dynamic-guards/:id/enabled', route((req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new Error('启用状态无效');
    const state = deps.readState(['dynamicGuards', 'probes', 'telegramBots']);
    const existing = state.dynamicGuards?.find((item) => item.id === req.params.id);
    if (!existing) throw new Error('任务不存在');
    if (req.body.enabled) normalizeDynamicGuard({ ...existing, enabled: true }, existing, state, deps.encryptSecret);
    update((draft) => {
      const item = draft.dynamicGuards.find((guard) => guard.id === existing.id);
      item.enabled = req.body.enabled; item.revision++; item.cycle = null; item.pendingChange = null; item.manualRequested = false;
      item.status = item.enabled ? item.flow?.commandState === 'executing' ? 'executing' : 'queued' : 'disabled';
      item.message = item.enabled ? item.status === 'executing' ? '正在等待上次 API 命令结果' : '等待重新确认当前 IP' : '已停用，停止后续检查与重试；已提交请求无法撤回';
      item.nextAt = Date.now(); item.updatedAt = iso(Date.now());
    }, false, existing.id);
    service.tick(existing.id);
    res.json({ ok: true });
  }));
  app.post('/api/dynamic-guards/:id/check', route((req, res) => { service.request(req.params.id); res.status(202).json({ ok: true }); }));
  app.post('/api/dynamic-guards/:id/change', route((req, res) => {
    if (req.body?.confirm !== 'change-ip') throw new Error('请确认执行换 IP API 命令');
    service.request(req.params.id, true); res.status(202).json({ ok: true });
  }));
  app.delete('/api/dynamic-guards/:id', route((req, res) => {
    if (req.body?.confirm !== 'delete-guard') throw new Error('请确认删除任务');
    if (service.isExecuting(req.params.id)) throw new Error('API 命令正在执行，请结束后删除');
    update((draft) => {
      const guard = draft.dynamicGuards?.find((item) => item.id === req.params.id);
      if (!guard) throw new Error('任务不存在');
      if (guard.flow?.commandState === 'executing') throw new Error('正在恢复命令状态，请稍后删除');
      const run = draft.dynamicGuardRuns?.find((item) => item.id === guard.flow?.id);
      if (run) Object.assign(run, { status: 'cancelled', finishedAt: iso(Date.now()), message: '任务已删除，停止后续重试' });
      draft.dynamicGuards = draft.dynamicGuards.filter((item) => item.id !== req.params.id);
      return draft;
    }, true);
    res.json({ ok: true });
  }));
}
