import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Run the real script with isolated paths and mocked system services/network.
// No root operation, package installation or external connection is performed.
function runScript(t, script, { installed = false, active = false, downloadFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nurows-probe-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const program = path.join(root, 'program'), config = path.join(root, 'config'), service = path.join(root, 'probe.service');
  if (installed) {
    fs.mkdirSync(program); fs.mkdirSync(config);
    fs.writeFileSync(path.join(program, 'nurossh_probe.py'), '# old agent');
    fs.writeFileSync(path.join(config, 'config.json'), '{}');
    fs.writeFileSync(service, '# old unit');
  }
  const source = fs.readFileSync(new URL(`../probe-agent/${script}.sh`, import.meta.url), 'utf8')
    .replaceAll('/opt/nurossh-probe', program).replaceAll('/etc/nurossh-probe', config)
    .replaceAll('/etc/systemd/system/nurossh-probe.service', service)
    .replace(/\nmain "\$@"\s*$/, '');
  const mocks = `
require_root() { :; }
ping() { :; }
sleep() { :; }
curl() {
  if [[ "$TEST_DOWNLOAD_FAILS" == 1 ]]; then return 22; fi
  local output=''
  while (($#)); do
    if [[ "$1" == -o ]]; then output="$2"; break; fi
    shift
  done
  printf '# synthetic agent\\n' > "$output"
}
systemctl() {
  printf '%s\\n' "$*" >> "$TEST_SERVICE_LOG"
  if [[ "$1" == is-active ]]; then [[ "$TEST_ACTIVE" == 1 ]]; else return 0; fi
}
journalctl() { printf 'synthetic service log\\n'; }
main "$@"
`;
  const result = spawnSync('bash', ['-s', '--', 'https://panel.example.com', 'probe-id', 'synthetic-private-token'], {
    input: source + mocks, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', TEST_ACTIVE: active ? '1' : '0',
      TEST_DOWNLOAD_FAILS: downloadFails ? '1' : '0', TEST_SERVICE_LOG: path.join(root, 'service.log') }
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(output.includes('\u001b'), false, 'redirected output must not contain color escapes');
  assert.equal(output.includes('synthetic-private-token'), false, 'messages must not reveal the token');
  return { ...result, output, program, config, service,
    calls: fs.existsSync(path.join(root, 'service.log')) ? fs.readFileSync(path.join(root, 'service.log'), 'utf8') : '' };
}

test('probe installer reports a fresh installation in Chinese only after service validation', t => {
  const result = runScript(t, 'install', { active: true });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[1\/4\].*检查运行环境/);
  assert.match(result.output, /\[4\/4\].*检查运行状态/);
  assert.match(result.output, /✓ 探针安装成功/);
  assert.match(result.output, /请在探针列表确认上线/);
  assert.match(result.calls, /restart nurossh-probe.service\nis-active --quiet nurossh-probe.service/);
  const config = JSON.parse(fs.readFileSync(path.join(result.config, 'config.json'), 'utf8'));
  assert.equal(config.maxConcurrency, 100);
  assert.equal(config.token, 'synthetic-private-token');
  assert.equal(fs.statSync(path.join(result.config, 'config.json')).mode & 0o777, 0o600);
});

test('probe installer distinguishes an upgrade from a fresh installation', t => {
  const result = runScript(t, 'install', { installed: true, active: true });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /NuroSSH 探针 · 升级/);
  assert.match(result.output, /✓ 探针升级成功/);
  assert.doesNotMatch(result.output, /探针安装成功/);
});

test('failed service startup gives Chinese diagnostics without reporting success', t => {
  const result = runScript(t, 'install');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /探针安装失败：服务未能正常启动/);
  assert.match(result.output, /synthetic service log/);
  assert.doesNotMatch(result.output, /✓.*成功/);
});

test('failed download identifies the failed step and does not restart the probe', t => {
  const result = runScript(t, 'install', { downloadFails: true });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /探针安装未完成：下载探针程序失败/);
  assert.doesNotMatch(result.calls, /restart/);
  assert.doesNotMatch(result.output, /✓.*成功/);
});

test('probe uninstaller reports Chinese progress and removes only isolated probe files', t => {
  const result = runScript(t, 'uninstall', { installed: true });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[1\/3\].*停止服务/);
  assert.match(result.output, /✓ 探针卸载成功/);
  assert.match(result.output, /已保留.*面板中的探针记录与历史数据/);
  for (const target of [result.program, result.config, result.service]) assert.equal(fs.existsSync(target), false);
});

test('probe uninstaller preserves files if the service cannot be stopped', t => {
  const result = runScript(t, 'uninstall', { installed: true, active: true });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /服务仍在运行，未删除程序和配置/);
  assert.doesNotMatch(result.output, /✓.*成功/);
  for (const target of [result.program, result.config, result.service]) assert.equal(fs.existsSync(target), true);
});
