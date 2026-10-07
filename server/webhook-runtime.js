import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { Client } from 'ssh2';

export const OUTPUT_LIMIT = 65536;
export const shellQuote = (text) => "'" + String(text).replaceAll("'", "'\\''") + "'";
// Explicit IPv4/IPv6 arguments always win. Only the default curl transport is IPv4.
export const IPV4_SHELL = `curl() { local a; for a in "$@"; do case "$a" in -4|-6|--ipv4|--ipv6) command curl "$@"; return $?;; esac; done; command curl -4 "$@"; };\n`;

export function createOutputBuffer(secrets = []) {
  let output = '', truncated = false;
  const values = [...new Set(secrets.filter((value) => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
  const hideAll = values.length > 128 || values.reduce((size, value) => size + value.length, 0) > OUTPUT_LIMIT;
  const matcher = !hideAll && values.length ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  // A single replacement pass avoids repeated expansion when secrets overlap
  // or happen to match the redaction marker itself.
  const redact = (text) => hideAll && text ? '[输出包含过多凭证，已隐藏]' : matcher ? text.replace(matcher, '[已隐藏]') : text;
  return {
    append(chunk) { output += chunk.toString(); if (Buffer.byteLength(output) > OUTPUT_LIMIT + 4096) { output = Buffer.from(output).subarray(-OUTPUT_LIMIT).toString('utf8'); truncated = true; } },
    value() { const safe = redact(output); const clipped = Buffer.from(safe).subarray(-OUTPUT_LIMIT).toString('utf8'); return (truncated || clipped !== safe ? '[较早输出已截断]\n' : '') + clipped; }
  };
}

export function runLocalWebhook(command, timeout, { signal, secrets = [], onOutput } = {}) {
  return new Promise((resolve) => {
    const buffer = createOutputBuffer(secrets);
    let lastOutput = 0;
    const append = (data) => { buffer.append(data); if (onOutput && Date.now() - lastOutput >= 1000) { lastOutput = Date.now(); onOutput(buffer.value()); } };
    let child, finished = false, timer, killTimer, deadline = false;
    const kill = (force = false) => { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ } };
    const stop = () => { kill(); killTimer ||= setTimeout(() => kill(true), 1500); killTimer.unref(); };
    const finish = (result) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      resolve({ ...result, output: buffer.value() });
    };
    try {
      child = spawn('bash', ['-lc', IPV4_SHELL + command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp' } });
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.once('error', () => finish({ status: 'failed', ok: false, uncertain: false, error: '无法启动 Bash，请检查运行环境' }));
      child.once('close', (code) => {
        // Also terminate children that survive the parent shell.
        stop();
        finish({ status: signal?.aborted ? 'cancelled' : deadline ? 'timeout' : code === 0 ? 'success' : 'failed',
          ok: !signal?.aborted && !deadline && code === 0, uncertain: deadline || Boolean(signal?.aborted), exitCode: code,
          error: deadline ? '命令执行超时；已提交的 API 请求可能仍生效' : signal?.aborted ? '执行已停止；已提交的请求无法撤回' : code ? `命令退出码 ${code}` : '' });
      });
      timer = setTimeout(() => { deadline = true; stop(); }, timeout * 1000);
      signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    } catch { finish({ status: 'failed', ok: false, uncertain: false, error: '无法启动命令' }); }
  });
}

export async function runSshWebhook(command, timeout, { server, options, proxySocket, signal, secrets = [], onOutput }) {
  const ssh = new Client(), buffer = createOutputBuffer(secrets);
  let lastOutput = 0;
  const append = (data) => { buffer.append(data); if (onOutput && Date.now() - lastOutput >= 1000) { lastOutput = Date.now(); onOutput(buffer.value()); } };
  return new Promise((resolve) => {
    let settled = false, submitted = false, socket;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); socket?.destroy(); ssh.destroy(); resolve({ ...result, output: buffer.value() }); };
    const stop = () => finish({ ok: false, status: 'cancelled', uncertain: submitted, error: submitted ? '连接已停止，远程执行结果待确认' : '已取消连接' });
    const timer = setTimeout(() => finish({ ok: false, status: submitted ? 'uncertain' : 'timeout', uncertain: submitted,
      error: submitted ? '远程命令超时，执行结果待确认' : 'SSH 连接超时' }), timeout * 1000 + 2500);
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) { stop(); return; }
    ssh.on('error', () => finish({ ok: false, status: submitted ? 'uncertain' : 'failed', uncertain: submitted, error: submitted ? 'SSH 连接中断，远程结果待确认' : 'SSH 连接失败，请检查服务器及代理配置' }));
    ssh.on('close', () => { if (!settled) finish({ ok: false, status: submitted ? 'uncertain' : 'failed', uncertain: submitted, error: submitted ? 'SSH 连接已关闭，执行结果待确认' : 'SSH 连接已关闭，命令未提交' }); });
    ssh.on('ready', () => {
      // The remote deadline survives a dropped SSH connection. Never run an
      // unbounded command on hosts without GNU timeout.
      const wrapper = `command -v timeout >/dev/null 2>&1 || { echo '远程缺少 timeout，请安装 coreutils'; exit 125; }; exec timeout --signal=TERM --kill-after=2s ${timeout}s bash -lc ${shellQuote(IPV4_SHELL + command)}`;
      submitted = true;
      ssh.exec(wrapper, (error, stream) => {
        if (error) { finish({ ok: false, status: 'uncertain', uncertain: true, error: '远程命令提交结果待确认' }); return; }
        stream.on('data', append); stream.stderr.on('data', append);
        stream.once('close', (code) => finish({ ok: code === 0, status: code === 0 ? 'success' : [124, 137].includes(code) ? 'timeout' : Number.isInteger(code) ? 'failed' : 'uncertain',
          uncertain: !Number.isInteger(code) || [124, 137].includes(code), exitCode: code, error: code === 0 ? '' : `远程命令${Number.isInteger(code) ? `退出码 ${code}` : '结果待确认'}` }));
      });
    });
    Promise.resolve().then(async () => {
      if (proxySocket) { socket = await proxySocket(); if (settled) { socket.destroy(); return; } ssh.connect({ ...options, sock: socket }); }
      else { const address = net.isIP(server.host) ? server.host : (await lookup(server.host, { order: 'ipv4first' })).address; if (!settled) ssh.connect({ ...options, host: address }); }
    }).catch(() => finish({ ok: false, status: 'failed', uncertain: false, error: '无法连接服务器或代理' }));
  });
}
