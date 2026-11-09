import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const harness = `
source "$1/install.sh"
cd "$2"
docker() {
  printf 'docker %s\\n' "$*" >> "$TG_FIXTURE_LOG"
  case "$1" in
    version) printf '%s\\n' "$TG_FIXTURE_MIN" ;;
    cp) cp "$TG_FIXTURE_SOURCE" "$3" ;;
    inspect)
      case "$3" in
        '{{.Config.Image}}') printf 'fixture-tg-runner:current\\n' ;;
        '{{.Image}}') printf 'sha256:original\\n' ;;
        '{{.State.Running}}') printf '%s\\n' "$TG_FIXTURE_RUNNING" ;;
      esac ;;
    build) [[ "$TG_FIXTURE_FAILURE" != build ]] ;;
    image) : ;;
    *) return 91 ;;
  esac
}
compose_cmd() {
  printf 'compose %s\\n' "$*" >> "$TG_FIXTURE_LOG"
  case "$1" in
    ps)
      if [[ "$*" == *nurossh* ]]; then
        [[ "$TG_FIXTURE_PANEL" != true ]] || printf 'fixture-panel\\n'
      else
        [[ "$TG_FIXTURE_CONTAINER" != true ]] || printf 'fixture-runner\\n'
      fi ;;
    up)
      if [[ "$TG_FIXTURE_FAILURE" == start && ! -e "$TG_FIXTURE_LOG.failed" ]]; then
        touch "$TG_FIXTURE_LOG.failed"
        return 1
      fi ;;
    exec) [[ "$TG_FIXTURE_FAILURE" != readiness ]] ;;
    *) return 92 ;;
  esac
}
sleep() { :; }
prepare_tg_upgrade_backup "$3"
`;

async function run(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-upgrade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls'), source = path.join(root, 'old-runner.mjs');
  await fs.writeFile(log, '');
  await fs.writeFile(source, options.patched ? "import {createTgDockerClient} from './shared/tg-docker.js';" : 'const endpoint = `/v1.41${endpoint}`;');
  if (!options.disabled) await fs.writeFile(path.join(root, 'docker-compose.tg.yml'), 'services: {}\n');
  const profile = path.join(root, 'tg-browser-data', 'account');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'session'), 'keep-this-session');
  const result = spawnSync('bash', ['-c', harness, '_', repo, root, options.bundle === false ? '' : repo], {
    encoding: 'utf8',
    env: { ...process.env, TG_FIXTURE_LOG: log, TG_FIXTURE_SOURCE: source, TG_FIXTURE_MIN: options.minimum || '1.44', TG_FIXTURE_RUNNING: String(options.running ?? true), TG_FIXTURE_PANEL: String(options.panel ?? true), TG_FIXTURE_CONTAINER: String(options.container ?? true), TG_FIXTURE_FAILURE: options.failure || '' },
  });
  assert.equal(await fs.readFile(path.join(profile, 'session'), 'utf8'), 'keep-this-session');
  return { ...result, calls: (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean) };
}

test('upgrade repairs an incompatible old runner before backup without recreating the panel or browsers', async t => {
  const result = await run(t);
  assert.equal(result.status, 0, result.stderr);
  const build = result.calls.findIndex(call => call.startsWith('docker build '));
  const start = result.calls.findIndex(call => call.startsWith('compose up '));
  assert.ok(build >= 0 && start > build);
  assert.match(result.calls[build], /--target runner .*--tag fixture-tg-runner:current/);
  assert.equal(result.calls[start], 'compose up -d --no-deps --no-build tg-runner');
  assert.match(result.calls[start + 1], /^compose exec -T tg-runner /);
  assert.ok(!result.calls.some(call => /stop|remove|prune|force-recreate/.test(call)));
});

test('regular backups, compatible engines, fixed runners and disabled components need no bootstrap', async t => {
  for (const options of [{ bundle: false }, { minimum: '1.40' }, { patched: true }, { disabled: true }, { container: false }]) {
    const result = await run(t, options);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.calls.some(call => /docker build|compose up|compose exec/.test(call)), JSON.stringify(options));
  }
});

test('a stopped deployment receives a compatible image but its sessions stay inactive', async t => {
  const result = await run(t, { running: false, panel: false });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some(call => call.startsWith('docker build ')));
  assert.ok(!result.calls.some(call => call.startsWith('compose up ') || call.startsWith('compose exec ')));
});

test('a failed compatibility build aborts before touching the running component', async t => {
  const result = await run(t, { failure: 'build' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /兼容组件构建失败/);
  assert.ok(!result.calls.some(call => call.startsWith('compose up ')));
});

test('failed startup or readiness restores the old image and stops the upgrade', async t => {
  for (const failure of ['start', 'readiness']) {
    const result = await run(t, { failure });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未跳过备份/);
    const rollback = result.calls.indexOf('docker image tag sha256:original fixture-tg-runner:current');
    assert.ok(rollback > 0);
    assert.equal(result.calls[rollback + 1], 'compose up -d --no-deps --no-build tg-runner');
  }
});

test('panel upgrades reuse the installed browser image and fresh machines build it once', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-browser-reuse-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'docker-compose.tg.yml'), 'services: {}');
  const script = 'source "$1/install.sh"; cd "$2"; docker(){ [[ "$TG_IMAGE_PRESENT" == yes ]]; }; compose_cmd(){ printf "BUILD %s\\n" "$*"; }; build_tg_browser';
  for (const present of ['yes', 'no']) {
    const result = spawnSync('bash', ['-c', script, '_', repo, root], { encoding: 'utf8', env: { ...process.env, TG_IMAGE_PRESENT: present } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.includes('BUILD'), present === 'no');
    if (present === 'no') assert.match(result.stdout, /--profile tg-image build tg-browser/);
  }
  await fs.rm(path.join(root, 'docker-compose.tg.yml'));
  const disabled = spawnSync('bash', ['-c', script, '_', repo, root], { encoding: 'utf8' }); assert.equal(disabled.status, 0); assert.equal(disabled.stdout, '');
});

test('explicit browser upgrade requires candidate startup, clean stop and complete backup before changing tags', async t => {
  for (const failure of ['', 'build', 'run', 'health', 'flush', 'backup', 'changed']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-browser-upgrade-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'app/tg-hosting'), { recursive: true });
    await fs.writeFile(path.join(root, 'docker-compose.tg.yml'), 'services: {}'); await fs.writeFile(path.join(root, 'app/tg-hosting/Dockerfile'), 'FROM fixture');
    await fs.mkdir(path.join(root, 'tg-browser-data/account'), { recursive: true }); await fs.writeFile(path.join(root, 'tg-browser-data/account/session'), 'retained');
    const log = path.join(root, 'calls'); await fs.writeFile(log, '');
    const script = `source "$1/install.sh"
get_workdir(){ printf '%s' "$TG_UPGRADE_ROOT"; }
require_docker(){ :; }; require_compose(){ :; }; ensure_host_dependencies(){ :; }; sleep(){ :; }; flock(){ :; }
backup_service(){ printf 'BACKUP\\n' >> "$TG_FIXTURE_LOG"; [[ "$TG_FAILURE" != backup ]] || return 1; touch "$TG_FIXTURE_LOG.backed-up"; }
docker(){
 printf '%s\\n' "$*" >> "$TG_FIXTURE_LOG"
 case "$1" in
  image) case "$2" in
   inspect) if [[ "$TG_FAILURE" == changed && -e "$TG_FIXTURE_LOG.backed-up" ]]; then printf 'sha256:other'; else printf 'sha256:old'; fi ;;
   *) : ;;
   esac ;;
  build) [[ "$TG_FAILURE" != build ]] ;;
  run) [[ "$TG_FAILURE" != run ]] || return 1; printf 'disposable-smoke' ;;
  inspect) case "$3" in
   *ExitCode*) [[ "$TG_FAILURE" != flush ]] && printf 0 || printf 75 ;;
   *Health*) [[ "$TG_FAILURE" != health ]] && printf 'true healthy' || printf 'true unhealthy' ;;
   *) printf true ;;
   esac ;;
  exec|stop|rm) : ;;
  *) return 99 ;;
 esac
}
upgrade_tg_browser`;
    const result = spawnSync('bash', ['-c', script, '_', repo], { encoding: 'utf8', env: { ...process.env, TG_FAILURE: failure, TG_UPGRADE_ROOT: root, TG_FIXTURE_LOG: log } });
    const calls = (await fs.readFile(log, 'utf8')).split('\n');
    assert.equal(result.status === 0, !failure, `${failure}: ${result.stderr}`);
    const swap = calls.findIndex(call => /^image tag nurossh-tg-browser:candidate-.* nurossh-tg-browser:local$/.test(call));
    if (!failure) {
      assert.ok(swap > calls.indexOf('BACKUP')); assert.ok(calls.indexOf('BACKUP') > calls.findIndex(call => call === 'stop -t 25 disposable-smoke'));
      assert.ok(calls.some(call => /^image tag sha256:old nurossh-tg-browser:previous-/.test(call)));
    } else assert.equal(swap, -1, failure);
    assert.ok(!calls.some(call => /force-recreate|prune|rm .*account/.test(call)));
    assert.equal(await fs.readFile(path.join(root, 'tg-browser-data/account/session'), 'utf8'), 'retained');
  }
});
