import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProfile, cleanProfileCaches, createProfileStorage, createCacheMaintenance } from '../shared/tg-profile-storage.js';
import { tgRuntimeAccount } from '../shared/tg-hosting.js';

const GiB = 1024 ** 3;
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function file(root, name, content) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), content);
}
test('usage counts caches separately and never follows session/external symlinks', async t => {
  const root = await directory(t);
  await file(root, 'Default/IndexedDB/session', 'saved-login');
  await file(root, 'Default/Cache/data', 'cached-media');
  await fs.symlink('/tmp/nonexistent-tg-socket', path.join(root, 'SingletonSocket'));
  await file(root, '.tg-snapshot-abcdef.tar.gz', 'transient snapshot');
  const result = await scanProfile(root);
  assert.equal(result.bytes, 23); assert.equal(result.cacheBytes, 12);
  assert.equal((await scanProfile(root, { excludeCaches: true })).bytes, 11);
  await fs.symlink('/etc', path.join(root, 'external'));
  await assert.rejects(scanProfile(root), /符号链接/);
});
test('cleanup removes only known caches and retains IndexedDB, cookies, local storage and sessions', async t => {
  const root = await directory(t);
  const kept = ['Default/IndexedDB/https_web.telegram.org_0.indexeddb.leveldb/session', 'Default/Local Storage/leveldb/session', 'Default/Sessions/tab', 'Default/Network/Cookies', 'Default/Service Worker/CacheStorage/session', 'Default/IndexedDB/Cache/important'];
  for (const name of kept) await file(root, name, name);
  await file(root, 'Default/Code Cache/js/cached', 'rebuildable');
  await file(root, 'GPUCache/data', 'rebuildable');
  await cleanProfileCaches(root);
  for (const name of kept) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), name);
  await assert.rejects(fs.stat(path.join(root, 'Default/Code Cache')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'GPUCache')), { code: 'ENOENT' });
});
test('cache ancestor symlinks cannot remove files in another account', async t => {
  const base = await directory(t), root = path.join(base, 'profile'), other = path.join(base, 'other');
  await fs.mkdir(root); await file(other, 'Cache/session', 'other account');
  await fs.symlink(other, path.join(root, 'Default'));
  await assert.rejects(cleanProfileCaches(root), /目录类型/);
  assert.equal(await fs.readFile(path.join(other, 'Cache/session'), 'utf8'), 'other account');
});
test('bounded scans stop at the file count limit and return zero for unopened accounts', async t => {
  const root = await directory(t);
  assert.deepEqual(await scanProfile(path.join(root, 'unopened')), { bytes: 0, cacheBytes: 0, files: 0, filesExceeded: false });
  for (let i = 0; i < 5; i++) await file(root, `file-${i}`, 'x');
  const result = await scanProfile(root, { maxFiles: 3 });
  assert.equal(result.filesExceeded, true); assert.ok(result.bytes <= 3);
});
function fixture(options = {}) {
  let time = 1800000000000, limit = 5 * GiB, locked = false, scans = 0;
  const row = { id: 'account', state: 'running', desired: true, containerPresent: true }, rows = new Map([[row.id, row]]), actions = [];
  let usage = options.usage || { bytes: 6 * GiB, cacheBytes: 2 * GiB, files: 100, filesExceeded: false };
  const metadata = new Map();
  const maintenance = options.maintenance || {
    read: async id => metadata.get(id), write: async (id, value) => metadata.set(id, value), forget: async id => metadata.delete(id),
  };
  const monitor = createProfileStorage({ rows, profiles: '/fixture/profiles', snapshots: '/fixture/snapshots', getLimit: () => limit,
    maintenance, canClean: options.canClean,
    now: () => time, blocked: () => locked, exclusive: async fn => fn(),
    stop: async () => { actions.push('stop'); if (options.stopError) throw Error('stop failed'); row.containerPresent = false; row.state = 'stopped'; row.uncleanStop = options.unclean; },
    scan: async () => { scans++; return options.scan ? options.scan() : { ...usage }; },
    clean: async () => { actions.push('clean'); if (options.cleanError) throw Error('cleanup failed'); usage.bytes -= usage.cacheBytes; usage.cacheBytes = 0; },
  });
  return { monitor, row, rows, actions, metadata, get scans() { return scans; }, advance: ms => { time += ms; }, setLimit: value => { limit = value; row.storageScanAfter = 0; }, setLock: value => { locked = value; } };
}
test('over-limit account stops before cleanup and resumes with the same desired intent', async () => {
  const h = fixture(); await h.monitor.tick();
  assert.deepEqual(h.actions, ['stop', 'clean']); assert.equal(h.row.storageBytes, 4 * GiB);
  assert.equal(h.row.state, 'queued'); assert.equal(h.row.storageBlocked, false); assert.equal(h.row.desired, true);
  assert.equal(h.row.storageMaintaining, false);
});
test('non-cache data above quota stays paused without an automatic restart loop; larger quota releases it', async () => {
  const h = fixture({ usage: { bytes: 6 * GiB, cacheBytes: 0, files: 1 } });
  await h.monitor.tick(); assert.equal(h.row.state, 'error'); assert.equal(h.row.storageBlocked, true);
  assert.equal(h.row.storageBytes, 6 * GiB); assert.equal(h.row.desired, true);
  for (let i = 0; i < 10; i++) await h.monitor.tick(); assert.equal(h.scans, 2);
  h.setLimit(8 * GiB); await h.monitor.tick();
  assert.equal(h.row.state, 'queued'); assert.equal(h.row.storageBlocked, false); assert.equal(h.row.error, '');
});
test('unusable cleanup or unclean browser exit never resumes or discards session files', async () => {
  for (const options of [{ unclean: true }, { cleanError: true }]) {
    const h = fixture(options); await h.monitor.tick();
    assert.equal(h.row.state, 'error'); assert.equal(h.row.storageBlocked, true);
    assert.ok(h.row.storageError); if (options.unclean) assert.deepEqual(h.actions, ['stop']);
  }
  const h = fixture({ stopError: true }); await h.monitor.tick();
  assert.equal(h.row.state, 'running'); assert.deepEqual(h.actions, ['stop']);
});
test('only large near-limit caches trigger a pause and repeated cleanup is rate limited', async () => {
  const h = fixture({ usage: { bytes: 4.5 * GiB, cacheBytes: .2 * GiB, files: 1 } });
  await h.monitor.tick(); assert.deepEqual(h.actions, ['stop', 'clean']);
  h.row.state = 'running'; h.row.containerPresent = true; h.advance(5 * 60000);
  await h.monitor.tick(); assert.deepEqual(h.actions, ['stop', 'clean']);
  const small = fixture({ usage: { bytes: 4.9 * GiB, cacheBytes: 1024, files: 1 } });
  await small.monitor.tick(); assert.deepEqual(small.actions, []);
});
test('slow scans are coalesced, remain outside mutation locks and cannot clean a deleted account', async () => {
  let resolve; const waiting = new Promise(r => { resolve = r; });
  const h = fixture({ scan: () => waiting });
  const tick = h.monitor.tick(); const usage = h.monitor.usage(h.row);
  await h.monitor.tick(); await new Promise(setImmediate); assert.equal(h.scans, 1); assert.deepEqual(h.actions, []);
  h.rows.delete(h.row.id); resolve({ bytes: 6 * GiB, cacheBytes: 2 * GiB, files: 1 });
  await Promise.all([tick, usage]); assert.deepEqual(h.actions, []);
});
test('a backup acquired during a scan postpones cleanup; active accounts take priority over dormant ones', async () => {
  let resolve; const waiting = new Promise(r => { resolve = r; });
  const h = fixture({ scan: () => waiting }); const tick = h.monitor.tick();
  h.setLock(true); resolve({ bytes: 6 * GiB, cacheBytes: GiB, files: 1 }); await tick; assert.deepEqual(h.actions, []);
  const priority = fixture({ usage: { bytes: 100, cacheBytes: 0, files: 1 } });
  priority.rows.delete(priority.row.id); priority.rows.set('sleep', { id: 'sleep', state: 'stopped' }); priority.rows.set(priority.row.id, priority.row);
  await priority.monitor.tick(); assert.equal(priority.row.storageBytes, 100); assert.equal(priority.rows.get('sleep').storageBytes, undefined);
});
test('startup checks enforce quota but never clean a currently running browser', async () => {
  const h = fixture(); await assert.rejects(h.monitor.prepare(h.row, { cleanAllowed: false }), error => error.storageBlocked === true);
  assert.deepEqual(h.actions, []); assert.equal(h.row.storageBlocked, true);
  const stopped = fixture(); await stopped.monitor.prepare(stopped.row);
  assert.deepEqual(stopped.actions, ['clean']); assert.equal(stopped.row.storageBytes, 4 * GiB);
});
test('usage metadata is small and exposes neither filesystem paths nor internal scheduling state', () => {
  const value = tgRuntimeAccount({ id: 'account', state: 'running', storageBytes: 0, snapshotBytes: 0, storageCheckedAt: 'now', storageBlocked: true, storageMaintaining: true, storageError: 'x'.repeat(1000), storageScanAfter: 100, storageCleanedAt: 100 });
  assert.equal(value.storageBytes, 0); assert.equal(value.snapshotBytes, 0); assert.equal(value.storageError.length, 160);
  assert.equal(value.storageScanAfter, undefined); assert.equal(value.storageCleanedAt, undefined);
});

test('failed recheck after cache cleanup stays paused and can recover on the next scan', async () => {
  let calls = 0;
  const h = fixture({ scan: async () => { if (++calls === 2) throw Object.assign(Error('unavailable'), {code:'EIO'}); return { bytes: calls === 1 ? 6 * GiB : GiB, cacheBytes: calls === 1 ? GiB : 0, files: 1 }; } });
  await h.monitor.tick(); assert.equal(h.row.state, 'error'); assert.equal(h.row.storageBlocked, true); assert.match(h.row.storageError, /EIO/);
  h.advance(60001); await h.monitor.tick(); assert.equal(h.row.state, 'queued'); assert.equal(h.row.storageBlocked, false);
});

test('ten thousand storage status rows stay within the shared transport budget', () => {
  const value = tgRuntimeAccount({id:'11111111-1111-4111-8111-111111111111',state:'error',pending:'snapshot',storageBytes:20*GiB,snapshotBytes:20*GiB,storageCheckedAt:Date.now(),storageBlocked:true,storageError:'错误'.repeat(1000),error:'错误'.repeat(1000),retryAt:Date.now(),startedAt:new Date().toISOString(),snapshotAt:new Date().toISOString(),memoryMb:8192,cpu:4,viewers:1});
  assert.equal(value.storageError,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify({accounts:Array(10000).fill(value)}))<8*1024**2);
});

test('actual runner startup retains reservations when an over-limit browser cannot be confirmed stopped', async () => {
  const { default: vm } = await import('node:vm');
  const source = await fs.readFile(new URL('../tg-hosting/runner.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function start('), source.indexOf('\nfunction probeVnc('));
  for (const stopFails of [true, false]) {
    const row = { id: 'account', desired: true, state: 'queued', memoryMb: 1024, cpu: 1 }, rows = new Map([[row.id, row]]);
    const start = vm.runInNewContext(`(${body})`, { rows, assertImage: async () => {}, restoreProfile: async () => {},
      inspect: async () => ({State:{Running:true}}), storage: {prepare: async () => { throw Object.assign(Error('quota exceeded'),{storageBlocked:true}); }},
      stop: async () => { if (stopFails) throw Error('Docker unavailable'); },
    });
    await start(row.id, 1, 1024);
    assert.equal(row.storageBlocked, true);
    assert.equal(row.state, stopFails ? 'running' : 'error');
    assert.equal(row.memoryMb, 1024); assert.equal(row.cpu, 1);
    if (stopFails) assert.match(row.error, /保留资源名额/);
  }
});

test('slow scans cannot starve later running accounts whose storage has never been checked', async () => {
  const h = fixture({usage:{bytes:100,cacheBytes:0,files:1}});
  h.rows.delete(h.row.id);
  const overdue = {id:'overdue',state:'running',desired:true,storageScanAfter:1700000000000};
  h.rows.set(overdue.id,overdue); h.rows.set(h.row.id,h.row);
  await h.monitor.tick();
  assert.equal(h.row.storageBytes,100); assert.equal(overdue.storageBytes,undefined);
  await h.monitor.tick(); assert.equal(overdue.storageBytes,100);
});

test('daily cleanup works below quota, defers attached viewers and does not wake sleeping accounts', async () => {
  for (const sleeping of [false, true]) {
    const h = fixture({usage:{bytes:GiB,cacheBytes:1024,files:1}});
    if (sleeping) { h.row.state = 'stopped'; h.row.desired = false; h.row.containerPresent = false; }
    await h.monitor.tick(); assert.deepEqual(h.actions, []);
    h.advance(24 * 60 * 60000); h.row.viewers = 1;
    await h.monitor.tick(); assert.deepEqual(h.actions, []);
    h.row.viewers = 0; h.advance(30 * 60000);
    await h.monitor.tick(); assert.deepEqual(h.actions, sleeping ? ['clean'] : ['stop','clean']);
    assert.equal(h.row.state, sleeping ? 'stopped' : 'queued');
    assert.equal(h.metadata.get('account').cleanedAt, h.row.storageCleanedAt);
    h.advance(30 * 60000); await h.monitor.tick();
    assert.deepEqual(h.actions, sleeping ? ['clean'] : ['stop','clean']);
  }
});

test('daily maintenance without disposable caches never stops the browser; quota still overrides a viewer', async () => {
  const h = fixture({usage:{bytes:GiB,cacheBytes:0,files:1}});
  await h.monitor.tick(); h.advance(24 * 60 * 60000);
  await h.monitor.tick(); assert.deepEqual(h.actions, []);
  assert.equal(h.row.storageCleanedAt, undefined);
  assert.equal(h.row.storageDailyAt, h.row.storageCheckedAt);
  const full = fixture(); full.row.viewers = 1; await full.monitor.tick();
  assert.deepEqual(full.actions, ['stop','clean']);
});

test('a viewer attached while waiting for the mutation lock postpones daily maintenance', async () => {
  const h = fixture({usage:{bytes:GiB,cacheBytes:1024,files:1}});
  // A scan can outlive a viewer attachment. Check the viewer again inside lock.
  h.row.storageDailyAt = 1700000000000; h.row.storageMaintenanceLoaded = true;
  let result;
  const monitor = createProfileStorage({rows:h.rows, profiles:'/fixture/profiles', snapshots:'/fixture/snapshots',
    getLimit:()=>5*GiB, blocked:()=>false, now:()=>1800000000000,
    exclusive:async fn=>{h.row.viewers=1;return fn();},
    stop:async()=>assert.fail('must not stop attached viewer'), clean:async()=>assert.fail('must not clean'),
    scan:async()=>result={bytes:GiB,cacheBytes:1024,files:1},
  });
  await monitor.tick(); assert.ok(result); assert.equal(h.row.state,'running');
});

test('unclean persistent activity markers prohibit startup and daily cleanup even without a container', async () => {
  const h = fixture({usage:{bytes:GiB,cacheBytes:1024,files:1},canClean:()=>false});
  h.row.state='stopped'; h.row.containerPresent=false;
  await h.monitor.prepare(h.row); assert.deepEqual(h.actions,[]);
  h.advance(24*60*60000); await h.monitor.tick();
  assert.deepEqual(h.actions,[]); assert.equal(h.row.storageBlocked,false);
  assert.equal(h.row.state,'queued');
  assert.match(h.row.storageError,/未正常退出/);
});

test('failed optional maintenance preserves profiles and resumes keep accounts without blocking sleeping accounts', async () => {
  for (const failure of [{unclean:true}, {cleanError:true}]) for (const desired of [true, false]) {
    const h = fixture({...failure, usage:{bytes:174 * 1024 ** 2,cacheBytes:64 * 1024 ** 2,files:10}});
    if (!desired) { h.row.desired = false; h.row.state = 'stopped'; h.row.containerPresent = false; h.row.uncleanStop = failure.unclean; }
    await h.monitor.tick(); h.advance(24 * 60 * 60000); await h.monitor.tick();
    assert.equal(h.row.storageBlocked, false);
    assert.equal(h.row.state, desired ? 'queued' : 'stopped');
    assert.equal(h.row.error, ''); assert.ok(h.row.storageError);
    assert.equal(h.row.storageCleanedAt, undefined);
    const actions = [...h.actions];
    if (failure.unclean) assert.ok(!actions.includes('clean'));
    if (desired) { h.row.state = 'running'; h.row.containerPresent = true; }
    h.advance(5 * 60000); await h.monitor.tick();
    await h.monitor.prepare(h.row);
    assert.deepEqual(h.actions, actions, 'tick and startup both defer failed housekeeping');
    // A real quota violation must still be enforced during the cooldown.
    h.setLimit(100 * 1024 ** 2); await h.monitor.tick();
    assert.equal(h.row.storageBlocked, true); assert.equal(h.row.state, 'error');
  }
});

test('legacy cleanup holds below quota recover even when daily maintenance is overdue', async () => {
  for (const desired of [true, false]) {
    const h = fixture({canClean:()=>false,usage:{bytes:176 * 1024 ** 2,cacheBytes:1024,files:10}});
    await h.monitor.tick(); h.advance(24 * 60 * 60000);
    Object.assign(h.row, {desired,state:'error',containerPresent:false,storageBlocked:true,error:'旧的清理异常'});
    await h.monitor.tick();
    assert.equal(h.row.storageBlocked, false); assert.equal(h.row.error, '');
    assert.equal(h.row.state, desired ? 'queued' : 'stopped');
    assert.deepEqual(h.actions, [], 'recover the hold without touching caches or session files');
  }
});

test('persistent daily timestamps survive runner recreation and reject links without touching targets', async t => {
  const root = await directory(t), maintenance=createCacheMaintenance(root);
  const h=fixture({usage:{bytes:GiB,cacheBytes:1024,files:1},maintenance});
  await h.monitor.tick(); const first=await maintenance.read('account');
  assert.ok(first.checkedAt<=h.row.storageCheckedAt && first.cleanedAt===0);
  assert.equal((await fs.stat(path.join(root,'.cache-cleaned-account'))).mode&0o777,0o600);
  const restarted=fixture({usage:{bytes:GiB,cacheBytes:1024,files:1},maintenance});
  await restarted.monitor.tick(); assert.deepEqual(await maintenance.read('account'),first);
  restarted.advance(24*60*60000); await restarted.monitor.tick();
  assert.deepEqual(restarted.actions,['stop','clean']);
  assert.ok((await maintenance.read('account')).cleanedAt>first.checkedAt);
  const again=fixture({usage:{bytes:GiB,cacheBytes:1024,files:1},maintenance});
  again.advance(24*60*60000+1000); await again.monitor.tick(); assert.deepEqual(again.actions,[]);
  await file(root,'session','secret'); await fs.symlink(path.join(root,'session'),path.join(root,'.cache-cleaned-other'));
  await assert.rejects(maintenance.read('other'));
  await maintenance.write('other',{checkedAt:123,cleanedAt:0});
  assert.equal(await fs.readFile(path.join(root,'session'),'utf8'),'secret');
  await restarted.monitor.forget('account'); assert.equal(await maintenance.read('account'),null);
  assert.ok(!(await fs.readdir(root)).some(name=>name.endsWith('.tmp')));
});

test('maintenance timestamp I/O failures never bypass quota or discard login data', async () => {
  const h=fixture({maintenance:{read:async()=>{throw Error('EIO');},write:async()=>{throw Error('EIO');}}});
  await h.monitor.tick(); assert.deepEqual(h.actions,['stop','clean']); assert.equal(h.row.state,'queued');
  assert.match(h.row.storageError,/维护时间暂未保存/);
});

test('a bogus FIFO maintenance marker fails promptly without blocking storage scans', async t => {
  const {execFileSync}=await import('node:child_process');
  const root=await directory(t);
  execFileSync('mkfifo',[path.join(root,'.cache-cleaned-account')]);
  await assert.rejects(createCacheMaintenance(root).read('account'),/时间文件无效/);
});

test('browser shutdown reports unsuccessful Chromium flush as unclean even when other processes exit normally', async () => {
  const {default:vm}=await import('node:vm');
  const {EventEmitter}=await import('node:events');
  const source=await fs.readFile(new URL('../tg-hosting/browser.mjs',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('const children'),source.indexOf("process.on('SIGTERM'"));
  for(const [exitCode,signal,expected] of [[0,null,0],[1,null,75],[null,'SIGTERM',75]]){
    let poll,actual;
    vm.runInNewContext(body+"launch('display',[]);chromium=launch('chromium',[]);stop();",{
      spawn:command=>{const child=new EventEmitter();child.stderr={resume(){}};child.kill=()=>child.emit('exit',command==='chromium'?exitCode:0,command==='chromium'?signal:null);return child;},
      setInterval:fn=>{poll=fn;return 1;},clearInterval(){},setTimeout:()=>({unref(){}}),process:{exit:code=>{actual=code;}},
    });
    poll();assert.equal(actual,expected);
  }
});

test('browser shutdown requests a graceful close, waits for actual exit and escalates only when necessary', async () => {
  const {default:vm} = await import('node:vm');
  const {EventEmitter} = await import('node:events');
  const source = await fs.readFile(new URL('../tg-hosting/browser.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const children'), source.indexOf("process.on('SIGTERM'"));
  for (const scenario of ['clean', 'nonzero', 'stalled', 'pipe-error', 'pipe-throw']) {
    const children = new Map(), events = [], timers = new Map(); let poll, actual;
    vm.runInNewContext(body + "launch('display',[]);chromium=launch('chromium',[],true);stop();stop();", {
      spawn: command => {
        const child = new EventEmitter(); children.set(command, child); child.stderr = {resume(){}};
        child.kill = signal => {
          events.push(`${command}:${signal}`);
          if (command !== 'chromium') child.emit('exit', 0, null);
          else if (signal === 'SIGKILL' || scenario.startsWith('pipe-')) child.emit('exit', null, signal);
        };
        const pipe = new EventEmitter(); pipe.writable = true;
        pipe.write = (value, callback) => {
          assert.equal(value.at(-1), '\0');
          assert.deepEqual(JSON.parse(value.slice(0,-1)), {id:0,method:'Browser.close'});
          events.push('Browser.close');
          if (scenario === 'pipe-throw') throw Error('broken pipe');
          callback(scenario === 'pipe-error' ? Error('broken pipe') : null);
          if (scenario === 'pipe-error') pipe.emit('error', Error('broken pipe'));
        };
        child.stdio = [null,null,null,pipe];
        return child;
      },
      setInterval:fn=>{poll=fn;return 1;},clearInterval(){},
      setTimeout:(fn,ms)=>{timers.set(ms,fn);return {unref(){}};},process:{exit:code=>{actual=code;}},
    });
    assert.equal(events.filter(value => value === 'Browser.close').length, 1, 'repeated shutdown is idempotent');
    if (!scenario.startsWith('pipe-')) {
      assert.deepEqual(events, ['Browser.close']); poll(); assert.equal(actual, undefined, 'a close request alone cannot approve a snapshot');
      if (scenario === 'stalled') {
        timers.get(12000)(); assert.deepEqual(events, ['Browser.close','chromium:SIGTERM']);
        poll(); assert.equal(actual, undefined);
        timers.get(18000)();
      } else children.get('chromium').emit('exit', scenario === 'clean' ? 0 : 1, null);
    }
    poll(); assert.equal(actual, scenario === 'clean' ? 0 : 75);
    assert.equal(events.at(-1), 'display:SIGTERM', 'keep the display alive until Chromium exits');
    assert.ok(timers.has(22000), 'final deadline fits within the Docker stop timeout');
  }
});

test('actual runner keeps the persistent activity marker when Docker still reports a running browser', async () => {
  const {default:vm}=await import('node:vm');
  const source=await fs.readFile(new URL('../tg-hosting/runner.mjs',import.meta.url),'utf8');
  let removed=false;
  const stop=vm.runInNewContext(`(${source.slice(source.indexOf('async function stop('),source.indexOf('\nasync function removeNetwork('))})`,{
    rows:new Map([['account',{}]]),memorySamples:new Map(), inspect:async()=>({Id:'container',State:{Running:true,ExitCode:0,StartedAt:'2026-11-09T00:00:00Z'}}),
    docker:async()=>{}, fail:message=>{throw Error(message);},fsp:{rm:async()=>{removed=true;}},
  });
  await assert.rejects(stop('account'),/无法确认浏览器/); assert.equal(removed,false);
});

test('backup cache cleanup requires confirmed clean stop, preserves sessions and avoids another full directory scan', async t => {
  const root=await directory(t),profiles=path.join(root,'profiles'),snapshots=path.join(root,'snapshots');
  const row={id:'account',containerPresent:true},rows=new Map([[row.id,row]]);
  await fs.mkdir(snapshots);await file(profiles,'account/Default/Cache/disposable','cache');
  await file(profiles,'account/Default/IndexedDB/session','login-proof');
  const monitor=createProfileStorage({rows,profiles,snapshots,getLimit:()=>5*GiB,exclusive:async fn=>fn(),blocked:()=>false,stop:async()=>{},scan:async()=>assert.fail('checkpoint measures retained files separately')});
  await assert.rejects(monitor.cleanStopped(row),/未确认正常停止/);
  row.containerPresent=false;row.uncleanStop=true;
  await assert.rejects(monitor.cleanStopped(row),/未确认正常停止/);
  assert.equal(await fs.readFile(path.join(profiles,'account/Default/Cache/disposable'),'utf8'),'cache');
  row.uncleanStop=false;await monitor.cleanStopped(row);
  assert.equal(await fs.readFile(path.join(profiles,'account/Default/IndexedDB/session'),'utf8'),'login-proof');
  await assert.rejects(fs.stat(path.join(profiles,'account/Default/Cache')),{code:'ENOENT'});
  assert.ok((await createCacheMaintenance(profiles).read('account')).cleanedAt>0);
});
