const compact = (value, limit) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);

function reason(item) {
  if (item.awaitingInput) return '等待交互输入，请检查任务的等待关键词和输入步骤';
  const error = String(item.error || '');
  if (/timed? out.*handshake|handshake.*timed? out/i.test(error)) return 'SSH 握手超时，请检查 SSH 端口和连接超时设置';
  if (/authentication|auth.*failed|permission denied/i.test(error)) return 'SSH 认证失败，请检查用户名、密码或密钥';
  if (/ECONNREFUSED/i.test(error)) return 'SSH 连接被拒绝，请检查端口和服务';
  if (/ENOTFOUND|EAI_AGAIN/i.test(error)) return '主机域名解析失败';
  if (/ETIMEDOUT|connect.*timed? out/i.test(error)) return 'SSH 连接超时，请检查网络与防火墙';
  if (error) return compact(error, 160);
  if (Number.isFinite(item.exitCode) && item.exitCode !== 0) return `命令退出码 ${item.exitCode}，请查看自动化执行输出`;
  if (item.status === 'queued') return '仍在等待执行名额';
  if (item.status === 'running') return '命令尚未执行结束';
  return '执行未成功，请查看自动化执行记录';
}

// Propagate host/error/exit-code metadata, never command stdout or stderr:
// terminal output can contain passwords, tokens and other private input.
export function automationJobFailure(job, { timedOut = false, timeoutSeconds = 1800 } = {}) {
  const affected = job.results.filter(item => timedOut
    ? !['done', 'error'].includes(item.status)
    : item.status === 'error' || !item.ok);
  const details = affected.slice(0, 3).map(item => {
    const host = compact(item.host || item.name || item.serverId, 100);
    return `${host || '未知主机'}：${reason(item)}`;
  }).join('；');
  const summary = timedOut
    ? `自动化任务等待超时（${timeoutSeconds} 秒），已请求停止剩余 ${affected.length} 台`
    : `自动化任务有 ${affected.length} 台执行失败`;
  return `${summary}${details ? `：${details}` : ''}${affected.length > 3 ? '；其余请查看自动化执行记录' : ''}`;
}
