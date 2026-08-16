import { useEffect, useMemo, useRef, useState } from 'react';

const PROVIDERS = {
  huawei: '华为云 DNS', aliyun: '阿里云 DNS', tencent: '腾讯云 DNSPod API', dnspod: 'DNSPod 独立 API', cloudflare: 'Cloudflare',
  godaddy: 'GoDaddy', porkbun: 'Porkbun', cloudns: 'ClouDNS', callback: '自定义 HTTPS 回调',
  aliyun_esa: '阿里云 ESA', baidu: '百度云', namecheap: 'Namecheap', namesilo: 'NameSilo', dynadot: 'Dynadot',
  dnsla: 'DNSLA', era: '时代互联 / Eranet', tndns: 'Tnethk', gcore: 'Gcore', edgeone: '腾讯 EdgeOne',
  ns1: 'IBM NS1 Connect', rainyun: '雨云', dynv6: 'Dynv6', vercel: 'Vercel DNS', spaceship: 'Spaceship'
};
const STATUS = { online: '在线', offline: '离线', pending: '待接入', revoked: '已吊销', healthy: '正常', down: '故障', observing: '观察中', unknown: '未检测', queued: '等待执行', checking: '检查中', waiting_probe: '等待探针', waiting_ip: '等待备用 IP', replaced: '已完成补位', degraded: '容量不足', error: '执行异常', waiting_for_ip: '等待备用 IP', recovered: '目标已恢复', pending_approval: '待确认', allocating: '分配 IP', automating: '执行任务', dns_updating: '更新 DNS', verifying: '验证中', processing: '处理中', discarded: '检测不可用，已丢弃', consumed: '成功消耗', succeeded: '已完成', failed: '失败保留', rolled_back: '已回滚' };

const EMPTY = {
  probe: { name: '', region: '', carrier: '', maxConcurrency: 100, enabled: true },
  target: { name: '', address: '', allowPrivate: false, checkType: 'ping', port: 443, interval: 30, timeout: 5, checkRounds: 3, attemptsPerRound: 3, probeIds: [], policyId: '', enabled: true },
  guard: { name: '', accountId: '', domain: '', recordType: 'A', recordLine: '默认', ttl: 60, maxActiveIps: 50, probeIds: [], poolIds: [], checkType: 'ping', port: 443, interval: 30, timeout: 5, checkRounds: 3, attemptsPerRound: 3, maxParallel: 20, pruneStale: true, sources: [], enabled: true },
  asset: { name: '', address: '', region: '', carrier: '', labels: '', health: 'unknown', enabled: true, note: '' },
  pool: { name: '', assetIds: [], newAssetAddresses: '', allocationMode: 'one', allocationCount: 1, selectionMode: 'ordered', enabled: true, alertEnabled: false, alertThresholds: [5, 3, 1, 0], alertBotIds: [], alertChatIds: [], note: '' },
  account: { name: '', provider: 'huawei', enabled: true, credentials: {} },
  binding: { name: '', accountId: '', domain: '', recordType: 'A', recordValues: [], recordLine: '默认', ttl: 60, updateMode: 'managed_replace', ddnsSources: [], backupIps: '', maxActiveIps: 50, pruneStale: true, healthEnabled: true, healthInterval: 30, maxParallel: 20, enabled: true },
  policy: { name: '', poolIds: [], automationTaskId: '', automationHosts: 'allocated', automationTimeout: 1800, dnsBindingIds: [], approvalMode: 'automatic', autoRollback: true, enabled: true, businessKey: '' }
  ,bot: { name: '', token: '', enabled: true, userIds: '', rolesText: '', automationTaskIds: [], menuScopes: ['overview', 'probes', 'incidents', 'pools', 'dns', 'automation'] }
};

export default function OrchestrationWorkspace({ tab, state, api, onState, toast, Dialog }) {
  const [section, setSection] = useState(tab === 'probes' ? 'nodes' : tab === 'pools' ? 'assets' : 'accounts');
  const [editor, setEditor] = useState({ open: false, type: '', value: null });
  const [editorBusy, setEditorBusy] = useState(false);
  const [install, setInstall] = useState(null);
  const [assetImport, setAssetImport] = useState({ open: false, addresses: '', region: '', carrier: '', labels: '' });
  const [incidentCleanup, setIncidentCleanup] = useState({ open: false, id: '', all: false, busy: false });
  const [guardView, setGuardView] = useState(null);
  const sections = tab === 'probes'
    ? [['nodes', '探针节点'], ['targets', '检查目标'], ['guards', 'DNS 守护'], ['policies', '切换策略'], ['incidents', '故障事件']]
    : tab === 'pools'
      ? [['assets', 'IP 资产'], ['pools', '备用池'], ['usage', '使用记录']]
      : tab === 'telegram'
        ? [['bots', '机器人配置']]
        : [['accounts', '服务商账号'], ['bindings', '解析绑定'], ['changes', '变更记录']];
  const active = sections.some(([key]) => key === section) ? section : sections[0][0];

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await api('/api/state');
        if (!cancelled) onState(data);
      } catch (_error) {
        // The main application handles authentication and connectivity errors.
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, onState, tab]);

  const openCreate = (type) => { setEditorBusy(false); setEditor({ open: true, type, value: structuredClone(EMPTY[type]) }); };
  const openEdit = (type, value) => { setEditorBusy(false); setEditor({ open: true, type, value: normalizeDraft(type, value) }); };
  const duplicateRecord = async (type, source) => {
    setEditorBusy(false);
    const next = { ...normalizeDraft(type, source), id: '', name: '', createdAt: '', updatedAt: '' };
    if (type === 'target') Object.assign(next, { address: '', health: 'unknown', observations: {}, lastCheckAt: '', checkNowAt: '' });
    if (type === 'guard') Object.assign(next, { domain: '', status: 'queued', message: '', currentValues: [], ownedValues: [], sourceOwnedValues: [], sourceState: {}, cycle: null, lastCheckAt: '', nextCheckAt: '', lastError: '', providerRecordIds: [] });
    if (type === 'binding') Object.assign(next, { domain: '', zoneId: '', recordName: '', providerRecordId: '', providerRecordIds: [], managedValues: [], lastSyncAt: '', lastSyncError: '' });
    if (type === 'account') Object.assign(next, { credentials: {}, configured: false, status: 'untested', lastTestAt: '', lastError: '' });
    setEditor({ open: true, type, value: next });
    if (type === 'account' && source.id && source.configured) {
      try {
        const data = await api(`/api/dns-accounts/${source.id}/credentials`);
        setEditor((current) => current.open && current.type === 'account' && !current.value.id && current.value.provider === source.provider
          ? { ...current, value: { ...current.value, credentials: { ...(data.credentials || {}), ...(current.value.credentials || {}) }, configured: true } }
          : current);
      } catch (error) { toast(error.message); }
    }
  };
  const checkTargetNow = async (id) => {
    try {
      const data = await api(`/api/probe-targets/${id}/check-now`, { method: 'POST' });
      onState(data.state);
      toast('已请求立即检查');
    } catch (error) { toast(error.message); }
  };
  const checkGuardNow = async (id) => {
    try {
      const data = await api(`/api/dns-guards/${id}/check-now`, { method: 'POST' });
      onState(data.state);
      toast('已请求立即检查');
    } catch (error) { toast(error.message); }
  };
  const closeEditor = () => setEditor({ open: false, type: '', value: null });
  const save = async () => {
    if (editorBusy) return;
    setEditorBusy(true);
    try {
      const resource = resourceFor(editor.type);
      const value = serializeDraft(editor.type, editor.value);
      const data = await api(`/api/orchestration/${resource}${value.id ? `/${value.id}` : ''}`, { method: value.id ? 'PUT' : 'POST', body: JSON.stringify(value) });
      onState(data.state);
      closeEditor();
      toast(editor.type === 'binding' ? '已保存并写入远端' : '已保存');
    } catch (error) { toast(error.message); }
    finally { setEditorBusy(false); }
  };
  const remove = async () => {
    if (editorBusy) return;
    setEditorBusy(true);
    try {
      const data = await api(`/api/orchestration/${resourceFor(editor.type)}/${editor.value.id}`, { method: 'DELETE' });
      onState(data.state);
      closeEditor();
      toast('已删除');
    } catch (error) { toast(error.message); }
    finally { setEditorBusy(false); }
  };
  const openProbeInstall = async (id) => {
    try {
      const data = await api(`/api/probes/${id}/install-command`);
      setInstall(data);
    } catch (error) { toast(error.message); }
  };
  const rotateProbe = async (id) => {
    try {
      const data = await api(`/api/probes/${id}/rotate-token`, { method: 'POST' });
      onState(data.state);
      setInstall(data);
    } catch (error) { toast(error.message); }
  };
  const executeIncident = async (id) => {
    try {
      const data = await api(`/api/incidents/${id}/execute`, { method: 'POST' });
      onState(data.state);
      toast('故障编排已启动');
    } catch (error) { toast(error.message); }
  };
  const rollbackIncident = async (id) => {
    try {
      const data = await api(`/api/incidents/${id}/rollback`, { method: 'POST' });
      onState(data.state);
      toast('已执行回滚');
    } catch (error) { toast(error.message); }
  };
  const confirmIncidentCleanup = async () => {
    setIncidentCleanup((current) => ({ ...current, busy: true }));
    try {
      const data = await api(incidentCleanup.all ? '/api/incidents' : `/api/incidents/${incidentCleanup.id}`, { method: 'DELETE' });
      onState(data.state);
      setIncidentCleanup({ open: false, id: '', all: false, busy: false });
      toast(incidentCleanup.all ? `已清理 ${data.removed} 条，保留 ${data.kept} 条执行中事件` : '故障事件已删除');
    } catch (error) {
      setIncidentCleanup((current) => ({ ...current, busy: false }));
      toast(error.message);
    }
  };
  const importAssets = async () => {
    try {
      const data = await api('/api/ip-assets/batch', { method: 'POST', body: JSON.stringify(assetImport) });
      onState(data.state);
      setAssetImport({ open: false, addresses: '', region: '', carrier: '', labels: '' });
      toast(`已导入 ${data.created} 个 IP，复用 ${data.reused} 个`);
    } catch (error) { toast(error.message); }
  };

  return (
    <section className="ops-workspace">
      <header className="surface ops-header">
        <div><span className="ops-eyebrow">{tab === 'probes' ? '可用性与故障编排' : tab === 'pools' ? '一次性备用地址' : tab === 'telegram' ? '统一通知与远程操作' : '多云 DNS 控制平面'}</span><strong>{tab === 'probes' ? '探针管理' : tab === 'pools' ? '备用 IP 池' : tab === 'telegram' ? 'Telegram' : '解析管理'}</strong></div>
        <div className="ops-health"><i /><span>{summary(tab, state)}</span></div>
      </header>
      <div className="ops-tabs" role="tablist">{sections.map(([key, label]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => setSection(key)}>{label}<em>{countFor(key, state)}</em></button>)}</div>
      <div className="surface ops-content">
        {renderSection(active, { state, openCreate, openEdit, duplicateRecord, checkTargetNow, checkGuardNow, openGuardView: setGuardView, openProbeInstall, rotateProbe, executeIncident, rollbackIncident, requestIncidentDelete: (id) => setIncidentCleanup({ open: true, id, all: false, busy: false }), requestIncidentClear: () => setIncidentCleanup({ open: true, id: '', all: true, busy: false }), openAssetImport: () => setAssetImport((current) => ({ ...current, open: true })), api, onState, toast })}
      </div>

      {editor.open ? <Dialog title={`${editor.value.id ? '编辑' : '新增'}${typeLabel(editor.type)}`} className="ops-editor-dialog" wide={editor.type !== 'target' && editor.type !== 'policy' && editor.type !== 'guard'} xwide={editor.type === 'target' || editor.type === 'policy' || editor.type === 'guard'} onClose={() => !editorBusy && closeEditor()} footer={<><div>{editor.value.id ? <button className="danger-text" disabled={editorBusy} onClick={remove}>删除</button> : null}</div><div className="dialog-actions"><button className="ghost" disabled={editorBusy} onClick={closeEditor}>取消</button><button className="primary" disabled={editorBusy} onClick={save}>{editorBusy ? (editor.type === 'binding' ? '写入远端中...' : '保存中...') : '保存'}</button></div></>}>{renderEditor(editor.type, editor.value, (patch) => setEditor((current) => ({ ...current, value: { ...current.value, ...patch } })), state, api, toast)}</Dialog> : null}
      {guardView ? <GuardDetails guard={state.dnsGuards?.find((item) => item.id === guardView.id) || guardView} runs={(state.dnsGuardRuns || []).filter((item) => item.guardId === guardView.id)} Dialog={Dialog} onClose={() => setGuardView(null)} onCheck={() => { checkGuardNow(guardView.id); setGuardView(null); }} /> : null}
      {install ? <Dialog title="探针安装 / 升级" onClose={() => setInstall(null)} footer={<><span /><button className="primary" onClick={() => setInstall(null)}>完成</button></>}><div className="ops-install"><CommandBlock label="安装 / 升级命令" value={install.installCommand} toast={toast} /><CommandBlock label="卸载命令" value={install.uninstallCommand} toast={toast} /><span>重复执行安装命令会下载最新代理并重启探针服务，现有长期注册令牌继续使用。</span></div></Dialog> : null}
      {assetImport.open ? <Dialog title="批量导入 IP 资产" className="ops-editor-dialog" wide onClose={() => setAssetImport((current) => ({ ...current, open: false }))} footer={<><span /><div className="dialog-actions"><button className="ghost" onClick={() => setAssetImport((current) => ({ ...current, open: false }))}>取消</button><button className="primary" onClick={importAssets}>导入</button></div></>}><EditorGrid><Field label="IP 地址" full><textarea className="ops-batch-ip-input" rows="12" value={assetImport.addresses} onChange={(e) => setAssetImport((current) => ({ ...current, addresses: e.target.value }))} placeholder={'每行一个，也支持空格或逗号分隔\n1.1.1.1\n2001:db8::1'} /></Field><Field label="地区（选填，批量设置）"><input value={assetImport.region} onChange={(e) => setAssetImport((current) => ({ ...current, region: e.target.value }))} /></Field><Field label="运营商（选填，批量设置）"><input value={assetImport.carrier} onChange={(e) => setAssetImport((current) => ({ ...current, carrier: e.target.value }))} /></Field><Field label="标签（选填，逗号分隔）" full><input value={assetImport.labels} onChange={(e) => setAssetImport((current) => ({ ...current, labels: e.target.value }))} /></Field></EditorGrid></Dialog> : null}
      {incidentCleanup.open ? <Dialog title={incidentCleanup.all ? '清理故障事件' : '删除故障事件'} onClose={() => !incidentCleanup.busy && setIncidentCleanup({ open: false, id: '', all: false, busy: false })} footer={<><span /><div className="dialog-actions"><button className="ghost" disabled={incidentCleanup.busy} onClick={() => setIncidentCleanup({ open: false, id: '', all: false, busy: false })}>取消</button><button className="primary danger-action" disabled={incidentCleanup.busy} onClick={confirmIncidentCleanup}>{incidentCleanup.busy ? '清理中...' : '确认清理'}</button></div></>}><div className="confirm-copy">{incidentCleanup.all ? '将清理全部非执行中的故障事件，正在运行的自动化、DNS 更新和回滚事件会自动保留。' : '将删除这条故障事件；IP 使用记录、DNS 变更记录和审计记录仍会保留。'}</div></Dialog> : null}
    </section>
  );
}

function renderSection(section, ctx) {
  const { state } = ctx;
  if (section === 'nodes') return <DataView title="探针节点" copy="一台探针可承载多个检查目标" action="新增探针" onAction={() => ctx.openCreate('probe')} empty="还没有探针节点">{state.probes?.map((item) => <Row key={item.id} title={item.name} subtitle={`${item.region || '未设置地区'} · ${item.carrier || '未设置线路'} · ${probeVersionLabel(item.agentVersion)} · 最后心跳 ${formatTime(item.lastSeenAt)}`} status={STATUS[item.status] || item.status} tone={item.status === 'online' ? 'ok' : 'muted'} actions={<><button className="ghost" onClick={() => ctx.openProbeInstall(item.id)}>{probeVersionCurrent(item.agentVersion) || !item.agentVersion ? '安装命令' : '升级命令'}</button><button className="ghost" onClick={() => ctx.rotateProbe(item.id)}>轮转令牌</button><button className="ghost" onClick={() => ctx.openEdit('probe', item)}>编辑</button></>} />)}</DataView>;
  if (section === 'targets') return <DataView title="检查目标" copy="轮数和每轮次数按目标配置；任一探针任意一次成功即正常" action="新增目标" onAction={() => ctx.openCreate('target')} empty="还没有检查目标">{state.probeTargets?.map((item) => <Row key={item.id} title={item.name} subtitle={targetSubtitle(item)} status={STATUS[item.health] || item.health} tone={item.health === 'healthy' ? 'ok' : item.health === 'down' ? 'bad' : 'warn'} onTripleClick={() => ctx.duplicateRecord('target', item)} actions={<><button className="ghost" onClick={() => ctx.checkTargetNow(item.id)}>立即检查</button><button className="ghost" onClick={() => ctx.openEdit('target', item)}>编辑</button></>} />)}</DataView>;
  if (section === 'guards') return <DataView title="DNS 多 IP 守护" copy="解析 DDNS 主备来源，逐 IP 检查并从备用池自动补位" action="新增守护任务" onAction={() => ctx.openCreate('guard')} empty="还没有 DNS 守护任务">{state.dnsGuards?.map((item) => { const tone = item.status === 'healthy' || item.status === 'replaced' ? 'ok' : item.status === 'error' ? 'bad' : 'warn'; return <Row key={item.id} title={item.name} subtitle={`${item.recordType} · ${item.domain} · ${item.currentValues?.length || 0}/${item.maxActiveIps || 50} 个活动 IP · ${item.sources?.length || 0} 个来源 · ${item.probeIds?.length || 0} 个探针 · ${formatTime(item.lastCheckAt)}`} status={STATUS[item.status] || item.status} tone={tone} onTripleClick={() => ctx.duplicateRecord('guard', item)} actions={<><button className="ghost" onClick={() => ctx.openGuardView(item)}>查看</button><button className="ghost" onClick={() => ctx.checkGuardNow(item.id)}>立即检查</button><button className="ghost" onClick={() => ctx.openEdit('guard', item)}>编辑</button></>} />; })}</DataView>;
  if (section === 'policies') return <DataView title="切换策略" copy="把检查目标、备用池、自动化和 DNS 串成一条可回滚流程" action="新增策略" onAction={() => ctx.openCreate('policy')} empty="还没有切换策略">{state.failoverPolicies?.map((item) => <Row key={item.id} title={item.name} subtitle={`${item.poolIds?.length || 0} 个池 · ${item.dnsBindingIds?.length || 0} 条解析 · ${item.approvalMode === 'telegram' ? '需确认' : '自动执行'}`} status={item.enabled ? '已启用' : '已停用'} tone={item.enabled ? 'ok' : 'muted'} onTripleClick={() => ctx.duplicateRecord('policy', item)} actions={<button className="ghost" onClick={() => ctx.openEdit('policy', item)}>编辑</button>} />)}</DataView>;
  if (section === 'incidents') return <DataView title="故障事件" copy="无备用 IP 时保持等待，补入后重新确认故障并预检候选 IP" dangerAction={state.incidents?.length ? '清理全部' : ''} onDangerAction={ctx.requestIncidentClear} empty="还没有故障事件">{state.incidents?.map((item) => { const deletable = !item.executionId && !['allocating', 'automating', 'dns_updating', 'verifying', 'rolling_back'].includes(item.status); return <Row key={item.id} title={item.targetName} subtitle={`${formatTime(item.startedAt)} · ${item.message || item.error || item.policyName}`} status={STATUS[item.status] || item.status} tone={['succeeded', 'recovered'].includes(item.status) ? 'ok' : item.status === 'failed' ? 'bad' : 'warn'} actions={<>{['pending_approval', 'failed', 'observing'].includes(item.status) ? <button className="primary" onClick={() => ctx.executeIncident(item.id)}>执行</button> : null}{item.dnsChangeIds?.length && item.status !== 'rolled_back' ? <button className="ghost" onClick={() => ctx.rollbackIncident(item.id)}>回滚</button> : null}{deletable ? <button className="ghost danger-text-button" onClick={() => ctx.requestIncidentDelete(item.id)}>删除</button> : null}</>} />; })}</DataView>;
  if (section === 'bots') return <DataView title="Telegram 机器人" copy="每个机器人可独立配置授权用户、菜单功能和关联任务" action="新增机器人" onAction={() => ctx.openCreate('bot')} empty="还没有配置 Telegram 机器人">{state.telegramBots?.map((item) => <Row key={item.id} title={item.name || '未命名机器人'} subtitle={`${item.userIds?.length || 0} 个授权用户 · ${item.automationTaskIds?.length || 0} 个自动化任务`} status={item.enabled && item.configured ? '运行中' : item.configured ? '已停用' : '未配置 Token'} tone={item.enabled && item.configured ? 'ok' : 'muted'} actions={<button className="ghost" onClick={() => ctx.openEdit('bot', item)}>编辑</button>} />)}</DataView>;
  if (section === 'assets') return <DataView title="IP 资产" copy="支持一次导入最多 5000 个 IPv4 / IPv6，自动去重" action="批量导入 IP" secondaryAction="单个新增" onAction={ctx.openAssetImport} onSecondaryAction={() => ctx.openCreate('asset')} empty="还没有 IP 资产">{state.ipAssets?.map((item) => <Row key={item.id} title={item.name || item.address} subtitle={assetSubtitle(item)} status={STATUS[item.health] || item.health} tone={item.health === 'healthy' ? 'ok' : item.health === 'unhealthy' ? 'bad' : 'muted'} actions={<button className="ghost" onClick={() => ctx.openEdit('asset', item)}>编辑</button>} />)}</DataView>;
  if (section === 'pools') return <DataView title="备用池" copy="IP 可加入多个备用池；成功切换后会自动消耗并删除" action="新增备用池" onAction={() => ctx.openCreate('pool')} empty="还没有备用池">{state.ipPools?.map((item) => <Row key={item.id} title={item.name} subtitle={`${item.assetIds?.length || 0} 个 IP · ${allocationLabel(item)}`} status={item.enabled ? '可分配' : '已停用'} tone={item.enabled ? 'ok' : 'muted'} actions={<button className="ghost" onClick={() => ctx.openEdit('pool', item)}>编辑</button>} />)}</DataView>;
  if (section === 'usage') return <UsageRecordsView records={state.ipUsageRecords || []} />;
  if (section === 'accounts') return <DataView title="服务商账号" copy="保存凭证后，系统按完整域名自动识别托管域和解析记录" action="新增账号" onAction={() => ctx.openCreate('account')} empty="还没有 DNS 服务商账号">{state.dnsAccounts?.map((item) => <Row key={item.id} title={item.name} subtitle={PROVIDERS[item.provider] || item.provider} status={item.configured ? (item.status === 'healthy' ? '连接正常' : '待测试') : '未配置凭证'} tone={item.status === 'healthy' ? 'ok' : 'warn'} onTripleClick={() => ctx.duplicateRecord('account', item)} actions={<><button className="ghost" onClick={async () => { try { const data = await ctx.api(`/api/dns-accounts/${item.id}/test`, { method: 'POST' }); ctx.onState(data.state); ctx.toast('连接测试成功'); } catch (error) { ctx.toast(error.message); } }}>测试</button><button className="ghost" onClick={() => ctx.openEdit('account', item)}>编辑</button></>} />)}</DataView>;
  if (section === 'bindings') return <DataView title="解析绑定" copy="按完整域名管理 A、AAAA、CNAME、TXT、NS、CAA 记录和多值地址" action="新增解析绑定" onAction={() => ctx.openCreate('binding')} empty="还没有解析绑定">{state.dnsBindings?.map((item) => { const count = ['A', 'AAAA'].includes(item.recordType) ? (item.managedValues?.length || item.backupIps?.length || 0) : (item.recordValues?.length || 0); return <Row key={item.id} title={item.name} subtitle={`${item.recordType} · ${item.domain} · ${count} 个记录值`} status={item.enabled ? '已启用' : '已停用'} tone={item.enabled ? 'ok' : 'muted'} onTripleClick={() => ctx.duplicateRecord('binding', item)} actions={<><button className="ghost" onClick={async () => { try { const data = await ctx.api(`/api/dns-bindings/${item.id}/sync`, { method: 'POST' }); ctx.onState(data.state); ctx.toast(`已读取远端 ${data.values?.length || 0} 个记录值`); } catch (error) { ctx.toast(error.message); } }}>读取远端</button><button className="ghost" onClick={() => ctx.openEdit('binding', item)}>编辑</button></>} />; })}</DataView>;
  return <DataView title="DNS 变更" copy="保留变更前后快照，可从故障事件执行整组回滚" empty="还没有 DNS 变更记录">{state.dnsChanges?.map((item) => <Row key={item.id} title={item.domain} subtitle={`${item.beforeValues?.join(', ') || '空'} → ${item.afterValues?.join(', ') || '空'} · ${formatTime(item.createdAt)}`} status={item.status === 'rolled_back' ? '已回滚' : '已应用'} tone={item.status === 'rolled_back' ? 'muted' : 'ok'} />)}</DataView>;
}

function DataView({ title, copy, action, secondaryAction, dangerAction, onAction, onSecondaryAction, onDangerAction, empty, children }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return <><div className="ops-content-head"><div><strong>{title}</strong><span>{copy}</span></div>{action || dangerAction ? <div className="ops-content-actions">{dangerAction ? <button className="ghost danger-text-button" onClick={onDangerAction}>{dangerAction}</button> : null}{secondaryAction ? <button className="ghost" onClick={onSecondaryAction}>{secondaryAction}</button> : null}{action ? <button className="primary" onClick={onAction}>{action}</button> : null}</div> : null}</div><div className="ops-list">{items.length ? items : <div className="ops-empty"><strong>{empty}</strong><span>使用右上角操作开始配置。</span></div>}</div></>;
}

function UsageRecordsView({ records }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(() => records.filter((item) => {
    if (status !== 'all' && item.status !== status) return false;
    if (!keyword) return true;
    const domains = (item.bindings || []).map((binding) => binding.domain).join(' ');
    return [item.address, item.poolName, item.targetName, item.policyName, item.automationTaskName, domains, item.error]
      .some((value) => String(value || '').toLowerCase().includes(keyword));
  }), [keyword, records, status]);
  return <><div className="ops-content-head"><div><strong>IP 使用记录</strong><span>资产删除后仍保留完整的故障切换使用历史</span></div><div className="ops-usage-filters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 IP、池、目标或域名" /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="processing">处理中</option><option value="discarded">检测不可用</option><option value="consumed">成功消耗</option><option value="failed">失败保留</option><option value="rolled_back">已回滚</option></select></div></div><div className="ops-list">{filtered.length ? filtered.map((item) => { const domains = (item.bindings || []).map((binding) => binding.domain).filter(Boolean).join(', '); const preflight = item.preflight?.attempts ? `Ping ${item.preflight.attempts} 次${item.preflight.ok ? '通过' : '失败'}` : ''; const details = [item.poolName || '未知备用池', item.targetName, preflight, domains, item.automationTaskName ? `任务：${item.automationTaskName}` : '', item.error, formatTime(item.finishedAt || item.startedAt)].filter(Boolean).join(' · '); const tone = item.status === 'consumed' ? 'ok' : ['failed', 'discarded'].includes(item.status) ? 'bad' : 'warn'; return <Row key={item.id} title={item.address} subtitle={details} status={STATUS[item.status] || item.status} tone={tone} />; }) : <div className="ops-empty"><strong>{records.length ? '没有匹配的使用记录' : '还没有 IP 使用记录'}</strong><span>故障切换取用备用 IP 后会自动生成记录。</span></div>}</div></>;
}

function Row({ title, subtitle, status, tone = 'muted', actions, onTripleClick }) {
  return <article className="ops-row" onClick={(event) => { if (onTripleClick && event.detail === 3 && !event.target.closest('button')) onTripleClick(); }}><div className="ops-row-main"><span className={`ops-dot ${tone}`} /><div><strong>{title}</strong>{subtitle ? <span>{subtitle}</span> : null}</div></div><div className="ops-row-side"><em className={`ops-status ${tone}`}>{status}</em>{actions ? <div className="ops-row-actions">{actions}</div> : null}</div></article>;
}

function CommandBlock({ label, value, toast }) {
  return <div className="ops-command-block"><div><label>{label}</label><button className="ghost" type="button" onClick={async () => { await navigator.clipboard.writeText(value); toast('已复制'); }}>复制</button></div><pre>{value}</pre></div>;
}

function renderEditor(type, value, patch, state, api, toast) {
  if (type === 'probe') return <EditorGrid><Field label="探针名称"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field><Field label="地区"><input value={value.region} onChange={(e) => patch({ region: e.target.value })} placeholder="例如：上海" /></Field><Field label="运营商/线路"><input value={value.carrier} onChange={(e) => patch({ carrier: e.target.value })} placeholder="例如：电信" /></Field><Field label="最大检查并发"><input type="number" min="1" max="1000" value={value.maxConcurrency} onChange={(e) => patch({ maxConcurrency: e.target.value })} /></Field><Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用探针</Toggle></EditorGrid>;
  if (type === 'target') return <EditorGrid><Field label="目标名称"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field><Field label="地址"><input value={value.address} onChange={(e) => patch({ address: e.target.value })} placeholder="IP 或域名" /></Field><Field label="检查类型"><select value={value.checkType} onChange={(e) => patch({ checkType: e.target.value })}><option value="ping">Ping</option><option value="tcp">TCPing</option></select></Field>{value.checkType === 'tcp' ? <Field label="TCP 端口"><input type="number" min="1" max="65535" value={value.port} onChange={(e) => patch({ port: e.target.value })} /></Field> : null}<Field label="检查间隔（秒）"><input type="number" min="5" max="3600" value={value.interval} onChange={(e) => patch({ interval: e.target.value })} /></Field><Field label="每轮超时（秒）"><input type="number" min="1" max="60" value={value.timeout} onChange={(e) => patch({ timeout: e.target.value })} /></Field><Field label="检查轮数"><input type="number" min="1" max="10" value={value.checkRounds} onChange={(e) => patch({ checkRounds: e.target.value })} /></Field><Field label="每轮次数"><input type="number" min="1" max="10" value={value.attemptsPerRound} onChange={(e) => patch({ attemptsPerRound: e.target.value })} /></Field><Multi label="负责探针（任意一个成功即正常）" items={state.probes} value={value.probeIds} onChange={(probeIds) => patch({ probeIds })} /><Field label="切换策略"><select value={value.policyId} onChange={(e) => patch({ policyId: e.target.value })}><option value="">仅监控，不触发</option>{state.failoverPolicies?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Toggle checked={value.allowPrivate} onChange={(allowPrivate) => patch({ allowPrivate })}>允许检查私网地址</Toggle><Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用检查</Toggle></EditorGrid>;
  if (type === 'guard') return <GuardEditor value={value} patch={patch} state={state} api={api} />;
  if (type === 'asset') return <EditorGrid><Field label="资产名称（选填）"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field><Field label="IP 地址"><input value={value.address} onChange={(e) => patch({ address: e.target.value })} /></Field><Field label="地区（选填）"><input value={value.region} onChange={(e) => patch({ region: e.target.value })} /></Field><Field label="运营商（选填）"><input value={value.carrier} onChange={(e) => patch({ carrier: e.target.value })} /></Field><Field label="健康状态"><select value={value.health} onChange={(e) => patch({ health: e.target.value })}><option value="unknown">未检测</option><option value="healthy">正常</option><option value="unhealthy">异常</option></select></Field><Field label="标签（选填）"><input value={value.labels} onChange={(e) => patch({ labels: e.target.value })} placeholder="逗号分隔" /></Field><Field label="备注（选填）" full><textarea value={value.note} onChange={(e) => patch({ note: e.target.value })} /></Field><Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>允许加入备用池</Toggle></EditorGrid>;
  if (type === 'pool') return <PoolEditor value={value} patch={patch} state={state} />;
  if (type === 'account') return <AccountEditor value={value} patch={patch} api={api} toast={toast} />;
  if (type === 'binding') return <BindingEditor value={value} patch={patch} state={state} />;
  if (type === 'bot') return <BotEditor value={value} patch={patch} state={state} api={api} toast={toast} />;
  return <EditorGrid><Field label="策略名称"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field><Field label="业务标识"><input value={value.businessKey} onChange={(e) => patch({ businessKey: e.target.value })} placeholder="用于同业务共享 IP" /></Field><Multi label="备用池（按顺序兜底）" items={state.ipPools} value={value.poolIds} onChange={(poolIds) => patch({ poolIds })} /><Field label="自动化任务"><select value={value.automationTaskId} onChange={(e) => patch({ automationTaskId: e.target.value })}><option value="">不执行自动化</option>{state.automationTasks?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="自动化目标"><select value={value.automationHosts} onChange={(e) => patch({ automationHosts: e.target.value })}><option value="allocated">分配出来的备用 IP</option><option value="target">故障目标地址</option></select></Field><Field label="任务超时（秒）"><input type="number" value={value.automationTimeout} onChange={(e) => patch({ automationTimeout: e.target.value })} /></Field><Multi label="A/AAAA 解析绑定" items={state.dnsBindings?.filter((item) => ['A', 'AAAA'].includes(item.recordType))} value={value.dnsBindingIds} onChange={(dnsBindingIds) => patch({ dnsBindingIds })} secondary={(item) => item.domain} /><Field label="执行方式"><select value={value.approvalMode} onChange={(e) => patch({ approvalMode: e.target.value })}><option value="automatic">自动执行</option><option value="telegram">Telegram / Web 确认</option></select></Field><Toggle checked={value.autoRollback} onChange={(autoRollback) => patch({ autoRollback })}>失败时自动回滚</Toggle><Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用策略</Toggle></EditorGrid>;
}

function GuardEditor({ value, patch, state, api }) {
  const sources = Array.isArray(value.sources) ? value.sources : [];
  const [sourceChecks, setSourceChecks] = useState({});
  const updateSource = (index, next) => {
    const key = sources[index]?.id || index;
    if (Object.prototype.hasOwnProperty.call(next, 'domain')) setSourceChecks((current) => ({ ...current, [key]: null }));
    patch({ sources: sources.map((item, current) => current === index ? { ...item, ...next } : item) });
  };
  const checkSource = async (index) => {
    const source = sources[index];
    const domain = String(source?.domain || '').trim();
    if (!domain) return;
    const key = source.id || index;
    setSourceChecks((current) => ({ ...current, [key]: { domain, checking: true, addresses: [] } }));
    try {
      const data = await api('/api/dns-sources/resolve', { method: 'POST', body: JSON.stringify({ domain, recordType: value.recordType }) });
      setSourceChecks((current) => ({ ...current, [key]: { domain, checking: false, addresses: data.addresses || [] } }));
    } catch (_error) {
      setSourceChecks((current) => ({ ...current, [key]: { domain, checking: false, addresses: [] } }));
    }
  };
  return <EditorGrid>
    <EditorSection title="托管记录" />
    <Field label="任务名称"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
    <Field label="DNS 服务商账号"><select value={value.accountId} onChange={(e) => patch({ accountId: e.target.value })}><option value="">选择账号</option>{state.dnsAccounts?.filter((item) => item.enabled !== false).map((item) => <option key={item.id} value={item.id}>{item.name} · {PROVIDERS[item.provider] || item.provider}</option>)}</select></Field>
    <Field label="被守护完整域名"><input value={value.domain} onChange={(e) => patch({ domain: e.target.value })} placeholder="node.example.com" /></Field>
    <Field label="记录类型"><select value={value.recordType} onChange={(e) => patch({ recordType: e.target.value })}><option value="A">A · IPv4</option><option value="AAAA">AAAA · IPv6</option></select></Field>
    <Field label="TTL（秒）"><input type="number" min="1" max="86400" value={value.ttl} onChange={(e) => patch({ ttl: e.target.value })} /></Field>
    <Field label="活动解析上限"><input type="number" min="1" max="50" value={value.maxActiveIps} onChange={(e) => patch({ maxActiveIps: e.target.value })} /></Field>

    <EditorSection title="探针检查" />
    <Field label="检查类型"><select value={value.checkType} onChange={(e) => patch({ checkType: e.target.value })}><option value="ping">Ping</option><option value="tcp">TCPing</option></select></Field>
    {value.checkType === 'tcp' ? <Field label="TCP 端口"><input type="number" min="1" max="65535" value={value.port} onChange={(e) => patch({ port: e.target.value })} /></Field> : null}
    <Field label="单探针检查并发"><input type="number" min="1" max="300" value={value.maxParallel} onChange={(e) => patch({ maxParallel: e.target.value })} /></Field>
    <Field label="检查间隔（秒）"><input type="number" min="10" max="86400" value={value.interval} onChange={(e) => patch({ interval: e.target.value })} /></Field>
    <Field label="每轮超时（秒）"><input type="number" min="1" max="60" value={value.timeout} onChange={(e) => patch({ timeout: e.target.value })} /></Field>
    <Field label="检查轮数"><input type="number" min="1" max="10" value={value.checkRounds} onChange={(e) => patch({ checkRounds: e.target.value })} /></Field>
    <Field label="每轮次数"><input type="number" min="1" max="10" value={value.attemptsPerRound} onChange={(e) => patch({ attemptsPerRound: e.target.value })} /></Field>
    <Multi label="负责探针（任意一个成功即正常）" items={state.probes || []} value={value.probeIds || []} onChange={(probeIds) => patch({ probeIds })} secondary={(item) => item.region || item.carrier} searchable selectable />

    <EditorSection title="DDNS 来源域名" />
    <div className="ops-multi"><div className="ops-multi-head"><strong>来源域名</strong><span>{sources.length} 个来源</span></div><div className="ops-source-list">{sources.map((source, index) => { const key = source.id || index; const check = sourceChecks[key]; const visibleAddresses = check?.domain === String(source.domain || '').trim() ? check.addresses : []; return <div className="ops-source-item" key={key}><div className="ops-source-row"><input value={source.name || ''} placeholder="来源名称（选填）" onChange={(e) => updateSource(index, { name: e.target.value })} /><input value={source.domain || ''} placeholder="完整来源域名" onChange={(e) => updateSource(index, { domain: e.target.value })} onBlur={() => checkSource(index)} /><button type="button" className="ghost ops-source-check" disabled={!source.domain || check?.checking} onClick={() => checkSource(index)}>{check?.checking ? '检测中' : '检测'}</button><button type="button" className="icon-button danger" title="删除来源" onClick={() => patch({ sources: sources.filter((_, current) => current !== index) })}>×</button></div>{visibleAddresses?.length ? <div className="ops-source-addresses">{visibleAddresses.map((address) => <span key={address}>{address}</span>)}</div> : null}</div>; })}<button type="button" className="ghost ops-add-source" onClick={() => patch({ sources: [...sources, { id: crypto.randomUUID(), name: '', domain: '' }] })}>添加来源域名</button></div></div>
    <Toggle checked={value.pruneStale} onChange={(pruneStale) => patch({ pruneStale })}>移除来源已不再提供的旧 IP</Toggle>

    <EditorSection title="备用池补位" />
    <Multi label="备用池（按选择顺序兜底）" items={(state.ipPools || []).filter((item) => item.enabled !== false)} value={value.poolIds || []} onChange={(poolIds) => patch({ poolIds })} secondary={(item) => `${item.assetIds?.length || 0} 个 IP`} searchable selectable />
    <Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用 DNS 守护任务</Toggle>
  </EditorGrid>;
}

function PoolEditor({ value, patch, state }) {
  const [thresholdText, setThresholdText] = useState((value.alertThresholds || []).join(' '));
  const setThresholds = (text) => { setThresholdText(text); patch({ alertThresholds: [...new Set(text.split(/[,，\s]+/).map(Number).filter((item) => Number.isInteger(item) && item >= 0))].sort((a, b) => b - a) }); };
  return <EditorGrid>
    <EditorSection title="分配规则" />
    <Field label="备用池名称"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
    <Field label="取用方式"><select value={value.allocationMode} onChange={(e) => patch({ allocationMode: e.target.value })}><option value="one">一次取一个</option><option value="count">取指定数量</option><option value="all">取全部可用 IP</option></select></Field>
    <Field label="取用数量"><input type="number" min="1" disabled={value.allocationMode !== 'count'} value={value.allocationCount} onChange={(e) => patch({ allocationCount: e.target.value })} /></Field>
    <Field label="选择顺序"><select value={value.selectionMode} onChange={(e) => patch({ selectionMode: e.target.value })}><option value="ordered">固定顺序</option><option value="random">随机</option></select></Field>
    <Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用备用池并允许新分配</Toggle>

    <EditorSection title="库存" />
    <Field label="直接批量加入 IP" full><textarea className="ops-batch-ip-input" rows="7" value={value.newAssetAddresses || ''} onChange={(e) => patch({ newAssetAddresses: e.target.value })} placeholder={'每行一个，也支持空格或逗号分隔\n1.1.1.1\n2001:db8::1'} /></Field>
    <Multi label="已有 IP 资产" items={state.ipAssets || []} value={value.assetIds || []} onChange={(assetIds) => patch({ assetIds })} secondary={(item) => item.address} searchable selectable />

    <EditorSection title="Telegram 库存预警" />
    <Toggle checked={value.alertEnabled} onChange={(alertEnabled) => patch({ alertEnabled })}>启用库存下降通知</Toggle>
    {value.alertEnabled ? <><Field label="预警数量"><input value={thresholdText} onChange={(e) => setThresholds(e.target.value)} placeholder="5 3 1 0" /></Field><Field label="接收用户 / 群 ID"><textarea rows="3" value={(value.alertChatIds || []).join('\n')} onChange={(e) => patch({ alertChatIds: e.target.value.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean) })} placeholder="每行一个 ID" /></Field><Multi label="发送机器人" items={(state.telegramBots || []).filter((item) => item.enabled !== false)} value={value.alertBotIds || []} onChange={(alertBotIds) => patch({ alertBotIds })} secondary={(item) => item.configured ? '已配置' : '未配置'} /></> : null}
    <Field label="备注（选填）" full><textarea value={value.note} onChange={(e) => patch({ note: e.target.value })} /></Field>
  </EditorGrid>;
}

function EditorSection({ title }) { return <div className="ops-editor-section"><strong>{title}</strong></div>; }

function GuardDetails({ guard, runs, Dialog, onClose, onCheck }) {
  const latest = runs[0];
  return <Dialog title={guard.name} className="ops-guard-dialog" wide onClose={onClose} footer={<><span /><div className="dialog-actions"><button className="ghost" onClick={onClose}>关闭</button><button className="primary" onClick={onCheck}>立即检查</button></div></>}><div className="guard-detail-summary"><div><span>当前状态</span><strong>{STATUS[guard.status] || guard.status}</strong></div><div><span>活动解析</span><strong>{guard.currentValues?.length || 0} / {guard.maxActiveIps || 50}</strong></div><div><span>最近检查</span><strong>{formatTime(guard.lastCheckAt)}</strong></div></div><div className="guard-detail-section"><strong>服务商当前记录</strong><div className="guard-ip-grid">{guard.currentValues?.length ? guard.currentValues.map((address) => <div key={address}><i className="ops-dot ok" /><span>{address}</span><em>活动</em></div>) : <p>尚未读取到记录</p>}</div></div><div className="guard-detail-section"><strong>最近执行</strong>{latest ? <div className="guard-run"><span>{formatTime(latest.finishedAt)} · {STATUS[latest.status] || latest.status}</span><p>{latest.message}</p>{latest.failedValues?.length ? <em>故障：{latest.failedValues.join(', ')}</em> : null}</div> : <div className="guard-run"><p>尚无执行记录</p></div>}</div>{guard.lastError ? <div className="guard-error">{guard.lastError}</div> : null}</Dialog>;
}

function AccountEditor({ value, patch, api, toast }) {
  const [revealing, setRevealing] = useState(false);
  const loadedAccountId = useRef('');
  const revealCredentials = async () => {
    if (!value.id || !value.configured) return value.credentials || {};
    setRevealing(true);
    try {
      const data = await api(`/api/dns-accounts/${value.id}/credentials`);
      patch({ credentials: data.credentials || {} });
      return data.credentials || {};
    } catch (error) {
      toast(error.message);
      return {};
    } finally {
      setRevealing(false);
    }
  };
  useEffect(() => {
    if (!value.id || !value.configured || loadedAccountId.current === value.id) return;
    loadedAccountId.current = value.id;
    revealCredentials();
  }, [api, value.id, value.configured]);
  return <EditorGrid><Field label="账号名称"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field><Field label="服务商"><select value={value.provider} onChange={(e) => patch({ provider: e.target.value, credentials: {}, configured: false })}>{Object.entries(PROVIDERS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>{credentialFields(value, patch, revealCredentials, revealing)}<Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用账号</Toggle></EditorGrid>;
}

function credentialFields(value, patch, revealCredentials, revealing = false) {
  const update = (key, next) => patch({ credentials: { ...(value.credentials || {}), [key]: next } });
  const reveal = async (key) => (await revealCredentials())?.[key] || '';
  const placeholder = value.configured && revealing ? '正在读取已保存值' : '';
  if (value.provider === 'cloudflare') return <Field label="API Token" full><SecretInput value={value.credentials?.apiToken || ''} onChange={(next) => update('apiToken', next)} onReveal={() => reveal('apiToken')} placeholder={placeholder} /></Field>;
  if (value.provider === 'tencent') return <><Field label="Secret ID"><SecretInput value={value.credentials?.secretId || ''} onChange={(next) => update('secretId', next)} onReveal={() => reveal('secretId')} /></Field><Field label="Secret Key"><SecretInput value={value.credentials?.secretKey || ''} onChange={(next) => update('secretKey', next)} onReveal={() => reveal('secretKey')} /></Field></>;
  if (value.provider === 'dnspod') return <><Field label="DNSPod Token ID"><SecretInput value={value.credentials?.tokenId || ''} onChange={(next) => update('tokenId', next)} onReveal={() => reveal('tokenId')} /></Field><Field label="DNSPod Token Secret"><SecretInput value={value.credentials?.tokenSecret || ''} onChange={(next) => update('tokenSecret', next)} onReveal={() => reveal('tokenSecret')} /></Field></>;
  if (value.provider === 'godaddy') return <><Field label="API Key"><SecretInput value={value.credentials?.apiKey || ''} onChange={(next) => update('apiKey', next)} onReveal={() => reveal('apiKey')} /></Field><Field label="API Secret"><SecretInput value={value.credentials?.apiSecret || ''} onChange={(next) => update('apiSecret', next)} onReveal={() => reveal('apiSecret')} /></Field></>;
  if (value.provider === 'porkbun') return <><Field label="API Key"><SecretInput value={value.credentials?.apiKey || ''} onChange={(next) => update('apiKey', next)} onReveal={() => reveal('apiKey')} /></Field><Field label="Secret API Key"><SecretInput value={value.credentials?.secretApiKey || ''} onChange={(next) => update('secretApiKey', next)} onReveal={() => reveal('secretApiKey')} /></Field></>;
  if (value.provider === 'cloudns') return <><Field label="Auth ID"><SecretInput value={value.credentials?.authId || ''} onChange={(next) => update('authId', next)} onReveal={() => reveal('authId')} /></Field><Field label="Auth Password"><SecretInput value={value.credentials?.authPassword || ''} onChange={(next) => update('authPassword', next)} onReveal={() => reveal('authPassword')} /></Field></>;
  if (value.provider === 'callback' || ['aliyun_esa','baidu','namecheap','namesilo','dynadot','dnsla','era','tndns','gcore','edgeone','ns1','rainyun','dynv6','vercel','spaceship'].includes(value.provider)) return <><Field label="HTTPS API 地址" full><input value={value.credentials?.endpoint || ''} onChange={(e) => update('endpoint', e.target.value)} placeholder="https://example.com/ddns" /></Field><Field label="访问令牌 / API Key" full><SecretInput value={value.credentials?.token || ''} onChange={(next) => update('token', next)} onReveal={() => reveal('token')} /></Field><Field label="自定义请求头（JSON）" full><textarea rows="3" value={value.credentials?.headers || ''} onChange={(e) => update('headers', e.target.value)} placeholder='{"Authorization":"Bearer ..."}' /></Field></>;
  return <><Field label="Access Key"><SecretInput value={value.credentials?.accessKey || ''} onChange={(next) => update('accessKey', next)} onReveal={() => reveal('accessKey')} /></Field><Field label="Secret Key"><SecretInput value={value.credentials?.secretKey || ''} onChange={(next) => update('secretKey', next)} onReveal={() => reveal('secretKey')} /></Field></>;
}

function BotEditor({ value, patch, state, api, toast }) {
  const features = [['overview','总览'],['probes','探针'],['incidents','故障事件'],['pools','备用池'],['dns','解析管理'],['automation','自动化']].map(([id, name]) => ({ id, name }));
  const loadedBotId = useRef('');
  const revealToken = async () => {
    if (!value.id || !value.configured) return '';
    try {
      const data = await api(`/api/telegram-bots/${value.id}/token`);
      patch({ token: data.token || '' });
      return data.token || '';
    } catch (error) {
      toast(error.message);
      return '';
    }
  };
  useEffect(() => {
    if (!value.id || !value.configured || loadedBotId.current === value.id) return;
    loadedBotId.current = value.id;
    revealToken();
  }, [api, value.id, value.configured]);
  return <EditorGrid><Field label="机器人名称" full><input value={value.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例如：运维机器人" /></Field><Field label="Bot Token" full><SecretInput value={value.token} onChange={(token) => patch({ token })} onReveal={revealToken} placeholder={value.configured ? '正在读取已保存 Token' : 'BotFather Token'} /></Field><Field label="授权用户 ID" full><textarea rows="5" value={value.userIds} onChange={(e) => patch({ userIds: e.target.value })} placeholder="每行一个用户 ID" /></Field><Field label="角色分配" full><textarea rows="5" value={value.rolesText} onChange={(e) => patch({ rolesText: e.target.value })} placeholder={'每行：用户ID=角色\n角色：owner / admin / operator / approver / viewer / auditor'} /></Field><Multi label="允许功能" items={features} value={value.menuScopes} onChange={(menuScopes) => patch({ menuScopes })} /><Multi label="允许执行的自动化任务" items={state.automationTasks} value={value.automationTaskIds || []} onChange={(automationTaskIds) => patch({ automationTaskIds })} searchable selectable /><Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用机器人</Toggle></EditorGrid>;
}

function SecretInput({ value, onChange, onReveal, placeholder = '' }) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const toggle = async () => {
    if (!visible && !value && onReveal) {
      setLoading(true);
      try { await onReveal(); } finally { setLoading(false); }
    }
    setVisible((current) => !current);
  };
  return <div className="password-field ops-secret-field"><input type={visible ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" /><button type="button" className="icon-button password-toggle" onClick={toggle} title={visible ? '隐藏' : '查看'} disabled={loading}>{visible ? <EyeOffIcon /> : <EyeIcon />}</button></div>;
}

function EyeIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6z" /><circle cx="12" cy="12" r="3" /></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3l18 18" /><path d="M10.6 10.6A3 3 0 0012 15a3 3 0 002.4-4.8" /><path d="M6.7 6.8C4.2 8.5 2.5 12 2.5 12s3.5 6 9.5 6c2 0 3.7-.5 5.2-1.3" /><path d="M9.9 4.5A11 11 0 0112 4c6 0 9.5 6 9.5 6a18 18 0 01-2.6 3.5" /></svg>; }

function BindingEditor({ value, patch, state }) {
  const addressRecord = ['A', 'AAAA'].includes(value.recordType);
  return <EditorGrid>
    <Field label="绑定名称"><input value={value.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
    <Field label="服务商账号"><select value={value.accountId} onChange={(e) => patch({ accountId: e.target.value })}><option value="">请选择</option>{state.dnsAccounts?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    <Field label="完整域名" full><input value={value.domain} onChange={(e) => patch({ domain: e.target.value })} placeholder="例如：www.example.com" /></Field>
    <Field label="记录类型"><select value={value.recordType} onChange={(e) => patch({ recordType: e.target.value })}><option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option><option>NS</option><option>CAA</option></select></Field>
    <Field label="TTL"><input type="number" value={value.ttl} onChange={(e) => patch({ ttl: e.target.value })} /></Field>
    {addressRecord ? <Field label="更新方式"><select value={value.updateMode} onChange={(e) => patch({ updateMode: e.target.value })}><option value="append">追加 IP</option><option value="managed_replace">覆盖托管值</option><option value="replace">完全替换</option></select></Field> : null}
    {addressRecord ? <Field label={`${value.recordType} 记录值（每行一个）`} full><textarea rows="7" value={(value.backupIps || []).join?.('\n') || value.backupIps || ''} onChange={(e) => patch({ backupIps: e.target.value.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean) })} placeholder={value.recordType === 'AAAA' ? '2001:db8::1' : '1.1.1.1'} /></Field> : <Field label={value.recordType === 'CNAME' ? '记录值（单个域名）' : '记录值（每行一个）'} full><textarea rows="7" value={(value.recordValues || []).join?.('\n') || value.recordValues || ''} onChange={(e) => patch({ recordValues: e.target.value.split(/\n+/).map((item) => item.trim()).filter(Boolean) })} /></Field>}
    <Toggle checked={value.enabled} onChange={(enabled) => patch({ enabled })}>启用解析绑定</Toggle>
  </EditorGrid>;
}

function EditorGrid({ children }) { return <div className="ops-editor-grid">{children}</div>; }
function Field({ label, children, full }) { return <label className={full ? 'ops-field full' : 'ops-field'}><span>{label}</span>{children}</label>; }
function Toggle({ checked, onChange, children }) { return <label className="ops-toggle"><input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} /><span>{children}</span></label>; }
function Multi({ label, items = [], value = [], onChange, secondary, searchable = false, selectable = false }) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const visibleItems = normalized ? items.filter((item) => [item.name, item.address, secondary?.(item)].some((text) => String(text || '').toLowerCase().includes(normalized))) : items;
  const visibleIds = visibleItems.map((item) => item.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => value.includes(id));
  return <div className="ops-multi"><div className="ops-multi-head"><strong>{label}</strong><span>已选 {value.length} / {items.length}</span></div>{searchable || selectable ? <div className="ops-multi-tools">{searchable ? <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称或 IP" /> : null}{selectable ? <><button type="button" className="ghost" disabled={!visibleIds.length} onClick={() => onChange(allVisibleSelected ? value.filter((id) => !visibleIds.includes(id)) : [...new Set([...value, ...visibleIds])])}>{allVisibleSelected ? '取消当前' : '全选当前'}</button><button type="button" className="ghost" disabled={!value.length} onClick={() => onChange([])}>清空</button></> : null}</div> : null}<div className="ops-multi-options">{visibleItems.length ? visibleItems.map((item) => <label key={item.id}><input type="checkbox" checked={value.includes(item.id)} onChange={() => onChange(value.includes(item.id) ? value.filter((id) => id !== item.id) : [...value, item.id])} /><span>{item.name || item.address}<em>{secondary?.(item)}</em></span></label>) : <span className="ops-multi-empty">没有匹配的 IP 资产</span>}</div></div>;
}

function resourceFor(type) { return ({ probe: 'probes', target: 'probe-targets', guard: 'dns-guards', asset: 'ip-assets', pool: 'ip-pools', account: 'dns-accounts', binding: 'dns-bindings', policy: 'failover-policies', bot: 'telegram-bots' })[type]; }
function typeLabel(type) { return ({ probe: '探针', target: '检查目标', guard: 'DNS 守护任务', asset: 'IP 资产', pool: '备用池', account: 'DNS 账号', binding: '解析绑定', policy: '切换策略', bot: 'Telegram 机器人' })[type]; }
function normalizeDraft(type, value) { const draft = { ...structuredClone(EMPTY[type]), ...structuredClone(value) }; if (type === 'target') { delete draft.failureThreshold; delete draft.recoveryThreshold; } if (type === 'guard') { draft.sources = Array.isArray(draft.sources) ? draft.sources : []; draft.probeIds = Array.isArray(draft.probeIds) ? draft.probeIds : []; draft.poolIds = Array.isArray(draft.poolIds) ? draft.poolIds : []; } if (type === 'asset') draft.labels = (value.labels || []).join(', '); if (type === 'pool') { if (!['ordered', 'random'].includes(draft.selectionMode)) draft.selectionMode = 'ordered'; draft.assetIds = Array.isArray(draft.assetIds) ? draft.assetIds : []; draft.alertThresholds = Array.isArray(draft.alertThresholds) ? draft.alertThresholds : []; draft.alertBotIds = Array.isArray(draft.alertBotIds) ? draft.alertBotIds : []; draft.alertChatIds = Array.isArray(draft.alertChatIds) ? draft.alertChatIds : []; } if (type === 'account') draft.credentials = {}; if (type === 'bot') { draft.name = value.name || ''; draft.token = ''; draft.userIds = (value.userIds || []).join('\n'); draft.rolesText = Object.entries(value.roles || {}).map(([id, role]) => `${id}=${role}`).join('\n'); } return draft; }
function serializeDraft(type, value) { const draft = structuredClone(value); if (type === 'target') { delete draft.failureThreshold; delete draft.recoveryThreshold; } if (type === 'guard') { draft.sources = Array.isArray(draft.sources) ? draft.sources.filter((item) => item.domain?.trim()) : []; draft.probeIds = Array.isArray(draft.probeIds) ? draft.probeIds : []; draft.poolIds = Array.isArray(draft.poolIds) ? draft.poolIds : []; } if (type === 'asset') draft.labels = String(draft.labels || '').split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean); if (type === 'pool') { draft.alertThresholds = Array.isArray(draft.alertThresholds) ? draft.alertThresholds : []; draft.alertBotIds = Array.isArray(draft.alertBotIds) ? draft.alertBotIds : []; draft.alertChatIds = Array.isArray(draft.alertChatIds) ? draft.alertChatIds : []; } if (type === 'bot') { draft.userIds = String(draft.userIds || '').split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean); draft.roles = Object.fromEntries(String(draft.rolesText || '').split(/\n+/).map((line) => line.split('=').map((part) => part.trim())).filter(([id, role]) => id && role)); } return draft; }
function countFor(section, state) { return ({ nodes: state.probes, targets: state.probeTargets, guards: state.dnsGuards, policies: state.failoverPolicies, incidents: state.incidents, bots: state.telegramBots, assets: state.ipAssets, pools: state.ipPools, usage: state.ipUsageRecords, accounts: state.dnsAccounts, bindings: state.dnsBindings, changes: state.dnsChanges })[section]?.length || 0; }
function summary(tab, state) { if (tab === 'probes') return `${state.probes?.filter((item) => item.status === 'online').length || 0} 个在线探针 · ${state.dnsGuards?.filter((item) => item.enabled !== false).length || 0} 个 DNS 守护 · ${state.incidents?.filter((item) => !['succeeded', 'recovered', 'rolled_back'].includes(item.status)).length || 0} 个活动事件`; if (tab === 'pools') return `${state.ipAssets?.length || 0} 个可用 IP · ${state.ipUsageRecords?.length || 0} 条使用记录`; if (tab === 'telegram') return `${state.telegramBots?.filter((item) => item.enabled && item.configured).length || 0} 个运行中机器人`; return `${state.dnsAccounts?.length || 0} 个账号 · ${state.dnsBindings?.length || 0} 条解析绑定`; }
function allocationLabel(item) { return item.allocationMode === 'all' ? '全部取用' : item.allocationMode === 'count' ? `取 ${item.allocationCount} 个` : '一次取一个'; }
function assetSubtitle(item) { return [item.name && item.name !== item.address ? item.address : '', item.region, item.carrier].filter(Boolean).join(' · '); }
function targetSubtitle(item) { const rounds = Number(item.checkRounds) || 3; const perRound = Number(item.attemptsPerRound) || 3; const expectedAttempts = rounds * perRound; const observations = Object.values(item.observations || {}).sort((a, b) => Date.parse(b.checkedAt || 0) - Date.parse(a.checkedAt || 0)); const latest = observations[0]; const result = !latest ? '尚未检查' : latest.ok ? `第 ${latest.successfulRound || 1} 轮第 ${latest.successfulAttempt || 1} 次成功` : latest.attempts === expectedAttempts ? `${expectedAttempts} 次全部失败` : '等待探针升级'; return `${item.checkType === 'ping' ? 'PING' : `TCP:${item.port}`} · ${item.address || '未填写地址'} · ${item.probeIds?.length || 0} 个探针 · ${rounds}轮×${perRound}次 · ${result} · ${formatTime(item.lastCheckAt)}`; }
function probeVersionCurrent(version) { const parts = String(version || '').split('.').map(Number); return parts[0] > 1 || (parts[0] === 1 && (parts[1] > 3 || (parts[1] === 3 && (parts[2] || 0) >= 0))); }
function probeVersionLabel(version) { return version ? `${version}${probeVersionCurrent(version) ? '' : '（需升级）'}` : '未接入'; }
function updateModeLabel(mode) { return ({ append: '追加 IP', managed_replace: '覆盖托管值', replace: '完全替换' })[mode] || mode; }
function formatTime(value) { if (!value) return '-'; return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
