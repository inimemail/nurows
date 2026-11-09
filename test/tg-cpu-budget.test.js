import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { tgCpuTotal, tgHostingSettings, tgMemoryBudget } from '../shared/tg-hosting.js';
import { createTgCpuGroup } from '../shared/tg-cpu-group.js';

const source = await fs.readFile(new URL('../tg-hosting/runner.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function cpuBudget('), source.indexOf('\nasync function startBudget('));
function fixture(cpus, options = {}) {
  const rows = cpus.map((cpu, i) => ({ id: 'account-' + i, state: 'running', cpu }));
  const containers = new Map(rows.map(row => [row.id, { State: { Running: true, StartedAt: 'unchanged' }, HostConfig: { NanoCpus: row.cpu * 1e9, Memory: 1024 ** 3, MemorySwap: 1024 ** 3 } }]));
  const calls = [], settings = { cpu: 1, cpuTotal: 3 };
  let at = Date.now();
  const budget = vm.runInNewContext(`let cpuSyncRetryAt=0; (${body})`, {
    tgCpuTotal, Date: { now: () => at }, active: () => rows, settings,
    cpuGroup: { ensure: async () => { calls.push(['group']); return { ready: !options.groupError, error: options.groupError }; } },
    inspect: async id => { calls.push(['inspect', id]); if (options.inspectError) throw Error('unavailable'); return structuredClone(containers.get(id)); }, name: id => id,
    docker: async (method, url, input, timeout) => {
      assert.equal(method, 'POST'); assert.ok(timeout > 0 && timeout <= 2000); assert.deepEqual(Object.keys(input), ['NanoCpus']);
      const id = url.split('/')[2]; calls.push(['update', id, input.NanoCpus]);
      if (options.rejectUpdate) throw Error('Docker rejected update');
      containers.get(id).HostConfig.NanoCpus = input.NanoCpus;
      if (options.loseAcknowledgement) { options.loseAcknowledgement = false; throw Error('lost acknowledgement'); }
    },
  });
  return { rows, containers, calls, budget, settings, advance: () => { at += 30001; } };
}

test('aggregate CPU defaults to 75%, is independent of account count, and survives old settings', () => {
  assert.equal(tgCpuTotal(4), 3); assert.equal(tgCpuTotal(4, 2), 2); assert.equal(tgCpuTotal(2, 8), 2);
  assert.equal(tgHostingSettings({ cpu: 1, maxRunning: 4 }).cpuTotal, 0);
  for (const cpuTotal of [-1, .1, .3, 257, NaN, '3', null]) assert.throws(() => tgHostingSettings({ cpuTotal }));
  assert.equal(tgHostingSettings({ cpuTotal: .25 }).cpuTotal, .25);
});

test('four accounts keep individual 1-core caps despite a shared 3-core limit', async () => {
  const h = fixture([1, 1, 1]);
  assert.equal((await h.budget({ totalCpus: 4 })).cpu, 1);
  assert.deepEqual(h.calls, [['group']]); // No fixed division and no sum-based rejection.
});

test('legacy divided caps return to the configured single-account maximum without restarts or memory changes', async () => {
  const h = fixture([.75, .75, .75, .75]);
  assert.equal((await h.budget({ totalCpus: 4 })).cpu, 1);
  assert.deepEqual(h.rows.map(row => row.cpu), [1, 1, 1, 1]);
  for (const c of h.containers.values()) { assert.equal(c.State.StartedAt, 'unchanged'); assert.equal(c.HostConfig.Memory, 1024 ** 3); assert.equal(c.HostConfig.MemorySwap, 1024 ** 3); }
});

test('a smaller aggregate limit bounds a single account without dividing by account count', async () => {
  const h = fixture([1, 1, 1]); h.settings.cpuTotal = .5;
  assert.equal((await h.budget({ totalCpus: 4 })).cpu, .5);
  assert.deepEqual(h.rows.map(row => row.cpu), [.5, .5, .5]);
});

test('cgroup v1 reduces children before reducing the parent and increases parent before children', async () => {
  const h = fixture([1, 1]); h.rows.forEach(row => { row.cpuGrouped = true; }); h.settings.cpuTotal = .5;
  assert.equal((await h.budget({ totalCpus: 4, cgroupVersion: '1' })).cpu, .5);
  assert.ok(h.calls.findIndex(c => c[0] === 'group') > h.calls.findLastIndex(c => c[0] === 'update'));
  h.calls.length = 0; h.settings.cpuTotal = 3;
  assert.equal((await h.budget({ totalCpus: 4, cgroupVersion: '1' })).cpu, 1);
  assert.ok(h.calls.findIndex(c => c[0] === 'group') < h.calls.findIndex(c => c[0] === 'update'));
});

test('lost Docker acknowledgements are reinspected, backed off, and never stop existing sessions', async () => {
  for (const options of [{ loseAcknowledgement: true }, { rejectUpdate: true }, { inspectError: true }]) {
    const h = fixture([.75], options);
    assert.equal((await h.budget({totalCpus:4})).cpu, 0);
    const count = h.calls.filter(c=>c[0]!=='group').length; assert.equal((await h.budget({totalCpus:4})).cpu, 0); assert.equal(h.calls.filter(c=>c[0]!=='group').length, count);
    assert.equal(h.rows[0].state, 'running');
    if (!options.rejectUpdate && !options.inspectError) {
      h.advance(); assert.equal((await h.budget({totalCpus:4})).cpu, 1);
      assert.equal(h.calls.filter(c => c[0] === 'update').length, 1);
    }
  }
});

test('unavailable parent CPU protection blocks new admission and does not touch existing browsers', async () => {
  const h = fixture([1], { groupError: 'missing cgroup mount' });
  const result = await h.budget({totalCpus:4}); assert.equal(result.cpu, 0); assert.match(result.message, /cgroup/); assert.deepEqual(h.calls, [['group']]);
});

test('memory and isolation failures still block admission before CPU operations', async () => {
  const startBody = source.slice(source.indexOf('async function startBudget('), source.indexOf('\nlet processing'));
  const budget = vm.runInNewContext(`(${startBody})`, {
    growthReserve: async () => 0, readResources: async () => ({ totalMb: 8192, availableMb: 1, reservedMb: 2048, totalCpus: 4 }),
    settings: { memoryMb: 1024 }, tgMemoryBudget, cpuBudget: async () => assert.fail('CPU operation after insufficient memory'),
  });
  assert.match((await budget()).message, /内存预算不足/);
});

async function groupFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-cpu-group-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const namespace = '123456abcdef', info = { totalCpus: 4, cgroupDriver: options.driver || 'cgroupfs', cgroupVersion: options.version || '2' };
  const parent = info.cgroupDriver === 'systemd' ? 'nurosshtg123456abcdef.slice' : '/nurossh-tg-123456abcdef';
  const base = info.cgroupVersion === '1' ? path.join(root, 'cpu,cpuacct') : root;
  const directory = path.join(base, parent.replace(/^\//, ''));
  let container = null, at = 100000;
  const calls = [];
  const docker = async (method, url, input) => {
    calls.push([method, url, input]);
    if (method === 'GET') { if (!container) throw Object.assign(Error('missing'), { dockerStatus: 404 }); return structuredClone(container); }
    if (url.startsWith('/containers/create')) {
      container = { Id: 'anchor', Config: { Labels: input.Labels }, HostConfig: input.HostConfig, State: { Running: false }, Mounts: [{ Source: '/example/profiles', Destination: '/ownership', RW: false }] };
      assert.equal(input.HostConfig.NetworkMode, 'none'); assert.equal(input.HostConfig.Memory, 16 * 1024 ** 2); assert.equal(input.HostConfig.CgroupParent, parent);
      return { Id: 'anchor' };
    }
    if (method === 'DELETE') { container = null; return {}; }
    if (url.endsWith('/start')) {
      container.State.Running = true;
      await fs.mkdir(directory, { recursive: true });
      if (info.cgroupVersion === '2') await fs.writeFile(path.join(directory, 'cpu.max'), 'max 100000');
      else { await fs.writeFile(path.join(directory, 'cpu.cfs_quota_us'), '-1'); await fs.writeFile(path.join(directory, 'cpu.cfs_period_us'), '100000'); }
      if (options.symlink) { await fs.rename(directory, directory + '-outside'); await fs.symlink(directory + '-outside', directory); }
      return {};
    }
    assert.fail('unexpected Docker request');
  };
  const group = createTgCpuGroup({ docker, root, now: () => at });
  const config = { namespace, hostProfiles: '/example/profiles', image: 'local:runner', mounted: !options.missingMount };
  group.configure(config);
  return { group, info, calls, directory, config, container: () => container, advance: ms => { at += ms; } };
}

for (const driver of ['systemd', 'cgroupfs']) for (const version of ['1', '2']) {
  test(`${driver}/cgroup v${version}: parent quota, settings update, reuse and owner-safe release`, async t => {
    const h = await groupFixture(t, { driver, version });
    const first = await h.group.ensure(h.info, { cpuTotal: 0 });
    assert.equal(first.ready, true, first.error); assert.equal(first.total, 3); assert.ok(h.group.includes(first.parent));
    const file = path.join(h.directory, version === '2' ? 'cpu.max' : 'cpu.cfs_quota_us');
    assert.equal((await fs.readFile(file, 'utf8')).trim(), version === '2' ? '300000 100000' : '300000');
    const count = h.calls.length;
    await h.group.ensure(h.info, { cpuTotal: 0 }); assert.equal(h.calls.length, count);
    assert.equal((await h.group.ensure(h.info, { cpuTotal: 2 })).total, 2);
    assert.equal(h.calls.filter(c => c[1].startsWith('/containers/create')).length, 1);
    h.container().Config.Labels['nurossh.tg.owner'] = 'foreign';
    await assert.rejects(h.group.release(), /归属/); assert.ok(h.container());
    h.container().Config.Labels['nurossh.tg.owner'] = h.config.namespace;
    await h.group.release(); assert.equal(h.container(), null);
  });
}

test('a stale parent quota is rechecked before admission and periodic checks are cached', async t => {
  const h = await groupFixture(t);
  await h.group.ensure(h.info, { cpuTotal: 0 });
  await fs.writeFile(path.join(h.directory, 'cpu.max'), 'max 100000');
  await h.group.ensure(h.info, { cpuTotal: 0 }, true);
  assert.equal(await fs.readFile(path.join(h.directory, 'cpu.max'), 'utf8'), '300000 100000');
});

test('missing mounts, unsupported controllers, ownership substitution and symlinks fail closed with bounded retries', async t => {
  for (const options of [{ missingMount: true }, { driver: 'unsupported' }, { symlink: true }]) {
    const h = await groupFixture(t, options);
    const status = await h.group.ensure(h.info, { cpuTotal: 0 }); assert.equal(status.ready, false); assert.ok(status.error);
    const count = h.calls.length; await h.group.ensure(h.info, { cpuTotal: 0 }); assert.equal(h.calls.length, count);
  }
});
