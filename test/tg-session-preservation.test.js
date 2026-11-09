import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encoder, decoder } from '../server/backup-crypto.cjs';
import { TG_PROFILE_MAX_BYTES } from '../shared/tg-hosting.js';

const source=await fs.readFile(new URL('../tg-hosting/runner.mjs',import.meta.url),'utf8');
const markerHelpers=source.slice(source.indexOf('async function markProfileKnown('),source.indexOf('const active ='));
async function fixture(t, overrides={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tg-session-review-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const profiles=path.join(root,'profiles'),snapshots=path.join(root,'snapshots'),id='account';
  await fs.mkdir(profiles);await fs.mkdir(snapshots);
  const row={id,desired:true,containerPresent:false},rows=new Map([[id,row]]),calls=[];
  const context={rows,profiles,snapshots,path,fs:syncFs,fsp:{...fs,chown:async()=>{}},key:Buffer.alloc(32,7),TG_PROFILE_MAX_BYTES,
    pipeline,encoder,decoder,Transform,
    profileMarker:id=>path.join(snapshots,id+'.profile-known'),activeMarker:id=>path.join(profiles,'.active-'+id),
    fail:message=>{throw Error(message);},readResources:async()=>({diskHeadroomBytes:10**10}),
    helper:async()=>{calls.push('extract');assert.fail('invalid/missing snapshot must not extract');},...overrides};
  const functions=vm.runInNewContext(markerHelpers+'\n'+source.slice(source.indexOf('async function restoreProfile('),source.indexOf('\nasync function profileUsage('))+'\n({restoreProfile,markProfileKnown,requireSavedProfile})',context);
  return {root,profiles,snapshots,id,row,rows,calls,context,...functions};
}

test('only never-started accounts may create a new empty profile; known profiles fail closed when both copies are missing',async t=>{
  for(const mode of ['new','marker','database','active']){
    const h=await fixture(t);
    if(mode==='marker')await h.markProfileKnown(h.id);
    if(mode==='database')h.row.profileExpected=true;
    if(mode==='active')await fs.writeFile(path.join(h.profiles,'.active-'+h.id),'active');
    if(mode==='new')await h.restoreProfile(h.id);else await assert.rejects(h.restoreProfile(h.id),/不会创建空白会话/);
    assert.deepEqual(await fs.readdir(path.join(h.profiles,h.id)),[]);assert.deepEqual(h.calls,[]);
    if(mode==='marker')assert.equal(await fs.readFile(h.context.profileMarker(h.id),'utf8'),'profile-created\n');
  }
});

test('an existing login directory always wins over an older snapshot and is never automatically replaced',async t=>{
  const h=await fixture(t),directory=path.join(h.profiles,h.id);
  await fs.mkdir(directory);await fs.writeFile(path.join(directory,'session'),'current-login');
  const archive=path.join(h.snapshots,h.id+'.tar.gz.enc');await fs.writeFile(archive,'older-snapshot');
  await h.restoreProfile(h.id);
  assert.equal(await fs.readFile(path.join(directory,'session'),'utf8'),'current-login');
  assert.equal(await fs.readFile(archive,'utf8'),'older-snapshot');assert.deepEqual(h.calls,[]);assert.equal(h.row.profileExpected,true);
});

test('authentication failure or extraction failure retains encrypted snapshot and never installs a partial profile',async t=>{
  for(const mode of ['authentication','extraction']){
    const h=await fixture(t),archive=path.join(h.snapshots,h.id+'.tar.gz.enc');
    if(mode==='authentication')await fs.writeFile(archive,'corrupted-encrypted-snapshot');
    else {
      const {Readable}=await import('node:stream');await pipeline(Readable.from([Buffer.from('authenticated-fixture')]),encoder(h.context.key),syncFs.createWriteStream(archive));
      h.context.helper=async(stagingName)=>{await fs.writeFile(path.join(h.profiles,stagingName,'partial-session'),'uncommitted');throw Error('extract-failed');};
      // Recreate the VM so the fault injection is used by the real restore body.
      h.restoreProfile=vm.runInNewContext(markerHelpers+'\n('+source.slice(source.indexOf('async function restoreProfile('),source.indexOf('\nasync function profileUsage('))+')',h.context);
    }
    const original=await fs.readFile(archive);await assert.rejects(h.restoreProfile(h.id));
    assert.deepEqual(await fs.readFile(archive),original);assert.deepEqual(await fs.readdir(path.join(h.profiles,h.id)),[]);
    assert.ok(!(await fs.readdir(h.profiles)).some(name=>name.startsWith('.restore-')));
  }
});

test('all startup failures retain memory and CPU reservations if a browser cannot be confirmed stopped',async()=>{
  const body=source.slice(source.indexOf('async function start('),source.indexOf('\nfunction probeVnc('));
  const row={id:'account',desired:true,state:'queued'},rows=new Map([[row.id,row]]);
  const start=vm.runInNewContext(`(${body})`,{rows,assertImage:async()=>{throw Error('Docker request failed after prior startup');},stop:async()=>{throw Error('Docker stop unavailable');}});
  await start(row.id,.5,768);
  assert.equal(row.state,'running');assert.equal(row.memoryMb,768);assert.equal(row.cpu,.5);assert.equal(row.desired,true);
  assert.match(row.error,/保留资源名额和登录资料/);assert.equal(row.storageBlocked,false);
});

test('interrupted guard writes leave no half-written permanent marker and never change the profile',async t=>{
  const h=await fixture(t,{fsp:{...fs,chown:async()=>{throw Error('permission failure');}}});
  const directory=path.join(h.profiles,h.id);await fs.mkdir(directory);await fs.writeFile(path.join(directory,'session'),'login-proof');
  await assert.rejects(h.markProfileKnown(h.id),/permission failure/);
  assert.deepEqual(await fs.readdir(h.snapshots),[]);assert.equal(await fs.readFile(path.join(directory,'session'),'utf8'),'login-proof');
  assert.equal(h.row.profileExpected,undefined);
});
