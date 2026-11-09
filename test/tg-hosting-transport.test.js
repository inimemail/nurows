import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {requestTgJson} from '../shared/tg-http.js';
import {createTgRunnerClient} from '../server/tg-hosting-runner.js';
import {tgRuntimeAccount} from '../shared/tg-hosting.js';
async function fixture(t, handler) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'tg-http-')),socketPath=path.join(root,'s');
  const server=http.createServer(handler);server.listen(socketPath);await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  return {socketPath,path:'/fixture',method:'GET'};
}
test('TG transport preserves UTF-8 JSON and rejects truncated replies so shared polling can recover',async t=>{
  let broken=true;
  const options=await fixture(t,(req,res)=>{if(broken){res.writeHead(200,{'Content-Length':'100'});res.write('{');setImmediate(()=>res.destroy());}else res.end(JSON.stringify({text:'会话资料保留'}));});
  await assert.rejects(requestTgJson({...options,timeout:1000}));broken=false;assert.equal((await requestTgJson(options)).data.text,'会话资料保留');
});
test('TG transport bounds the whole request even when a stalled worker drips data',async t=>{
  const options=await fixture(t,(_req,res)=>{res.writeHead(200);res.write('{');const timer=setInterval(()=>res.write(' '),5);res.on('close',()=>clearInterval(timer));});
  await assert.rejects(requestTgJson({...options,timeout:40}),/超时/);
});
test('TG transport counts byte limits and rejects invalid JSON without hanging',async t=>{
  let mode='large';const options=await fixture(t,(_req,res)=>res.end(mode==='large'?JSON.stringify({text:'汉字'.repeat(20)}):'not-json'));
  await assert.rejects(requestTgJson({...options,maxBytes:30}),/限制/);mode='invalid';await assert.rejects(requestTgJson(options),/无效数据/);
});
test('runner client preserves explicit rejections and hides low-level transport errors',async t=>{
  const options=await fixture(t,(_req,res)=>{res.writeHead(409);res.end(JSON.stringify({error:'正在备份'}));});
  const runner=createTgRunnerClient(options.socketPath);await assert.rejects(runner.request('POST','/wake',{}),error=>error.statusCode===409&&/备份/.test(error.message));
  await assert.rejects(createTgRunnerClient('/no-such-tg-fixture/socket').request('GET','/status'),error=>error.statusCode===503&&/未删除/.test(error.message));
});
test('ten thousand queued accounts fit the transport limit and never expose runtime internals',()=>{
  const value=tgRuntimeAccount({id:'11111111-1111-4111-8111-111111111111',state:'queued',ip:'private',containerPresent:true,dirty:true,error:'错误'.repeat(1000),snapshotError:'错误'.repeat(1000),retryAt:Date.now(),startedAt:new Date().toISOString(),snapshotAt:new Date().toISOString(),pending:'snapshot',memoryMb:8192,cpu:4,viewers:1});
  assert.equal(value.error.length,160);assert.equal(value.ip,undefined);assert.equal(value.dirty,undefined);assert.equal(value.containerPresent,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify({accounts:Array(10000).fill(value)}))<8*1024**2);
});
