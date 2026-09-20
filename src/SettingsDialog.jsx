import { useId, useState } from 'react';
import Dialog from './Dialog.jsx';
import HistoryRecords from './HistoryRecords.jsx';
import './settings.css';

const CATEGORIES = [
  ['auditLogs', '审计记录'], ['automationRuns', '自动化执行'], ['dnsGuardRuns', 'DNS 守护'],
  ['dynamicGuardRuns', '动态 IP 守护'], ['incidents', '故障事件'], ['ipUsageRecords', 'IP 使用'], ['dnsChanges', 'DNS 变更']
];

function Tabs({ items, value, onChange, label, prefix, className = '' }) {
  const move = (event, index) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); onChange(items[next][0]);
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
  };
  return <div className={`settings-tabs ${className}`} role="tablist" aria-label={label}>{items.map(([id, name], index) =>
    <button key={id} type="button" role="tab" id={`${prefix}-${id}`} aria-controls={`${prefix}-panel`} aria-selected={value === id}
      tabIndex={value === id ? 0 : -1} className={value === id ? 'active' : ''} onKeyDown={(event) => move(event, index)} onClick={() => onChange(id)}>{name}</button>
  )}</div>;
}

export function HistoryBrowser({ initialScope = 'auditLogs', api, revision, clearing, onClear }) {
  const [scope, setScope] = useState(initialScope);
  const prefix = useId();
  return <div className="history-browser">
    <Tabs items={CATEGORIES} value={scope} onChange={setScope} label="历史记录类别" prefix={prefix} className="history-category-tabs" />
    <div role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-${scope}`} className="history-category-panel">
      <HistoryRecords key={scope} scope={scope} api={api} revision={revision} clearing={clearing} onClear={onClear} />
    </div>
  </div>;
}

export default function SettingsDialog({ accountForm, setAccountForm, accountError, saving, onSave, onClose, onLogout,
  api, historyRevision, historyClearing, onClearHistory }) {
  const [tab, setTab] = useState('account');
  const prefix = useId();
  const patch = (name, value) => setAccountForm((current) => ({ ...current, [name]: value }));
  const close = () => { if (!saving) onClose(); };
  return <Dialog title="设置" className="settings-dialog" onClose={close} footer={<>
    <button className="ghost settings-logout" onClick={onLogout} disabled={saving}>退出登录</button>
    <div className="dialog-actions"><button className="ghost" onClick={close} disabled={saving}>{tab === 'account' ? '取消' : '关闭'}</button>
      {tab === 'account' ? <button className="primary" form="account-settings-form" type="submit" disabled={saving}>{saving ? '保存中...' : '保存设置'}</button> : null}
    </div>
  </>}>
    <Tabs items={[[ 'account', '账号设置' ], [ 'history', '历史记录' ]]} value={tab} onChange={setTab} label="设置分类" prefix={prefix} />
    <div role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-${tab}`} className="settings-panel">
      {tab === 'account' ? <form id="account-settings-form" onSubmit={(event) => { event.preventDefault(); if (!saving) onSave(); }}>
        <div className="settings-section-heading"><h3>账号与密码</h3><p>修改账号信息时，请输入当前密码确认。</p></div>
        <fieldset className="settings-account-fields" disabled={saving}>
          <label>用户名<input autoComplete="username" value={accountForm.username} onChange={(event) => patch('username', event.target.value)} /></label>
          <label>当前密码<input type="password" required autoComplete="current-password" value={accountForm.currentPassword} placeholder="输入当前登录密码" onChange={(event) => patch('currentPassword', event.target.value)} /></label>
          <div className="settings-password-fields">
            <label>新密码<input type="password" autoComplete="new-password" value={accountForm.newPassword} placeholder="留空则不修改" onChange={(event) => patch('newPassword', event.target.value)} /></label>
            <label>确认新密码<input type="password" autoComplete="new-password" value={accountForm.confirmPassword} placeholder="再次输入新密码" onChange={(event) => patch('confirmPassword', event.target.value)} /></label>
          </div>
        </fieldset>
        {accountError ? <p className="auth-error" role="alert">{accountError}</p> : null}
      </form> : <>
        <div className="settings-retention"><div><strong>自动保留 7 天</strong><p>过期记录自动清理，达到条数上限时可能提前清理。执行中及恢复所需记录会保留。</p></div>
          <button className="ghost danger-text-button" disabled={historyClearing} onClick={() => onClearHistory('all')}>{historyClearing ? '清理中...' : '清理所有类别'}</button>
        </div>
        <HistoryBrowser api={api} revision={historyRevision} clearing={historyClearing} onClear={onClearHistory} />
      </>}
    </div>
  </Dialog>;
}
