import crypto from 'node:crypto';
import net from 'node:net';
import { DNS_GUARD_BATCH_ACTIONS, DNS_GUARD_BATCH_SETTINGS } from '../shared/dns-guard-batch.js';

const MAX_RULES = 500, MAX_JOBS = 20, TTL = 60 * 60 * 1000;
const error = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const domain = value => {
  const result = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(result)) throw error(`域名格式不正确：${result.slice(0, 100)}`);
  return result;
};
const lines = text => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const canon = address => net.isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const configKeys = ['name','accountId','domain','recordType','recordLine','ttl','maxActiveIps','poolFillMode','poolTargetCount',
  'poolSelectionMode','poolRebalanceEnabled','poolRebalanceIntervalMinutes','probeIds','poolIds','alertBotIds','checkType',
  'port','interval','timeout','checkRounds','attemptsPerRound','maxParallel','pruneStale','sourcesFallbackOnly','sources','enabled','sourcesEnabled'];
export const guardBatchFingerprint = guard => JSON.stringify(configKeys.map(key => [key, key === 'sourcesEnabled' || key === 'enabled' ? guard[key] !== false : guard[key]]));

function sourceRows(text, perRule) {
  const rows = lines(text);
  if (!rows.length || rows.length > 1000) throw error('请填写来源，每次最多 1000 行');
  return rows.map((line, index) => {
    const fields = line.split('|');
    const selector = perRule ? fields.shift().trim().split('#') : [];
    const ruleDomain = perRule ? domain(selector[0]) : '';
    const ruleId = selector[1] || '';
    if (selector.length > 2 || (selector.length === 2 && !/^[A-Za-z0-9_-]{1,100}$/.test(ruleId))) throw error(`第 ${index + 1} 行规则标识不正确`);
    const primary = fields.shift(), backup = (fields.shift() || '').trim(), name = fields.join('|').trim();
    return { ruleDomain, ruleId, source: { domain: domain(primary), backupDomain: backup && backup !== '-' ? domain(backup) : '', name: name.slice(0, 100) } };
  });
}

export function parseGuardBatch(input = {}) {
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > MAX_RULES
    || input.ids.some(id => typeof id !== 'string' || !id || id.length > 100)) throw error('请选择 1–500 条守护规则');
  const action = input.action;
  if (!DNS_GUARD_BATCH_ACTIONS.some(([id]) => id === action)) throw error('未知批量操作');
  const payload = { ids: [...new Set(input.ids)], action };
  if (['enabled','sources_enabled'].includes(action)) {
    if (typeof input.enabled !== 'boolean') throw error('请选择启用或禁用');
    payload.enabled = input.enabled;
  } else if (['ips_add','ips_remove'].includes(action)) {
    const addresses = String(input.text || '').split(/[\s,，;；]+/).filter(Boolean);
    if (!addresses.length || addresses.length > 5000 || addresses.some(ip => !net.isIP(ip) || ip.includes('%'))) throw error('请提交有效的 IPv4 / IPv6 地址，最多 5000 项');
    payload.addresses = [...new Set(addresses.map(canon))];
  } else if (['sources_add','sources_replace'].includes(action)) {
    payload.perRule = input.perRule === true;
    payload.rows = sourceRows(input.text, payload.perRule);
  } else if (action === 'sources_remove') {
    payload.domains = [...new Set(String(input.text || '').split(/[\s,，;；]+/).filter(Boolean).map(domain))];
    if (!payload.domains.length || payload.domains.length > 1000) throw error('请填写要删除的来源域名，最多 1000 项');
  } else if (action === 'sources_map') {
    const rows = lines(input.text);
    if (!rows.length || rows.length > 1000) throw error('请填写旧域名与新域名，每次最多 1000 行');
    payload.mapping = rows.map((line, index) => {
      const fields = line.split('|').map(value => value.trim());
      if (fields.length !== 2) throw error(`第 ${index + 1} 行请使用“旧域名 | 新域名”`);
      return fields.map(domain);
    });
    if (new Set(payload.mapping.map(([from]) => from)).size !== payload.mapping.length) throw error('旧域名不能重复');
  } else if (action === 'references') {
    if (!['probeIds','poolIds','alertBotIds'].includes(input.field) || !['add','remove','replace'].includes(input.mode)) throw error('请选择关联类型和操作方式');
    if (!Array.isArray(input.values) || input.values.length > 500 || input.values.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw error('关联选择无效');
    if (input.mode !== 'replace' && !input.values.length) throw error('请至少选择一项');
    Object.assign(payload, { field: input.field, mode: input.mode, values: [...new Set(input.values)] });
  } else if (action === 'settings') {
    const allowed = DNS_GUARD_BATCH_SETTINGS.find(([key]) => key === input.field);
    if (!allowed || !Number.isInteger(Number(input.value)) || Number(input.value) < allowed[2] || Number(input.value) > allowed[3]) throw error('参数值不在允许范围内');
    Object.assign(payload, { field: input.field, value: Number(input.value) });
  }
  return payload;
}

function configPatch(guard, payload, guards) {
  const { action } = payload;
  if (action === 'enabled') return { enabled: payload.enabled };
  if (action === 'sources_enabled') return { sourcesEnabled: payload.enabled };
  if (action === 'references') {
    const before = guard[payload.field] || [];
    const values = payload.mode === 'replace' ? payload.values
      : payload.mode === 'add' ? [...new Set([...before, ...payload.values])] : before.filter(id => !payload.values.includes(id));
    const limit = { probeIds: 500, poolIds: 100, alertBotIds: 50 }[payload.field];
    if (values.length > limit) throw error(`操作后关联数量超过上限 ${limit}，请减少选择`);
    return { [payload.field]: values };
  }
  if (action === 'settings') return { [payload.field]: payload.value };
  const before = guard.sources || [];
  if (action === 'sources_map') {
    const mapping = new Map(payload.mapping);
    const sources = before.map(source => ({ ...source, domain: mapping.get(domain(source.domain)) || source.domain,
      backupDomain: source.backupDomain ? mapping.get(domain(source.backupDomain)) || source.backupDomain : '' }));
    return { sources };
  }
  if (action === 'sources_remove') {
    const removed = new Set(payload.domains);
    // Primary match removes that source; backup-only match clears just the
    // backup, preserving the distinct primary/name/fallback settings.
    return { sources: before.filter(source => !removed.has(domain(source.domain))).map(source => ({ ...source,
      backupDomain: source.backupDomain && removed.has(domain(source.backupDomain)) ? '' : source.backupDomain || '' })) };
  }
  const rows = payload.rows.filter(row => !payload.perRule || (row.ruleDomain === domain(guard.domain) && (!row.ruleId || row.ruleId === guard.id)));
  if (payload.perRule && rows.some(row => !row.ruleId)
    && guards.filter(item => payload.ids.includes(item.id) && domain(item.domain) === domain(guard.domain)).length > 1) {
    throw error('同一域名对应多条规则，请复制现有来源，使用“守护域名#规则ID”准确指定规则', 409);
  }
  if (!rows.length) throw error('未提供本规则的来源映射，已跳过', 409);
  const result = action === 'sources_replace' ? [] : structuredClone(before);
  for (const { source } of rows) {
    if (action === 'sources_add' && result.some(item => domain(item.domain) === source.domain)) continue;
    const prior = before.find(item => domain(item.domain) === source.domain);
    result.push({ ...source, id: prior?.id || crypto.randomUUID(), fallbackOnly: prior?.fallbackOnly ?? false });
  }
  return { sources: result };
}

const viewConfig = guard => ({
  sources: guard.sources || [], sourcesEnabled: guard.sourcesEnabled !== false, enabled: guard.enabled !== false,
  probeIds: guard.probeIds || [], poolIds: guard.poolIds || [], alertBotIds: guard.alertBotIds || [],
  ...Object.fromEntries(DNS_GUARD_BATCH_SETTINGS.map(([key]) => [key, guard[key]]))
});

export function createDnsGuardBatchService(deps) {
  const jobs = new Map(), activeGuards = new Set(), activeRecords = new Set();
  const now = deps.now || Date.now;
  const cleanup = () => { for (const [id, job] of jobs) if (!['preparing','applying'].includes(job.status) && now() - job.touchedAt > TTL) jobs.delete(id); };
  const get = (id, actor) => {
    cleanup(); const job = jobs.get(id);
    if (!job || job.actor !== actor) throw error('批量任务不存在或已过期；已完成的更改已保存，请重新预览', 404);
    job.touchedAt = now(); return job;
  };
  const publicJob = job => ({ id: job.id, action: job.payload.action, status: job.status, createdAt: job.createdAt,
    cancelRequested: Boolean(job.cancelRequested),
    rows: job.rows.map(({ fingerprint, patch, ...row }) => row),
    counts: Object.fromEntries(['queued','preparing','ready','unchanged','skipped','applying','succeeded','pending','failed','canceled'].map(status => [status,job.rows.filter(row => row.status === status).length])) });
  const pool = async (items, fn) => {
    let cursor = 0;
    await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{
      while(cursor<items.length){
        await fn(items[cursor++]);
        // Configuration writes are synchronous. Let incoming stop requests and
        // status reads run before the next row instead of draining microtasks.
        await new Promise(resolve=>setImmediate(resolve));
      }
    }));
  };
  const failRow = (row, err) => { row.status = err.statusCode === 409 || err.statusCode === 404 ? 'skipped' : 'failed'; row.message = String(err.message || '操作失败').slice(0, 700); };
  async function prepare(job) {
    try {
      await pool(job.rows, async row => {
        row.status='preparing';
        try {
          const guard=deps.readState(['dnsGuards']).dnsGuards.find(item=>item.id===row.id);
          if(!guard)throw error('规则已删除',404);
          row.fingerprint=guardBatchFingerprint(guard);
          if(['ips_add','ips_remove'].includes(job.payload.action)) {
            const addresses=job.payload.addresses.filter(ip=>net.isIP(ip)===(guard.recordType==='AAAA'?6:4));
            if(!addresses.length)throw error('没有与本规则 A / AAAA 类型匹配的 IP',409);
            row.before=await deps.readRemote(row.id);
            const keys=new Set(addresses.map(canon));
            row.after=job.payload.action==='ips_add'?[...new Map([...row.before,...addresses].map(ip=>[canon(ip),ip])).values()]:row.before.filter(ip=>!keys.has(canon(ip)));
            if(row.before.length>50||row.after.length>50||(job.payload.action==='ips_add'&&row.after.length>(guard.maxActiveIps||50)))throw error('操作后超过本规则的活动 IP 上限，请减少地址或先调整上限');
          } else if(job.payload.action==='check') {
            if(guard.enabled===false)throw error('任务已停用，请先启用',409);
            if(guard.cycle)throw error('已在检查中，无需重复启动',409);
            row.before='等待下一轮';row.after='立即检查';
          } else {
            row.patch=configPatch(guard,job.payload,deps.readState(['dnsGuards']).dnsGuards);
            const next=deps.normalizeGuard({...guard,...row.patch},guard);
            deps.validateGuard(deps.readState(),next);
            const before=viewConfig(deps.normalizeGuard(guard,guard)),after=viewConfig(next);
            const changed=Object.keys(before).filter(key=>!same(before[key],after[key]));
            row.before=Object.fromEntries(changed.map(key=>[key,before[key]]));
            row.after=Object.fromEntries(changed.map(key=>[key,after[key]]));
          }
          const latest=deps.readState(['dnsGuards']).dnsGuards.find(item=>item.id===row.id);
          if(!latest||guardBatchFingerprint(latest)!==row.fingerprint)throw error('预览期间规则已修改，请重新预览',409);
          row.status=same(row.before,row.after)?'unchanged':'ready';
          row.message=row.status==='unchanged'?'已符合，无需修改':'待确认';
        }catch(err){failRow(row,err);}
      });
      job.status='ready';
    }catch(err){job.status='failed';job.message=err.message;}
    finally{job.touchedAt=now();}
  }
  async function execute(job) {
    try {
      await pool(job.rows.filter(row=>row.status==='ready'),async row=>{
        if(job.cancelRequested){row.status='canceled';row.message='已取消，未执行';return;}
        if(activeGuards.has(row.id)){row.status='skipped';row.message='其他批量任务正在操作本规则，请稍后重试';return;}
        activeGuards.add(row.id);row.status='applying';let remoteKey;
        try {
          const assertCurrent=guard=>{if(!guard||guardBatchFingerprint(guard)!==row.fingerprint)throw error('规则在预览后已修改，请重新预览',409);};
          const current=deps.readState(['dnsGuards']).dnsGuards.find(item=>item.id===row.id);assertCurrent(current);
          if(['ips_add','ips_remove'].includes(job.payload.action)) {
            const key=JSON.stringify([current.accountId,domain(current.domain),current.recordType,current.recordLine||'默认']);
            if(activeRecords.has(key))throw error('其他批量任务正在写入同一 DNS 记录，请重新预览后重试',409);
            activeRecords.add(key);remoteKey=key;
            const result=await deps.writeRemote(row.id,{values:row.after,expectedValues:row.before},job.actor,assertCurrent);
            row.status=result.verificationPending?'pending':'succeeded';
            row.message=result.verificationPending?'请求已提交，远程结果待确认；请重新读取后核对':'远程 IP 已更新，后台将重新检查';
          } else {
            deps.assertEditable(row.id);
            deps.updateState(draft=>{
              const guard=draft.dnsGuards.find(item=>item.id===row.id);assertCurrent(guard);
              if(job.payload.action==='check') {
                if(guard.cycle)throw error('已在检查中，无需重复启动',409);
                Object.assign(guard,{status:'queued',nextCheckAt:'',lastError:'',message:'等待立即检查',updatedAt:new Date().toISOString()});
              } else {
                const next=deps.normalizeGuard({...guard,...row.patch},guard);deps.validateGuard(draft,next);
                Object.assign(guard,next);
              }
              deps.pushAudit(draft,'dnsGuard.batch', 'dnsGuard',row.id,`批量操作：${job.payload.action}`,job.actor);
              return draft;
            });
            deps.invalidate(row.id);row.status='succeeded';row.message='配置已保存，按新规则重新检查';
          }
          try { deps.onDnsGuardChanged?.(row.id); } catch { /* committed changes remain successful; the regular scheduler also resumes them */ }
        }catch(err){failRow(row,err);}
        finally{activeGuards.delete(row.id);if(remoteKey)activeRecords.delete(remoteKey);}
      });
      job.status='done';
    }finally{job.touchedAt=now();}
  }
  return {
    preview(input,actor) {
      cleanup();const payload=parseGuardBatch(input);
      if([...jobs.values()].filter(job=>['preparing','applying'].includes(job.status)).length>=2)throw error('已有两个批量任务正在处理，请稍后再试',409);
      if(jobs.size>=MAX_JOBS){const victim=[...jobs.values()].find(job=>!['preparing','applying'].includes(job.status));if(victim)jobs.delete(victim.id);else throw error('批量任务已满，请稍后重试',409);}
      const records=new Map(deps.readState(['dnsGuards']).dnsGuards.map(guard=>[guard.id,guard]));
      const job={id:crypto.randomUUID(),actor,payload,status:'preparing',createdAt:new Date().toISOString(),touchedAt:now(),
        rows:payload.ids.map(id=>({id,name:records.get(id)?.name||'已删除的规则',domain:records.get(id)?.domain||'',recordType:records.get(id)?.recordType||'',status:'queued',message:''}))};
      jobs.set(job.id,job);void prepare(job);return publicJob(job);
    },
    read(id,actor){return publicJob(get(id,actor));},
    apply(id,actor,confirm) {
      const job=get(id,actor);
      if(confirm!=='apply-dns-guard-batch')throw error('请先预览并确认更改');
      if(['applying','done'].includes(job.status))return publicJob(job);
      if(job.status!=='ready'||!job.rows.some(row=>row.status==='ready'))throw error('预览尚未完成或没有可执行项',409);
      if([...jobs.values()].filter(other=>['preparing','applying'].includes(other.status)).length>=2)throw error('已有两个批量任务正在处理，请稍后再试',409);
      job.status='applying';void execute(job);return publicJob(job);
    },
    cancel(id,actor){const job=get(id,actor);job.cancelRequested=true;return publicJob(job);}
  };
}

export function registerDnsGuardBatchRoutes(app,deps) {
  const service=createDnsGuardBatchService(deps);
  const route=fn=>(req,res,next)=>{res.set?.('Cache-Control','no-store');try{res.json(fn(req));}catch(err){next(err);}};
  app.post('/api/dns-guards/batch/preview',route(req=>service.preview(req.body,req.auth.username)));
  app.get('/api/dns-guards/batch/:jobId',route(req=>service.read(req.params.jobId,req.auth.username)));
  app.post('/api/dns-guards/batch/:jobId/apply',route(req=>service.apply(req.params.jobId,req.auth.username,req.body?.confirm)));
  app.post('/api/dns-guards/batch/:jobId/cancel',route(req=>service.cancel(req.params.jobId,req.auth.username)));
  return service;
}
