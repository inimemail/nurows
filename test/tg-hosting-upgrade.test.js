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
