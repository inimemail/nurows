import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { orchestrationDefaults, registerOrchestrationRoutes, registerPoolPublicRoutes, sanitizeOrchestrationState } from '../server/orchestration.js';
import { parseExternalPoolIps } from '../server/pool-external-api.js';

async function harness(t, extra = {}) {
  let state = { ...orchestrationDefaults(),
    probes: [{id:'probe',enabled:true}],
    ipPools: ['a','b'].map(id => ({id,name:`备用池 ${id}`,probeIds:['probe'],assetIds:[],enabled:true})), ...extra };
  let now = 1800000000000, writes = 0;
  const changed = [], key = crypto.randomBytes(32);
  const app = express();
  const deps = {
    now: () => now,
    readState: () => structuredClone(state),
    updateState(fn) { state = fn(structuredClone(state)); writes++; return state; },
    sanitizeState: sanitizeOrchestrationState,
    encryptSecret(token) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv);
      return Buffer.concat([iv,cipher.update(token),cipher.final(),cipher.getAuthTag()]).toString('base64');
    },
    decryptSecret(encrypted) {
      const bytes=Buffer.from(encrypted,'base64'), decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString();
    },
    onIpAvailabilityChanged(change) { changed.push(change); }
  };
  app.use(express.json({limit:'2mb'}));
  registerPoolPublicRoutes(app,deps);
  app.use('/api',(req,res,next)=>{
    if(req.headers['x-admin-session']!=='test-session')return res.status(401).json({error:'请先登录'});
    req.auth={username:'tester'}; next();
  });
  registerOrchestrationRoutes(app,deps);
  app.use((error,_req,res,_next)=>res.status(error.statusCode || error.status || 500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,{admin=false,token,body,method=body===undefined?'GET':'POST',text=false}={})=>{
    const res=await fetch(base+path,{method,headers:{...(admin?{'x-admin-session':'test-session'}:{}),
      ...(token?{Authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{'Content-Type':text?'text/plain':'application/json'})},
      ...(body===undefined?{}:{body:text?body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json(),headers:res.headers};
  };
  const credentials=async(id='a')=>{
    const response=await request(`/api/ip-pools/${id}/external-access`,{admin:true});assert.equal(response.status,200);return response.body;
  };
  const add=(token,body,id='a',text=false)=>request(`/api/external/ip-pools/${id}/ips`,{token,body,text});
  return {state:()=>state,writes:()=>writes,changed,request,credentials,add,advance:ms=>{now+=ms;}};
}

test('external IP parser supports single, batch and text, canonicalizes IPv6 and rejects invalid batches in full',()=>{
  assert.deepEqual(parseExternalPoolIps({ip:'192.0.2.1'}),{received:1,addresses:['192.0.2.1']});
  for(const body of [{ips:['2001:0DB8:0:0:0:0:0:1','2001:db8::1','192.0.2.1']},
    {ips:'2001:0DB8:0:0:0:0:0:1，2001:db8::1;192.0.2.1'},'2001:0DB8:0:0:0:0:0:1\n2001:db8::1\n192.0.2.1']){
    assert.deepEqual(parseExternalPoolIps(body),{received:3,addresses:['2001:db8::1','192.0.2.1']});
  }
  for(const body of [null,{},[],{ips:[]},{ips:[123]},{ips:['']},{ips:['192.0.2.1','invalid']},{ips:'fe80::1%eth0'},
    {ip:'192.0.2.1',ips:['192.0.2.2']},{ips:'192.0.2.1',mode:'replace'},{ips:'https://example.com'}, {ips:['192.0.2.1:80']}, {ips:['1'.repeat(1000)]}]){
    assert.throws(()=>parseExternalPoolIps(body));
  }
  assert.equal(parseExternalPoolIps({ips:Array(5000).fill('192.0.2.1')}).addresses.length,1);
  assert.throws(()=>parseExternalPoolIps({ips:Array(5001).fill('192.0.2.1')}),/5000/);
});

test('each pool has a stable encrypted key; only explicit management routes reveal it',async t=>{
  const h=await harness(t),a=await h.credentials(),b=await h.credentials('b');
  assert.match(a.token,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(a.token,b.token);
  assert.equal((await h.credentials()).token,a.token);
  assert.notEqual(h.state().ipPools[0].externalTokenEnc,a.token);
  assert.ok(!JSON.stringify(h.state()).includes(a.token));
  const read=await h.request('/api/ip-pools/a/external-access');assert.equal(read.status,401);
  for(const response of [sanitizeOrchestrationState(h.state()),(await h.request('/api/orchestration/status/pools',{admin:true})).body]){
    const pool=response.ipPools[0];assert.equal(pool.externalApiConfigured,true);
    assert.equal(pool.externalTokenHash,undefined);assert.equal(pool.externalTokenEnc,undefined);
    assert.ok(!JSON.stringify(response).includes(a.token));
  }
  assert.ok(!JSON.stringify(h.state().auditLogs).includes(a.token));
  const res=await h.request('/api/ip-pools/a/external-access',{admin:true});
  assert.equal(res.headers.get('cache-control'),'no-store');
});

test('valid external calls append only to their own pool, reuse IPv6 assets, preserve health and wake waiting work',async t=>{
  const h=await harness(t,{ipAssets:[{id:'v6',address:'2001:0db8:0:0:0:0:0:1',enabled:false,health:'down'}],
    ipPools:[{id:'a',name:'池 A',probeIds:['probe'],assetIds:['v6'],enabled:false},{id:'b',name:'池 B',assetIds:[]}]});
  const {token}=await h.credentials();
  const result=await h.add(token,{ips:['192.0.2.10','2001:db8::1','192.0.2.10']});
  assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual(result.body,{ok:true,poolId:'a',received:3,total:2,added:1,existing:1,duplicates:1,created:1,reused:1,poolSize:2});
  assert.deepEqual(h.state().ipPools[0].probeIds,['probe']);assert.equal(h.state().ipPools[0].enabled,false);
  assert.deepEqual(h.state().ipPools[1].assetIds,[]);
  assert.equal(h.state().ipAssets.length,2);assert.equal(h.state().ipAssets[0].enabled,false);assert.equal(h.state().ipAssets[0].health,'down');
  assert.equal(h.state().ipAssets[1].health,'unknown');
  assert.deepEqual(h.changed,[{poolIds:['a']}]);
  const repeated=await h.add(token,{ip:'192.0.2.10'});assert.equal(repeated.body.added,0);assert.equal(repeated.body.existing,1);
  assert.equal(h.changed.length,1);
  assert.equal((await h.add(token,'192.0.2.11\n2001:db8::2','a',true)).body.added,2);
  const status=await h.request('/api/ip-pools/a/external-access',{admin:true});assert.equal(status.body.access.externalLastAddedCount,2);assert.ok(status.body.access.externalLastUsedAt);
});

test('cross-pool, missing, query-only and session-only credentials cannot mutate inventory',async t=>{
  const h=await harness(t),a=await h.credentials(),b=await h.credentials('b'),before=structuredClone(h.state()),writes=h.writes();
  for(const res of [await h.add(a.token,{ip:'192.0.2.1'},'b'),await h.add(b.token,{ip:'192.0.2.1'}),
    await h.add(undefined,{ip:'192.0.2.1'}),await h.add('invalid',{ip:'192.0.2.1'}),await h.add(a.token,{ip:'192.0.2.1'},'deleted'),
    await h.request(`/api/external/ip-pools/a/ips?token=${a.token}`,{admin:true,body:{ip:'192.0.2.1'}})]){
    assert.equal(res.status,401);
  }
  assert.deepEqual(h.state(),before);assert.equal(h.writes(),writes);
  for(const path of ['/api/ip-pools/a/external-access','/api/ip-pools/a/external-access/rotate-token']){
    assert.equal((await h.request(path,{token:a.token,method:path.endsWith('rotate-token')?'POST':'GET'})).status,401);
  }
});

test('equivalent IPv6 assets already in multiple pools prefer the member of the requested pool',async t=>{
  const h=await harness(t,{ipAssets:[
    {id:'other',address:'2001:db8::1',enabled:true,health:'healthy'},
    {id:'member',address:'2001:0DB8:0:0:0:0:0:1',enabled:false,health:'down'},
    {id:'exact-duplicate',address:'2001:0DB8:0:0:0:0:0:1',enabled:true,health:'healthy'}
  ],ipPools:[{id:'a',name:'本池',assetIds:['member']},{id:'b',name:'其他池',assetIds:['other']}]});
  const {token}=await h.credentials();
  const response=await h.add(token,{ip:'2001:db8::1'});
  assert.equal(response.body.added,0);assert.equal(response.body.existing,1);assert.equal(response.body.created,0);
  assert.deepEqual(h.state().ipPools[0].assetIds,['member']);assert.deepEqual(h.state().ipPools[1].assetIds,['other']);
  assert.equal(h.state().ipAssets[1].enabled,false);assert.equal(h.state().ipAssets[1].health,'down');
});

test('rotation, disable/enable and deletion revoke the intended pool only',async t=>{
  const h=await harness(t),a=await h.credentials(),b=await h.credentials('b');
  const rotated=await h.request('/api/ip-pools/a/external-access/rotate-token',{admin:true,method:'POST'});
  assert.equal(rotated.status,200);assert.notEqual(rotated.body.token,a.token);assert.equal(rotated.body.path,a.path);
  assert.equal((await h.add(a.token,{ip:'192.0.2.1'})).status,401);
  assert.equal((await h.add(rotated.body.token,{ip:'192.0.2.1'})).status,200);
  assert.equal((await h.add(b.token,{ip:'192.0.2.2'},'b')).status,200);
  const toggle=enabled=>h.request('/api/ip-pools/a/external-access',{admin:true,method:'PUT',body:{enabled}});
  assert.equal((await toggle(false)).status,200);
  assert.equal((await h.add(rotated.body.token,{ip:'192.0.2.3'})).status,403);
  assert.equal((await h.credentials()).token,rotated.body.token);
  assert.equal((await toggle(true)).status,200);
  assert.equal((await h.add(rotated.body.token,{ip:'192.0.2.3'})).status,200);
  await h.request('/api/orchestration/ip-pools/a',{admin:true,method:'DELETE'});
  assert.equal((await h.add(rotated.body.token,{ip:'192.0.2.4'})).status,401);
  assert.equal((await h.add(b.token,{ip:'192.0.2.4'},'b')).status,200);
});

test('normal editing and duplication cannot copy, forge, replace or re-enable external credentials',async t=>{
  const h=await harness(t),a=await h.credentials();
  await h.request('/api/ip-pools/a/external-access',{admin:true,method:'PUT',body:{enabled:false}});
  const forged={name:'改名',probeIds:['probe'],assetIds:[],externalApiEnabled:true,externalTokenHash:'f'.repeat(64),externalTokenEnc:'forged',externalTokenUpdatedAt:'forged'};
  const updated=await h.request('/api/orchestration/ip-pools/a',{admin:true,method:'PUT',body:forged});
  assert.equal(updated.status,200);assert.equal(updated.body.item.externalTokenHash,undefined);assert.equal(updated.body.item.externalTokenEnc,undefined);
  assert.equal((await h.credentials()).token,a.token);assert.equal(h.state().ipPools[0].externalApiEnabled,false);
  const clone=await h.request('/api/orchestration/ip-pools',{admin:true,body:{...h.state().ipPools[0],id:'clone'}});
  assert.equal(clone.status,200);assert.equal(clone.body.item.externalApiConfigured,false);
  const c=await h.credentials('clone');assert.notEqual(c.token,a.token);assert.equal(c.access.externalApiEnabled,true);
});

test('invalid batches, override fields, pool overflow and oversized text cause no partial writes',async t=>{
  const assets=Array.from({length:5000},(_,i)=>({id:`ip${i}`,address:`10.0.${Math.floor(i/256)}.${i%256}`}));
  const h=await harness(t,{ipAssets:assets,ipPools:[{id:'a',name:'满池',assetIds:assets.map(asset=>asset.id)}]});
  const a=await h.credentials(),before=structuredClone(h.state()),writes=h.writes();
  for(const body of [{ips:['192.0.2.1','not-ip']},{ips:[]},{ip:'192.0.2.1',assetIds:[]},{ips:Array(5001).fill('192.0.2.1')}]){
    assert.equal((await h.add(a.token,body)).status,400);
  }
  assert.equal((await h.add(a.token,{ip:'192.0.2.1'})).status,409);
  assert.equal((await h.add(a.token,'192.0.2.1\n'.repeat(30000),'a',true)).status,413);
  assert.deepEqual(h.state(),before);assert.equal(h.writes(),writes);
  assert.equal((await h.add(a.token,{ip:assets[0].address})).status,200,'existing member may be submitted at capacity');
});

test('public calls are bounded per pool and per client without limiting administrator controls',async t=>{
  const h=await harness(t),{token}=await h.credentials();
  for(let i=0;i<60;i++)assert.equal((await h.add(token,{ip:'192.0.2.1'})).status,200);
  const denied=await h.add(token,{ip:'192.0.2.2'});assert.equal(denied.status,429);assert.ok(Number(denied.headers.get('retry-after'))>0);
  assert.equal(h.state().ipAssets.length,1);
  h.advance(60001);assert.equal((await h.add(token,{ip:'192.0.2.2'})).status,200);
  for(let i=0;i<119;i++)assert.equal((await h.add('wrong',{ip:'192.0.2.3'})).status,401);
  assert.equal((await h.add('wrong',{ip:'192.0.2.3'})).status,429);
  assert.equal((await h.request('/api/ip-pools/a/external-access',{admin:true})).status,200);
});

test('production registers pool public routes before the session guard and management after it',()=>{
  const source=fs.readFileSync(new URL('../server/index.js',import.meta.url),'utf8');
  assert.ok(source.indexOf('registerPoolPublicRoutes(app, orchestrationDeps)')<source.indexOf("app.use('/api', authGuard)"));
  assert.ok(source.indexOf('registerOrchestrationRoutes(app, orchestrationDeps)')>source.indexOf("app.use('/api', authGuard)"));
});
