import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTgHostingService, registerTgHostingRoutes } from '../server/tg-hosting.js';
import { tgHostingSettings, tgHostingAccount, tgResumeOrder, tgResourceBlock, tgMemoryBudget, tgBrowserGrowthMb, tgRetryDelay, tgViewRetryDelay, tgDiskReserve, tgDiskNeedsParking, tgHostIsolationBlock, tgBrowserLimitError, tgContainerHealth, tgCrashAttempts } from '../shared/tg-hosting.js';

function fixture(t, custom = {}, options = {}) {
  const calls = [], db = new Database(':memory:');
  const runner = { enabled: true, request: async (method, url, body) => { calls.push({ method, url, body }); return url === '/status' ? { accounts: [] } : { ok: true, accepted: true }; }, ...custom };
  const service = createTgHostingService({ db, key: Buffer.alloc(32, 7), runner, ...options });
  t.after(() => { service.close(); db.close(); });
  return { service, runner, calls };
}
test('hosting validates resource bounds and preserves safe defaults', () => {
  assert.deepEqual(tgHostingSettings(), { maxRunning: 2, memoryMb: 1024, cpu: 1 });
  for (const input of [{maxRunning:0},{memoryMb:384},{memoryMb:1000},{cpu:0},{cpu:0.3}]) assert.throws(() => tgHostingSettings(input));
  assert.equal(tgHostingSettings({ memoryMb: 512 }).memoryMb, 512);
  assert.equal(tgHostingAccount({ name: ' A ' }).mode, 'keep');
  assert.throws(() => tgHostingAccount({ name: '' }));
  assert.throws(() => tgHostingAccount({ name: 'a', mode: 'invalid' }));
});
test('metadata does not start browsers; search is paged and revisions prevent lost edits', async t => {
  const {service,calls} = fixture(t);
  const first = await service.save({name:'Work',phone:'+861234567',group:'工作',note:'important'});
  assert.equal(calls.length,0);
  await assert.rejects(service.save({name:'work'}), /已存在/);
  await assert.rejects(service.save({name:'Other',phone:'+861234567'}), /已存在/);
  const updated = await service.save({...first,name:'New'},first.id);
  await assert.rejects(service.save({...first,name:'Stale'},first.id), /已更新/);
  assert.equal(updated.mode,'keep');
  for (let i=0;i<34;i++) await service.save({name:`Account ${i}`});
  const results = await service.snapshot({q:'Account',page:2});
  assert.equal(results.accounts.length,4); assert.equal(results.total,34);
  assert.equal((await service.snapshot({q:'important'})).accounts[0].id, first.id);
  assert.equal((await service.snapshot({page:'1.5'})).page,1);
});
test('failed runner deletion retains configuration and bulk confirmation freezes identifiers', async t => {
  const {service,runner} = fixture(t);
  const a = await service.save({name:'A'});
  await assert.rejects(service.remove([a.id],'wrong'), /确认/);
  runner.request = async () => { throw Error('unavailable'); };
  await assert.rejects(service.remove([a.id],'delete-tg-hosting'), /unavailable/);
  assert.equal(service.requireAccount(a.id).name,'A');
  runner.request = async () => ({ok:true});
  const ids = service.records().map(item=>item.id);
  const b = await service.save({name:'B'});
  await service.remove(ids,'delete-tg-hosting');
  assert.deepEqual(service.records().map(item=>item.id),[b.id]);
});
test('commands preserve edits made during runner I/O and serialize against deletion', async t => {
  const {service,runner} = fixture(t);
  const a = await service.save({name:'A'});
  await service.runtime(true);
  let proceed, entered;
  const waiting = new Promise(resolve => { entered=resolve; });
  runner.request = async (_method,url) => { if(url.endsWith('/wake')) {entered(); await new Promise(resolve=>{proceed=resolve;});} return {ok:true}; };
  const command=service.command(a.id,'wake'); await waiting;
  await service.save({...a,name:'Renamed'},a.id);
  const deletion=service.remove([a.id],'delete-tg-hosting');
  proceed(); await command; await deletion;
  assert.equal(service.records().length,0);
});

async function httpFixture(t) {
  const fixtureValue = fixture(t);
  let clock=1000000;
  const app=express(), sessionA={id:'a'}, sessionB={id:'b'};
  app.use(express.json());
  app.use((req,_res,next)=>{ req.auth=req.headers['x-session']==='b'?sessionB:sessionA; next(); });
  const routes=registerTgHostingRoutes(app,fixtureValue.service,async req=>{ if(req.body.password!=='fixture-password') throw Object.assign(Error('密码错误'),{statusCode:403}); },{sessionValid:()=>true,now:()=>clock});
  app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{routes.close();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const request=async (method,url,body,token,session='a')=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/tg-hosting${url}`,{method,headers:{'Content-Type':'application/json','X-Session':session,...(token?{'X-TG-Hosting-Unlock':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  return {...fixtureValue,request,routes,sessionA,advance:delta=>{clock+=delta;}};
}
test('unlock is bound to the login session, status polling does not prolong access, and lock revokes it', async t => {
  const {request,advance,service}=await httpFixture(t);
  assert.equal((await request('POST','/accounts',{name:'Denied'})).status,423);
  assert.equal((await request('POST','/unlock',{password:'wrong'})).status,403);
  const unlock=await request('POST','/unlock',{password:'fixture-password'}),token=unlock.body.token;
  const a=await request('POST','/accounts',{name:'Allowed'},token);
  assert.equal(a.status,201);
  assert.equal((await request('POST','/accounts',{name:'Denied'},token,'b')).status,423);
  const selection=await request('POST','/delete-selection',{},token);
  assert.deepEqual(selection.body.ids,[a.body.account.id]);
  advance(9*60000);
  assert.equal((await request('GET',`/accounts/${a.body.account.id}`,undefined,token)).status,200);
  advance(60001);
  assert.equal((await request('POST','/view',{id:a.body.account.id},token)).status,423);
  const second=(await request('POST','/unlock',{password:'fixture-password'})).body.token;
  await request('POST','/lock',{},second);
  assert.equal((await request('POST','/view',{id:a.body.account.id},second)).status,423);
  assert.equal(service.records().length,1);
});
test('closing a viewing socket never stops a keep account or triggers duplicate sleep on transport errors', async t => {
  const {request,service,routes,runner,sessionA}=await httpFixture(t);
  const a=await service.save({name:'Keep'}), token=(await request('POST','/unlock',{password:'fixture-password'})).body.token;
  const peer=new EventEmitter();peer.readyState=1;peer.bufferedAmount=0;peer.close=()=>{};
  const upstream=new EventEmitter();upstream.close=()=>{};upstream.bufferedAmount=0;
  runner.connect=()=>upstream;
  await service.command(a.id,'wake');
  routes.connect(peer,{headers:{'sec-websocket-protocol':`nurossh-v1, nurossh-tg.${token}`},url:`/ws/tg-hosting?id=${a.id}`,auth:sessionA},{authorized:()=>true});
  peer.emit('error',Error('synthetic transport interruption'));peer.emit('close');
  assert.equal(service.requireAccount(a.id).desired,true);
  assert.equal(service.records().length,1);
});
test('bulk deletion acknowledges immediately, reports progress and retains failed profiles',async t=>{
 const {service,runner}=fixture(t);const a=await service.save({name:'A'});let proceed,entered;const reached=new Promise(resolve=>{entered=resolve;});
 runner.request=async (_method,url)=>{if(url.startsWith('/accounts/')){entered();await new Promise(resolve=>{proceed=resolve;});throw Error('synthetic delete failure');}return url==='/status'?{accounts:[]}:{ok:true};};
 assert.equal(service.beginRemove([a.id],'delete-tg-hosting').accepted,true);await reached;
 const busy=await service.snapshot();assert.equal(busy.deletion.running,true);assert.equal(busy.deletion.total,1);assert.throws(()=>service.beginRemove([a.id],'delete-tg-hosting'),/正在处理/);
 proceed();await new Promise(resolve=>setImmediate(resolve));
 const finished=await service.snapshot();assert.equal(finished.deletion.running,false);assert.match(finished.deletion.error,/synthetic delete failure/);assert.equal(service.requireAccount(a.id).name,'A');
});
test('sleep mode reclaims orphaned browsers after a grace period, while keep mode survives restarts',async t=>{
 const {service,runner,routes,advance}=await httpFixture(t);
 const sleeping=await service.save({name:'Sleep',mode:'sleep'}),keep=await service.save({name:'Keep'});
 await service.command(sleeping.id,'wake');await service.command(keep.id,'wake');
 runner.request=async (_method,url)=>url==='/status'?{accounts:[{id:sleeping.id,state:'running'},{id:keep.id,state:'running'}]}:{ok:true};
 await service.runtime(true);await routes.checkIdle();advance(59999);await routes.checkIdle();assert.equal(service.requireAccount(sleeping.id).desired,true);
 advance(2);await routes.checkIdle();assert.equal(service.requireAccount(sleeping.id).desired,false);assert.equal(service.requireAccount(keep.id).desired,true);
});

test('resource checks fail closed, reserve disk space and retry with bounded backoff', () => {
  const good = {totalMb:8192,availableMb:6000,reservedMb:1024,diskLow:false};
  assert.equal(tgResourceBlock(good,1024),'');
  for (const item of [null,{}, {...good,totalMb:0},{...good,availableMb:NaN},{...good,reservedMb:undefined},{...good,error:'Docker unavailable'}]) assert.match(tgResourceBlock(item,1024),/暂停/);
  assert.match(tgResourceBlock({...good,diskLow:true},1024),/磁盘/);
  assert.match(tgResourceBlock({...good,availableMb:1200},1024),/内存/);
  assert.equal(tgRetryDelay(1),60000); assert.equal(tgRetryDelay(1,true),300000); assert.equal(tgRetryDelay(4),null);
  assert.equal(tgDiskReserve(10*1024**3),1024**3); assert.equal(tgDiskReserve(1000*1024**3),4*1024**3);
});
test('small hosts allocate a real lower hard limit while preserving system headroom', () => {
  const small = { totalMb: 1986, availableMb: 980, reservedMb: 0, diskLow: false };
  const budget = tgMemoryBudget(small, 1024);
  assert.equal(budget.memoryMb, 512);
  assert.equal(budget.reason, '');
  assert.ok(small.availableMb - budget.memoryMb >= budget.reserveMb);
  assert.equal(tgMemoryBudget({ ...small, availableMb: 1300 }, 1024).memoryMb, 896);
  assert.equal(tgMemoryBudget({ ...small, availableMb: 1800 }, 1024).memoryMb, 1024);
  assert.equal(tgMemoryBudget({ ...small, availableMb: 1800 }, 512).memoryMb, 512);
  assert.match(tgResourceBlock({ ...small, availableMb: 850 }, 1024), /内存预算不足/);
});
test('admission reserves future browser growth instead of oversubscribing a lightly used host', () => {
  const second = { totalMb: 1986, availableMb: 1100, reservedMb: 768, growthMb: 468, diskLow: false };
  // The existing account currently uses 300 MB but can still grow to 768 MB.
  assert.match(tgResourceBlock(second, 1024), /内存预算不足/);
  assert.match(tgResourceBlock({ ...second, growthMb: undefined }, 1024), /内存预算不足/);
  const large = { totalMb: 8192, availableMb: 6000, reservedMb: 1024, growthMb: 600, diskLow: false };
  assert.equal(tgMemoryBudget(large, 1024).memoryMb, 1024);
  const full = tgMemoryBudget({ ...large, reservedMb: 6500, growthMb: 0 }, 1024);
  assert.equal(full.memoryMb, 0);
  assert.match(full.reason, /已有账号限额合计/);
  for (const value of [NaN, -1, 1025]) assert.equal(tgMemoryBudget({ ...large, growthMb: value }, 1024).memoryMb, 0);
});
test('memory growth uses the Docker working set, supports both cgroups and fails conservatively', () => {
  const bytes = 1024 ** 2;
  for (const field of ['inactive_file', 'total_inactive_file']) {
    const stats = { memory_stats: { usage: 600 * bytes, limit: 1024 * bytes, stats: { [field]: 200 * bytes } } };
    assert.equal(tgBrowserGrowthMb(stats, 1024), 624);
  }
  for (const stats of [null, {}, { memory_stats: { usage: 1, limit: bytes, stats: {} } }, { memory_stats: { usage: 1, limit: 1024 * bytes, stats: { inactive_file: 2 } } }]) assert.equal(tgBrowserGrowthMb(stats, 1024), 1024);
});
test('migration hold survives long inactivity and resumes only after explicit old-host confirmation', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nurossh-tg-migration-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const marker=path.join(root,'marker.json'),markerId='22222222-2222-4222-8222-222222222222';fs.writeFileSync(marker,JSON.stringify({id:markerId}));
  let clock=Date.now(); const {service,calls}=fixture(t,{}, {restoreMarker:marker,now:()=>clock});
  const a=await service.save({name:'Kept'}); await service.runtime(true);
  assert.equal(service.migrationHeld(),true);assert.equal(calls.find(call=>call.url==='/configure').body.migrationHold,true);
  await assert.rejects(service.command(a.id,'wake'),/旧机器/);
  clock+=366*86400000; await service.snapshot();assert.equal(service.requireAccount(a.id).name,'Kept');assert.equal(service.migrationHeld(),true);
  await assert.rejects(service.activateMigration('wrong'),/确认/);assert.ok(!calls.some(call=>call.url==='/resume'));
  await service.activateMigration('old-host-stopped');assert.equal(service.migrationHeld(),false);assert.ok(calls.some(call=>call.url==='/resume'));
  await service.command(a.id,'wake');assert.equal(service.requireAccount(a.id).desired,true);
});
test('restored desired accounts resume in recent-running order and takeover survives a lost response', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nurossh-tg-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const marker=path.join(root,'marker.json');fs.writeFileSync(marker,JSON.stringify({id:'33333333-3333-4333-8333-333333333333'}));
 const db=new Database(':memory:'),calls=[];const runner={enabled:true,request:async(_method,url,body)=>{calls.push({url,body});if(url==='/resume')throw Error('lost response');return url==='/status'?{accounts:[]}:{ok:true};}};
 let service=createTgHostingService({db,key:Buffer.alloc(32,7),runner});
 const a=await service.save({name:'A'}),b=await service.save({name:'B'});await service.command(a.id,'wake');await service.command(b.id,'wake');
 // A was the most recently running account before the backup.
 const row=JSON.parse(db.prepare('SELECT value FROM tg_hosting_accounts WHERE id=?').get(a.id).value);row.lastRunningAt='2026-11-01T00:00:00Z';db.prepare('UPDATE tg_hosting_accounts SET value=? WHERE id=?').run(JSON.stringify(row),a.id);
 service.close();service=createTgHostingService({db,key:Buffer.alloc(32,7),runner,restoreMarker:marker});
 t.after(()=>{service.close();db.close();});
 await service.runtime(true);const held=calls.at(-2);assert.equal(held.url,'/configure');assert.equal(held.body.accounts.every(row=>!row.desired),true);
 await assert.rejects(service.activateMigration('old-host-stopped'),/lost response/);assert.equal(service.migrationHeld(),false);
 await service.runtime(true);assert.equal(calls.at(-2).body.migrationHold,false);assert.equal(calls.at(-2).body.accounts.every(row=>row.desired),true);
 assert.deepEqual(tgResumeOrder([{id:'b',createdAt:'2026-01-01'},{id:'a',lastRunningAt:'2026-02-01'}]).map(row=>row.id),['a','b']);
});
test('a corrupted migration marker holds TG startup without crashing the panel', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nurossh-tg-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const marker=path.join(root,'marker.json');fs.writeFileSync(marker,'not json');const {service}=fixture(t,{}, {restoreMarker:marker});
 assert.equal((await service.snapshot()).component.migrationHold,true);
});

test('a lost wake acknowledgement preserves keep intent across a panel restart',async t=>{
 const db=new Database(':memory:'),key=Buffer.alloc(32,7),calls=[];let failing=false;
 const runner={enabled:true,request:async(_method,url,body)=>{calls.push({url,body});if(failing&&url.endsWith('/wake'))throw Object.assign(Error('response interrupted'),{statusCode:503});return url==='/status'?{accounts:[]}:{ok:true};}};
 let service=createTgHostingService({db,key,runner});const account=await service.save({name:'Preserve intent'});failing=true;
 await assert.rejects(service.command(account.id,'wake'),/interrupted/);assert.equal(service.requireAccount(account.id).desired,true);service.close();
 service=createTgHostingService({db,key,runner});t.after(()=>{service.close();db.close();});await service.runtime(true);
 assert.equal(calls.findLast(call=>call.url==='/configure').body.accounts[0].desired,true);
});
test('a definite busy rejection rolls back operation intent while preserving concurrent account edits',async t=>{
 const {service,runner}=fixture(t);const account=await service.save({name:'A'});await service.runtime(true);
 runner.request=async(_method,url)=>{if(url.endsWith('/wake')){await service.save({...service.requireAccount(account.id),name:'Renamed'},account.id);throw Object.assign(Error('正在备份'),{statusCode:409});}return{ok:true};};
 await assert.rejects(service.command(account.id,'wake'),/备份/);const kept=service.requireAccount(account.id);assert.equal(kept.name,'Renamed');assert.equal(kept.desired,false);
});

test('disk parking requires a confirmed low disk sample and never treats a read error as a reason to stop accounts',()=>{
 assert.equal(tgDiskNeedsParking({diskLow:true,diskHeadroomBytes:-1}),true);
 for(const value of [null,{}, {diskLow:false,diskHeadroomBytes:1},{diskLow:true,diskHeadroomBytes:NaN},{diskLow:true,diskHeadroomBytes:-1,error:'temporarily unreadable'}])assert.equal(tgDiskNeedsParking(value),false);
});

test('new accounts require kernel-enforced memory, swap, CPU and PID limits',()=>{
 const good={MemoryLimit:true,SwapLimit:true,CpuCfsQuota:true,PidsLimit:true};
 assert.equal(tgHostIsolationBlock(good),'');
 for(const field of Object.keys(good))for(const value of [false,undefined])assert.match(tgHostIsolationBlock({...good,[field]:value}),/暂停新账号/);
 const resources={totalMb:8192,availableMb:6000,reservedMb:1024,diskLow:false,isolationError:tgHostIsolationBlock({...good,MemoryLimit:false})};
 assert.match(tgResourceBlock(resources,1024),/内存限额/);
});

test('browsers cannot start with missing or excessive Docker resource limits',()=>{
 const good={Memory:1024**3,MemorySwap:1024**3,NanoCpus:1e9,PidsLimit:256};
 assert.equal(tgBrowserLimitError(good,1024,1),'');
 for(const value of [null,{}, {...good,Memory:0},{...good,Memory:2*1024**3},{...good,MemorySwap:-1},{...good,NanoCpus:0},{...good,NanoCpus:2e9},{...good,PidsLimit:0},{...good,PidsLimit:-1}])assert.match(tgBrowserLimitError(value,1024,1),/未启动/);
 assert.equal(tgBrowserLimitError({...good,NanoCpus:5e8},1024,1),'');
});

test('browser health watchdog distinguishes a confirmed failure from an unavailable status',()=>{
 assert.equal(tgContainerHealth({Status:'Up 1 minute (healthy)'}),'healthy');
 assert.equal(tgContainerHealth({Status:'Up 1 minute (unhealthy)'}),'unhealthy');
 assert.equal(tgContainerHealth({State:{Health:{Status:'unhealthy'}}}),'unhealthy');
 assert.equal(tgContainerHealth({State:{Running:true}}),'unknown');
});

test('picture reconnection uses bounded backoff independently from browser startup',()=>{
 assert.deepEqual([1,2,3,4,5,6].map(tgViewRetryDelay),[2000,5000,10000,20000,30000,null]);
});

test('healthy operation resets a burst retry budget without allowing rapid crash loops',()=>{
 const now=4*3600000;
 assert.equal(tgCrashAttempts({crashAttempts:3,healthySince:now-30*60000},now),0);
 assert.equal(tgCrashAttempts({crashAttempts:3,healthySince:now-30*60000+1},now),3);
 for(const healthySince of [null,undefined,NaN,now+60000])assert.equal(tgCrashAttempts({crashAttempts:3,healthySince},now),3);
 assert.equal(tgCrashAttempts({},now),0);
});

test('one rejected account does not block other account commands or lose their keep intents',async t=>{
 const {service,runner}=fixture(t);const accounts=await Promise.all(Array.from({length:4},(_,i)=>service.save({name:`Account ${i}`})));
 await service.runtime(true);
 runner.request=async(_method,url)=>{if(url.includes(accounts[0].id))throw Object.assign(Error('single account busy'),{statusCode:409});return{ok:true};};
 const results=await Promise.allSettled(accounts.map(account=>service.command(account.id,'wake')));
 assert.equal(results[0].status,'rejected');assert.equal(service.requireAccount(accounts[0].id).desired,false);
 for(let i=1;i<accounts.length;i++){assert.equal(results[i].status,'fulfilled');assert.equal(service.requireAccount(accounts[i].id).desired,true);}
 assert.equal(service.records().length,4);
});
