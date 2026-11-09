import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { advanceTgLogin, tgLoginStatus, TG_LOGIN_EXPRESSION } from '../shared/tg-login-state.js';
import { tgRuntimeAccount } from '../shared/tg-hosting.js';
import { createLoginProbe, readLoginFile } from '../shared/tg-login-monitor.js';
import { protectBrowserVersion } from '../tg-hosting/browser-version.mjs';

test('a login page needs three consecutive confirmations; offline/loading never means logged out', () => {
  let row = advanceTgLogin({}, 'authenticated', 1);
  assert.equal(row.state, 'authenticated');
  row = advanceTgLogin(row, 'login', 2); assert.equal(row.state, 'unknown');
  row = advanceTgLogin(row, 'login', 3); assert.equal(row.state, 'unknown');
  row = advanceTgLogin(row, 'unknown', 4); assert.equal(row.confirmations, 0);
  for (let i = 0; i < 3; i++) row = advanceTgLogin(row, 'login', 5 + i);
  assert.equal(row.state, 'attention'); assert.equal(row.everAuthenticated, true);
  assert.equal(advanceTgLogin(row, 'authenticated', 8).state, 'authenticated');
  row = {}; for (let i = 0; i < 3; i++) row = advanceTgLogin(row, 'login', i);
  assert.equal(row.state, 'login');
});
test('DOM checks return only enums and ignore foreign pages, partial render, hidden auth and offline', () => {
  const check = ({ origin = 'https://web.telegram.org', pathname = '/a/', online = true, ready = 'complete', main = false, auth = false, hidden = false } = {}) => vm.runInNewContext(TG_LOGIN_EXPRESSION, {
    location: { origin, pathname }, navigator: { onLine: online }, getComputedStyle: () => ({ display: hidden ? 'none' : 'block', visibility: 'visible' }),
    document: { readyState: ready, querySelector: selector => (selector === '#Main' ? main : auth) ? { getBoundingClientRect: () => ({ width: 100, height: 100 }) } : null },
  });
  assert.equal(check({ main: true }), 'authenticated'); assert.equal(check({ auth: true }), 'login');
  for (const options of [{}, { main: true, auth: true }, { auth: true, hidden: true }, { main: true, online: false }, { auth: true, ready: 'loading' }, { origin: 'https://evil.test', main: true }, { pathname: '/k/', main: true }]) assert.equal(check(options), 'unknown');
});
test('restored/stale statuses cannot masquerade as the current running browser and secrets never reach runtime', () => {
  const now = Date.now(), status = { version: 1, token: 'current', checkedAt: now, state: 'authenticated', everAuthenticated: true };
  assert.equal(tgLoginStatus(status, 'current', now).loginState, 'authenticated');
  for (const value of [{ ...status, token: 'old' }, { ...status, checkedAt: now - 13 * 60000 }, { ...status, checkedAt: now + 60000 }, { ...status, state: 'unexpected' }]) assert.equal(tgLoginStatus(value, 'current', now).loginState, 'unknown');
  assert.equal(tgLoginStatus(status, '', now).loginState, 'unknown');
  const row = tgRuntimeAccount({ id: 'account', state: 'running', monitorToken: 'secret', loginState: 'attention', loginCheckedAt: now, everAuthenticated: true });
  assert.equal(row.loginState, 'attention'); assert.equal(row.monitorToken, undefined); assert.equal(row.everAuthenticated, undefined);
  assert.equal(tgRuntimeAccount({ ...row, state: 'stopped' }).loginState, undefined);
});
test('the private probe attaches only to one official Web A page and always detaches; failures stay unknown', async () => {
  for (const scenario of ['healthy', 'auth', 'foreign', 'ambiguous', 'evaluate-failed']) {
    const input = new PassThrough(), output = new PassThrough(), calls = [];
    let buffer = '';
    input.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); calls.push(command);
        let result = {};
        if (command.method === 'Target.getTargets') result = { targetInfos: scenario === 'foreign' ? [{ type: 'page', url: 'https://evil.test/a/', targetId: 'bad' }] : Array.from({ length: scenario === 'ambiguous' ? 2 : 1 }, (_, i) => ({ type: 'page', url: 'https://web.telegram.org/a/', targetId: String(i) })) };
        if (command.method === 'Target.attachToTarget') result = { sessionId: 'private' };
        if (command.method === 'Runtime.evaluate') {
          assert.equal(command.params.expression, TG_LOGIN_EXPRESSION);
          result = { result: { value: scenario === 'auth' ? 'login' : 'authenticated' } };
        }
        const response = command.method === 'Runtime.evaluate' && scenario === 'evaluate-failed' ? { id: command.id, error: { message: 'ignored' } } : { id: command.id, result };
        queueMicrotask(() => { const bytes = Buffer.from(JSON.stringify(response) + '\0'); output.write(bytes.subarray(0, 7)); output.write(bytes.subarray(7)); });
      }
    });
    const probe = createLoginProbe(input, output);
    assert.equal(await probe.sample(), scenario === 'healthy' ? 'authenticated' : scenario === 'auth' ? 'login' : 'unknown');
    if (['foreign', 'ambiguous'].includes(scenario)) assert.deepEqual(calls.map(v => v.method), ['Target.getTargets']);
    else assert.equal(calls.at(-1).method, 'Target.detachFromTarget');
    probe.close(); input.destroy(); output.destroy();
  }
});
test('monitor files have bounded reads, do not follow links and tolerate unavailable browser status', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-login-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'status'); await fs.writeFile(file, JSON.stringify({ state: 'login' })); assert.equal((await readLoginFile(file)).state, 'login');
  await fs.symlink(file, path.join(root, 'link')); assert.equal(await readLoginFile(path.join(root, 'link')), null);
  await fs.writeFile(file, 'x'.repeat(2048)); assert.equal(await readLoginFile(file), null); assert.equal(await readLoginFile(root), null);
});
test('version guard blocks a downgraded browser before touching any saved login data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-version-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'session'), 'never-change-this-session');
  await protectBrowserVersion(root, 'Chromium 145.0.1.2');
  await assert.rejects(protectBrowserVersion(root, 'Chromium 144.0.1.2'), /browser-downgrade/);
  assert.equal(await fs.readFile(path.join(root, '.nurossh-browser-version'), 'utf8'), '145.0.0.0\n');
  await fs.writeFile(path.join(root, 'Last Version'), '146.0.2.1');
  await assert.rejects(protectBrowserVersion(root, 'Chromium 145.0.1.2'), /browser-downgrade/);
  await protectBrowserVersion(root, 'Chromium 146.0.2.1');
  assert.equal(await fs.readFile(path.join(root, 'session'), 'utf8'), 'never-change-this-session');
});

test('late attach/detach responses cannot accumulate debugger sessions after timeouts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new PassThrough(), output = new PassThrough(), calls = [];
  let buffer = '', attach, detach, hold = true;
  const reply = (id, result) => output.write(JSON.stringify({ id, result }) + '\0');
  input.on('data', chunk => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\0')) >= 0;) {
      const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); calls.push(command);
      if (command.method === 'Target.getTargets') reply(command.id, { targetInfos: [{ type: 'page', targetId: 'official', url: 'https://web.telegram.org/a/' }] });
      if (command.method === 'Target.attachToTarget') { attach = command; if (!hold) reply(command.id, { sessionId: 'current-session' }); }
      if (command.method === 'Target.detachFromTarget') { detach = command; if (!hold) reply(command.id, {}); }
      if (command.method === 'Runtime.evaluate') reply(command.id, { result: { value: 'authenticated' } });
    }
  });
  const probe = createLoginProbe(input, output);
  t.after(() => { probe.close(); input.destroy(); output.destroy(); });
  const first = probe.sample();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.ok(attach);
  t.mock.timers.tick(2501); assert.equal(await first, 'unknown');
  for (let i = 0; i < 50; i++) assert.equal(await probe.sample(), 'unknown');
  assert.equal(calls.length, 2, 'uncertain attach blocks new requests rather than leaking sessions');
  reply(attach.id, { sessionId: 'late-session' });
  assert.equal(detach.params.sessionId, 'late-session');
  t.mock.timers.tick(2501);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  for (let i = 0; i < 50; i++) assert.equal(await probe.sample(), 'unknown');
  assert.equal(calls.length, 3, 'uncertain detach also prevents more attachments');
  reply(detach.id, {}); hold = false;
  assert.equal(await probe.sample(), 'authenticated');
  assert.equal(calls.at(-1).method, 'Target.detachFromTarget');
});

test('all 50 running accounts receive fair monitor reads even with 10000 dormant accounts', async () => {
  const source = await fs.readFile(new URL('../tg-hosting/runner.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function readLoginStates('), source.indexOf('\nconst loginTimer ='));
  const rows = new Map(Array.from({ length: 10000 }, (_, i) => [`sleep-${i}`, { id: `sleep-${i}`, state: 'stopped' }]));
  const reads = new Map(); let now = 1000000;
  for (let i = 0; i < 50; i++) rows.set(`running-${i}`, { id: `running-${i}`, state: 'running', monitorToken: 'fixture', loginReadAt: 0 });
  const read = vm.runInNewContext(`(${body})`, {
    rows, loginReading: false, mutating: false, backupLease: null, closed: false, migrationHold: false, configured: true,
    Date: { now: () => now }, path, profiles: '/fixture', tgLoginStatus: () => ({ loginState: 'unknown' }),
    readLoginFile: async file => {
      const id = path.basename(path.dirname(file)); assert.ok(id.startsWith('running-'));
      reads.set(id, (reads.get(id) || 0) + 1);
      if (id === 'running-0') throw Error('one unavailable file must not starve other accounts');
      return null;
    },
  });
  for (let i = 0; i < 150; i++) { await read(); now += 2000; }
  assert.equal(reads.size, 50);
  assert.ok([...reads.values()].every(count => count === 3), 'one file per tick, fair repeated coverage of every running account');
});
