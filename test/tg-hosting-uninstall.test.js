import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const owner = '123456abcdef', otherOwner = 'fedcba654321';
async function run(t, mode = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-uninstall-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const deployment = path.join(root, 'deployment'), foreign = path.join(root, 'foreign'), log = path.join(root, 'calls');
  await fs.mkdir(deployment); await fs.mkdir(foreign);
  await fs.writeFile(path.join(deployment, 'session'), 'login fixture');
  if (mode === 'profile-protected') {
    await fs.mkdir(path.join(deployment, 'tg-browser-data', 'account'), { recursive: true });
    await fs.writeFile(path.join(deployment, 'tg-browser-data', 'account', 'session'), 'login fixture');
  }
  if (['snapshot-protected', 'marker-protected'].includes(mode)) {
    await fs.mkdir(path.join(deployment, 'data', 'tg-hosted-snapshots'), { recursive: true });
    await fs.writeFile(path.join(deployment, 'data', 'tg-hosted-snapshots', mode === 'snapshot-protected' ? 'account.tar.gz.enc' : 'account.profile-known'), 'preserved');
  }
  if (mode === 'empty-network') {
    await fs.mkdir(path.join(deployment, 'tg-browser-data'));
    await fs.writeFile(path.join(deployment, 'tg-browser-data', '.tg-owner'), owner + '\n');
  }
  await fs.writeFile(path.join(foreign, 'session'), 'other instance');
  await fs.writeFile(log, '');
  const container = (id, currentOwner, directory, destination = '/profile') => ({ Id: id, Config: { Labels: destination === '/profiles' ? { 'com.docker.compose.service': 'tg-runner' } : { 'nurossh.tg.owner': currentOwner } }, Mounts: [{ Type: 'bind', Source: path.join(directory, 'tg-browser-data', destination === '/profile' ? 'account' : ''), Destination: destination }], State: { Running: destination !== '/profiles' }, NetworkSettings: { Networks: {} } });
  const ours = container('ours', owner, deployment), theirs = container('foreign', mode === 'duplicate' ? owner : otherOwner, foreign);
  const runner = container('runner', '', deployment, '/profiles');
  runner.State.Running = mode === 'running'; runner.NetworkSettings.Networks.tg = { NetworkID: 'our-network' };
  const containers = mode === 'empty-network' ? [theirs] : mode === 'network-only' ? [runner, theirs] : mode === 'no-runner' ? [ours, theirs] : [ours, runner, theirs];
  if (mode === 'cpu-group') {
    const anchor = container('cpu-anchor', owner, deployment, '/ownership');
    anchor.Config.Labels['nurossh.tg.cpu-group'] = '1'; anchor.Mounts[0].RW = false;
    containers.push(anchor);
  }
  const networks = [{ Id: 'our-network', Labels: { 'nurossh.tg.owner': owner }, Containers: { ...(['network-only', 'empty-network'].includes(mode) ? {} : { ours: {} }), ...(['no-runner', 'empty-network'].includes(mode) ? {} : { runner: {} }), ...(mode === 'foreign-network' ? { foreign: {} } : {}) } }, { Id: 'foreign-network', Labels: { 'nurossh.tg.owner': otherOwner }, Containers: { foreign: {} } }];
  await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify({ containers, networks, mode }));
  await fs.writeFile(path.join(root, 'docker'), `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),fixture=JSON.parse(fs.readFileSync(process.env.TG_UNINSTALL_ROOT+'/fixture.json'));fs.appendFileSync(process.env.TG_UNINSTALL_LOG,JSON.stringify(args)+'\\n');
const {containers,networks,mode}=fixture;
if(args[0]==='ps')console.log(containers.filter(c=>args.at(-1).includes('service=')?c.Config.Labels['com.docker.compose.service']:c.Config.Labels['nurossh.tg.owner']).map(c=>c.Id).join('\\n'));
else if(args[0]==='container'&&args[1]==='inspect')console.log(JSON.stringify(containers.filter(c=>args.slice(2).includes(c.Id))));
else if(args[0]==='network'&&args[1]==='ls')console.log(networks.map(n=>n.Id).join('\\n'));
else if(args[0]==='network'&&args[1]==='inspect')console.log(JSON.stringify(networks.filter(n=>args.slice(2).includes(n.Id))));
else if((args[0]==='rm'&&mode==='remove-failure')||(args[0]==='stop'&&mode==='stop-failure'))process.exit(1);
else if(!['stop','rm','network'].includes(args[0]))process.exit(99);
`);
  await fs.chmod(path.join(root, 'docker'), 0o755);
  const result = spawnSync('bash', ['-c', `source "$1/install.sh"
export PATH="$2:$PATH"
STATE_FILE="$2/state"
require_docker() { :; }; require_compose() { :; }; ensure_host_dependencies() { :; }
get_workdir() { printf '%s/deployment' "$TG_UNINSTALL_ROOT"; }
compose_cmd() { printf 'compose %s\\n' "$*" >> "$TG_UNINSTALL_LOG"; if [[ "$*" == stop && "$TG_UNINSTALL_MODE" == profile-race ]]; then mkdir -p "$TG_UNINSTALL_ROOT/deployment/tg-browser-data/account"; printf 'login fixture' > "$TG_UNINSTALL_ROOT/deployment/tg-browser-data/account/session"; fi; [[ "$*" != down* || "$TG_UNINSTALL_MODE" != down-failure ]]; }
uninstall_service <<< y`, '_', repo, root], { encoding: 'utf8', env: { ...process.env, TG_UNINSTALL_ROOT: root, TG_UNINSTALL_LOG: log, TG_UNINSTALL_MODE: mode } });
  assert.equal(await fs.readFile(path.join(foreign, 'session'), 'utf8'), 'other instance');
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n');
  const exists = await fs.stat(deployment).then(() => true, () => false);
  return { ...result, calls, exists };
}

test('complete uninstall removes only this instance including orphan browsers and networks', async t => {
  for (const mode of ['', 'no-runner', 'network-only', 'empty-network', 'cpu-group']) {
    const result = await run(t, mode);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.exists, false);
    assert.ok(result.calls.includes('compose stop'));
    assert.ok(result.calls.includes('compose down -v'));
    assert.ok(result.calls.includes('["network","rm","our-network"]'));
    if (!['network-only', 'empty-network'].includes(mode)) assert.ok(result.calls.includes('["rm","ours"]'));
    if (mode === 'cpu-group') assert.ok(result.calls.includes('["rm","cpu-anchor"]'));
    assert.ok(!result.calls.some(c => /prune|rmi/.test(c) || c === '["rm","foreign"]' || c === '["network","rm","foreign-network"]'));
  }
});

test('uninstall retains data on controller/container/compose failures and rejects shared resources', async t => {
  for (const mode of ['running', 'duplicate', 'foreign-network', 'remove-failure', 'stop-failure', 'down-failure']) {
    const result = await run(t, mode);
    assert.notEqual(result.status, 0, mode); assert.equal(result.exists, true, mode);
    assert.match(result.stderr, /数据目录仍保留/);
    if (['running', 'duplicate', 'foreign-network'].includes(mode)) assert.ok(!result.calls.some(c => c.startsWith('["rm"') || c.startsWith('["stop"') || c.startsWith('["network","rm"')));
  }
});

test('full uninstall cannot implicitly delete sessions, encrypted snapshots or their persistent markers', async t => {
  for (const mode of ['profile-protected','snapshot-protected','marker-protected','profile-race']) {
    const result=await run(t,mode);
    assert.notEqual(result.status,0);assert.equal(result.exists,true);assert.match(result.stderr,/只有主动删除/);
    assert.ok(!result.calls.some(call=>call==='compose down -v'||call.startsWith('["rm"')||call.startsWith('["stop"')));
    if(mode!=='profile-race')assert.deepEqual(result.calls,['']);
  }
});
