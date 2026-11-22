import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOrchestrationRoutes, orchestrationDefaults, normalizeOrchestrationState, processReadyDnsGuards } from '../server/orchestration.js';
import { createDnsGuardBatchService, parseGuardBatch } from '../server/dns-guard-batch.js';

function harness(extra={}) {
  let state=normalizeOrchestrationState({...orchestrationDefaults(),
    probes:[{id:'p',enabled:true,status:'online',lastSeenAt:new Date().toISOString()}],
    dnsAccounts:[{id:'account',name:'test account',provider:'huawei',enabled:true,credentialsEnc:'test'}],
    dnsGuards:['a','b'].map((id,index)=>({id,name:`守护 ${id}`,domain:`${id}.example.com`,accountId:'account',recordType:'A',probeIds:['p'],poolIds:[],
      enabled:true,sourcesEnabled:true,sourceOwnedValues:['192.0.2.1'],currentValues:['192.0.2.1'],maxActiveIps:50,
      sources:[{id:`${id}-source`,domain:`${id}-source.example.com`,backupDomain:`${id}-backup.example.com`,name:`来源 ${id}`,fallbackOnly:!!index}],
      cycle:{id:`cycle-${id}`,expectedProbeIds:['p'],phase:'remote',checks:[{id:'check',address:'192.0.2.1',observations:{}}]},
      sourceState:{},...extra.guard})),...extra.state});
  const remote=new Map(state.dnsGuards.map(guard=>[guard.domain,guard.recordType==='AAAA'?['2001:db8::1']:['192.0.2.1']])),writes=[],changed=[],routes=new Map();
  const deps={readState:keys=>keys?Object.fromEntries(keys.map(key=>[key,structuredClone(state[key])])):structuredClone(state),
    updateState:fn=>{state=fn(structuredClone(state));return structuredClone(state);},sanitizeState:value=>value,decryptSecret:()=>'{"accessKey":"test","secretKey":"test"}',
    onDnsGuardChanged:id=>changed.push(id),
    resolveDnsBinding:async(_state,_account,_credentials,binding)=>({zone:{id:'z',name:'example.com',providerZoneId:'z'},normalizedBinding:{...binding,recordName:binding.domain.split('.')[0]}}),
    readDnsRecord:async(_account,_credentials,_zone,binding)=>({values:[...remote.get(binding.domain)],recordIds:['record']}),
    writeDnsRecord:async(_account,_credentials,_zone,binding,values)=>{writes.push({domain:binding.domain,values:[...values]});remote.set(binding.domain,[...values]);return ['record'];}
  };
  registerOrchestrationRoutes(Object.fromEntries(['get','post','put','delete'].map(method=>[method,(path,fn)=>routes.set(`${method} ${path}`,fn)])),deps);
  async function request(method,path,body={},params={},actor='tester') {
    const response={status:200,body:null};
    await routes.get(`${method} ${path}`)({body,params,auth:{username:actor}},
      {set(){},json(value){response.body=value;},status(code){response.status=code;return this;}},error=>{throw error;});
    return response.body;
  }
  const read=(id,actor)=>request('get','/api/dns-guards/batch/:jobId',{}, {jobId:id},actor);
  const settle=async(id,status='ready')=>{
    for(let i=0;i<300;i++){const job=await read(id);if(job.status===status)return job;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.fail('batch did not settle');
  };
  const preview=async(input)=>settle((await request('post','/api/dns-guards/batch/preview',input)).id);
  const apply=async(id)=>{await request('post','/api/dns-guards/batch/:jobId/apply',{confirm:'apply-dns-guard-batch'},{jobId:id});return settle(id,'done');};
  return {state:()=>state,mutate:fn=>{fn(state);},remote,writes,changed,deps,request,read,settle,preview,apply};
}

test('batch validation bounds input and restricts actions and mutable fields',()=>{
  for(const input of [{},{ids:[],action:'enabled'},{ids:['a'],action:'unknown'},
    {ids:['a'],action:'settings',field:'password',value:1},{ids:['a'],action:'settings',field:'interval',value:0},
    {ids:['a'],action:'references',field:'poolIds',mode:'add',values:[]},
    {ids:['a'],action:'sources_add',text:'invalid'},
    {ids:['a'],action:'sources_map',text:'a.example.com | b.example.com\na.example.com | c.example.com'},
    {ids:['a'],action:'ips_add',text:'192.0.2.1\ninvalid'},
    {ids:Array(501).fill('a'),action:'check'}])assert.throws(()=>parseGuardBatch(input));
  assert.deepEqual(parseGuardBatch({ids:['a','a'],action:'ips_add',text:'2001:0DB8::1\n2001:db8::1'}).addresses,['2001:db8::1']);
});

test('preview is read-only; confirmed source toggle updates only selected guards and resets ordinary checks safely',async()=>{
  const h=harness(),before=structuredClone(h.state());
  const preview=await h.preview({ids:['a'],action:'sources_enabled',enabled:false});
  assert.equal(preview.rows[0].status,'ready');assert.deepEqual(h.state(),before);
  const result=await h.apply(preview.id);
  assert.equal(result.rows[0].status,'succeeded');
  const [a,b]=h.state().dnsGuards;
  assert.equal(a.sourcesEnabled,false);assert.equal(a.cycle,null);assert.equal(b.sourcesEnabled,true);assert.ok(b.cycle);
  assert.deepEqual(a.sources,before.dnsGuards[0].sources);assert.deepEqual(a.sourceOwnedValues,before.dnsGuards[0].sourceOwnedValues);
  assert.deepEqual(h.changed,['a']);
  await h.request('post','/api/dns-guards/batch/:jobId/apply',{confirm:'apply-dns-guard-batch'},{jobId:preview.id});
  assert.equal(h.state().auditLogs.filter(log=>log.action==='dnsGuard.batch').length,1,'apply retry is idempotent');
});

test('DDNS common add/remove/map preserves different rules, stable IDs, names and fallback settings',async()=>{
  const h=harness();
  const run=async action=>h.apply((await h.preview({ids:['a','b'],...action})).id);
  await run({action:'sources_add',text:'extra.example.com | backup-extra.example.com | 额外来源'});
  assert.deepEqual(h.state().dnsGuards.map(guard=>guard.sources.length),[2,2]);
  assert.equal(h.state().dnsGuards[0].sources[0].domain,'a-source.example.com');assert.equal(h.state().dnsGuards[1].sources[0].domain,'b-source.example.com');
  const same=await h.preview({ids:['a','b'],action:'sources_add',text:'extra.example.com | ignored-backup.example.com | 不覆盖'});
  assert.ok(same.rows.every(row=>row.status==='unchanged'));
  await run({action:'sources_map',text:'a-source.example.com | new-a.example.com\nb-backup.example.com | new-backup.example.com'});
  const [a,b]=h.state().dnsGuards;
  assert.equal(a.sources[0].domain,'new-a.example.com');assert.equal(a.sources[0].id,'a-source');
  assert.equal(b.sources[0].backupDomain,'new-backup.example.com');assert.equal(b.sources[0].fallbackOnly,true);
  await run({action:'sources_remove',text:'extra.example.com\na-backup.example.com'});
  assert.deepEqual(h.state().dnsGuards.map(guard=>guard.sources.length),[1,1]);
  assert.equal(h.state().dnsGuards[0].sources[0].backupDomain,'');assert.equal(h.state().dnsGuards[1].sources[0].backupDomain,'new-backup.example.com');
});

test('per-rule DDNS replacement changes only mapped rules and rejects duplicate-domain collisions before mutation',async()=>{
  const h=harness(),beforeB=structuredClone(h.state().dnsGuards[1]);
  const preview=await h.preview({ids:['a','b'],action:'sources_replace',perRule:true,text:'a.example.com | a-new.example.com | - | 新来源'});
  assert.equal(preview.rows[0].status,'ready');assert.equal(preview.rows[1].status,'skipped');
  await h.apply(preview.id);
  assert.equal(h.state().dnsGuards[0].sources[0].domain,'a-new.example.com');assert.equal(h.state().dnsGuards[0].sources.length,1);
  assert.deepEqual(h.state().dnsGuards[1],beforeB);
  const bad=await h.preview({ids:['b'],action:'sources_add',text:'extra.example.com | b-source.example.com'});
  assert.equal(bad.rows[0].status,'failed');assert.match(bad.rows[0].message,/重复/);
});

test('IP append reads latest remote state, matches families and writes each rule without replacing other existing IPs',async()=>{
  const h=harness();
  h.mutate(state=>{state.dnsGuards[1].recordType='AAAA';state.dnsGuards.push({...structuredClone(state.dnsGuards[0]),id:'c',domain:'c.example.com'});});
  h.remote.set('b.example.com',['2001:db8::1']);h.remote.set('c.example.com',['192.0.2.1']);
  const before=structuredClone(h.state());
  const preview=await h.preview({ids:['a','b','c'],action:'ips_add',text:'192.0.2.10\n2001:db8::10'});
  assert.deepEqual(preview.rows.map(row=>row.after),[['192.0.2.1','192.0.2.10'],['2001:db8::1','2001:db8::10'],['192.0.2.1','192.0.2.10']]);
  assert.deepEqual(h.state(),before);assert.equal(h.writes.length,0);
  // Provider changes independently after preview. That rule must be skipped.
  h.remote.set('c.example.com',['192.0.2.99']);
  const result=await h.apply(preview.id);
  assert.deepEqual(result.rows.map(row=>row.status),['succeeded','succeeded','skipped']);
  assert.deepEqual(h.remote.get('a.example.com'),['192.0.2.1','192.0.2.10']);
  assert.deepEqual(h.remote.get('b.example.com'),['2001:db8::1','2001:db8::10']);
  assert.deepEqual(h.remote.get('c.example.com'),['192.0.2.99']);assert.equal(h.writes.length,2);
  assert.notEqual(h.state().dnsGuards[0].cycle?.id,'cycle-a','old probe checks are replaced');
  await processReadyDnsGuards(h.deps);assert.equal(h.writes.length,2);
});

test('configuration changes after preview, pending DNS confirmations and removed rules are skipped individually',async()=>{
  const h=harness();
  const preview=await h.preview({ids:['a','b'],action:'sources_enabled',enabled:false});
  h.mutate(state=>{state.dnsGuards[0].name='changed';state.dnsGuards[1].cycle={id:'pending',rebalanceCommit:{writeAttempted:true}};});
  const result=await h.apply(preview.id);assert.ok(result.rows.every(row=>row.status==='skipped'));
  assert.ok(h.state().dnsGuards.every(guard=>guard.sourcesEnabled));assert.equal(h.writes.length,0);
  const stale=await h.preview({ids:['a'],action:'enabled',enabled:false});
  h.mutate(state=>{state.dnsGuards=state.dnsGuards.filter(guard=>guard.id!=='a');});
  assert.equal((await h.apply(stale.id)).rows[0].status,'skipped');
});

test('reference changes keep per-rule selections and never permit zero probes; parameter edits validate each rule',async()=>{
  const h=harness({state:{probes:[{id:'p'},{id:'p2'}],ipPools:[{id:'pool'}]}});
  const preview=await h.preview({ids:['a','b'],action:'references',field:'probeIds',mode:'remove',values:['p']});
  assert.ok(preview.rows.every(row=>row.status==='failed'));assert.ok(h.state().dnsGuards.every(guard=>guard.probeIds.length===1));
  await h.apply((await h.preview({ids:['a'],action:'references',field:'probeIds',mode:'add',values:['p2']})).id);
  assert.deepEqual(h.state().dnsGuards[0].probeIds,['p','p2']);assert.deepEqual(h.state().dnsGuards[1].probeIds,['p']);
  await h.apply((await h.preview({ids:['a','b'],action:'settings',field:'interval',value:60})).id);
  assert.ok(h.state().dnsGuards.every(guard=>guard.interval===60));
});

test('job ownership, cancellation and duplicate execution are enforced by server',async()=>{
  const h=harness();
  const preview=await h.preview({ids:['a','b'],action:'enabled',enabled:false});
  await assert.rejects(h.read(preview.id,'other'),error=>error.statusCode===404);
  await assert.rejects(h.request('post','/api/dns-guards/batch/:jobId/apply',{}, {jobId:preview.id}),/确认/);
  await h.request('post','/api/dns-guards/batch/:jobId/cancel',{}, {jobId:preview.id});
  const result=await h.apply(preview.id);assert.ok(result.rows.every(row=>row.status==='canceled'));
  assert.ok(h.state().dnsGuards.every(guard=>guard.enabled));
});

test('bulk IP removal never clears other addresses and previewing a full pool cannot truncate the desired set',async()=>{
  const h=harness();h.remote.set('a.example.com',['192.0.2.1','192.0.2.2']);
  await h.apply((await h.preview({ids:['a'],action:'ips_remove',text:'192.0.2.1'})).id);
  assert.deepEqual(h.remote.get('a.example.com'),['192.0.2.2']);
  h.mutate(state=>{state.dnsGuards[0].maxActiveIps=1;});
  const tooMany=await h.preview({ids:['a'],action:'ips_add',text:'192.0.2.10'});
  assert.equal(tooMany.rows[0].status,'failed');assert.equal(h.writes.length,1);
});

test('remote-write lock waits for an ordinary in-flight write, then merges the actual record in preview',async()=>{
  const h=harness();let enter,release;const started=new Promise(resolve=>{enter=resolve;});
  const original=h.deps.writeDnsRecord;
  h.deps.writeDnsRecord=async(...args)=>{enter();await new Promise(resolve=>{release=resolve;});return original(...args);};
  const writing=h.request('put','/api/dns-guards/:id/remote-values',{values:['192.0.2.20']},{id:'a'});
  await started;
  const preparing=h.request('post','/api/dns-guards/batch/preview',{ids:['a'],action:'ips_add',text:'192.0.2.30'});
  const job=await preparing;assert.equal(job.status,'preparing');
  release();await writing;
  const preview=await h.settle(job.id);assert.deepEqual(preview.rows[0].before,['192.0.2.20']);
  assert.deepEqual(preview.rows[0].after,['192.0.2.20','192.0.2.30']);
});

test('background writes are bounded, idempotent, independent on failure, and cancellation preserves in-flight outcomes',async()=>{
  const guards=Array.from({length:6},(_,i)=>({id:String(i),name:`Rule ${i}`,domain:`r${i}.example.com`,recordType:'A',maxActiveIps:50}));
  let release,active=0,peak=0,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const service=createDnsGuardBatchService({readState:()=>({dnsGuards:guards}),readRemote:async()=>['192.0.2.1'],
    writeRemote:async id=>{calls++;active++;peak=Math.max(peak,active);await gate;active--;if(id==='1')throw Error('provider failed');return{verificationPending:id==='0'};}});
  const waitFor=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('job did not reach expected state');};
  const job=service.preview({ids:guards.map(guard=>guard.id),action:'ips_add',text:'192.0.2.2'},'tester');
  await waitFor(()=>service.read(job.id,'tester').status==='ready');
  service.apply(job.id,'tester','apply-dns-guard-batch');
  service.apply(job.id,'tester','apply-dns-guard-batch');
  assert.equal(calls,3);assert.equal(peak,3);
  service.cancel(job.id,'tester');release();
  await waitFor(()=>service.read(job.id,'tester').status==='done');
  const result=service.read(job.id,'tester');
  assert.deepEqual(result.rows.map(row=>row.status),['pending','failed','succeeded','canceled','canceled','canceled']);
  assert.equal(calls,3);assert.equal(result.cancelRequested,true);
  assert.ok(result.rows.every(row=>!('patch' in row)&&!('fingerprint' in row)));
  service.apply(job.id,'tester','apply-dns-guard-batch');assert.equal(calls,3);
});

test('IP changes after preview compare every remote value, including records beyond the 50-IP limit',async()=>{
  const h=harness(),values=Array.from({length:50},(_,i)=>`192.0.2.${i+1}`);
  h.remote.set('a.example.com',values);
  const preview=await h.preview({ids:['a'],action:'ips_remove',text:values[0]});
  assert.equal(preview.rows[0].status,'ready');
  h.remote.set('a.example.com',[...values,'192.0.2.99']);
  const result=await h.apply(preview.id);
  assert.equal(result.rows[0].status,'skipped');assert.equal(h.writes.length,0);
  assert.deepEqual(h.remote.get('a.example.com'),[...values,'192.0.2.99']);
});

test('domain-only per-rule DDNS input refuses ambiguous rules sharing one domain',async()=>{
  const h=harness();h.mutate(state=>{state.dnsGuards[1].domain='a.example.com';state.dnsGuards[1].recordType='AAAA';});
  const before=structuredClone(h.state());
  const preview=await h.preview({ids:['a','b'],action:'sources_replace',perRule:true,text:'a.example.com | new.example.com'});
  assert.ok(preview.rows.every(row=>row.status==='skipped'));
  assert.ok(preview.rows.every(row=>/同一域名|多条规则/.test(row.message)));
  assert.deepEqual(h.state(),before);
});

test('explicit rule identifiers keep A and AAAA DDNS sources separate on the same domain',async()=>{
  const h=harness();h.mutate(state=>{state.dnsGuards[1].domain='a.example.com';state.dnsGuards[1].recordType='AAAA';});
  const preview=await h.preview({ids:['a','b'],action:'sources_replace',perRule:true,
    text:'a.example.com#a | a-source.example.com | a-new-backup.example.com | IPv4 | source\na.example.com#b | b-source.example.com | b-new-backup.example.com | IPv6'});
  assert.ok(preview.rows.every(row=>row.status==='ready'));
  await h.apply(preview.id);
  const [a,b]=h.state().dnsGuards;
  assert.equal(a.sources.length,1);assert.equal(b.sources.length,1);
  assert.equal(a.sources[0].domain,'a-source.example.com');assert.equal(a.sources[0].name,'IPv4 | source');
  assert.equal(b.sources[0].domain,'b-source.example.com');assert.equal(b.sources[0].fallbackOnly,true);assert.equal(b.sources[0].id,'b-source');
  const absent=await h.preview({ids:['a'],action:'sources_replace',perRule:true,text:'a.example.com#b | other.example.com'});
  assert.equal(absent.rows[0].status,'skipped');
});

test('two batch jobs cannot concurrently write the same DNS record through different guards',async()=>{
  const guards=['a','b'].map(id=>({id,accountId:'account',domain:'same.example.com',recordType:'A',maxActiveIps:50}));
  let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  const service=createDnsGuardBatchService({readState:()=>({dnsGuards:guards}),readRemote:async()=>['192.0.2.1'],writeRemote:async()=>{calls++;await gate;return{};}});
  const waitFor=async(id,status)=>{for(let i=0;i<100;i++){const job=service.read(id,'tester');if(job.status===status)return job;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('job did not settle');};
  const first=service.preview({ids:['a'],action:'ips_add',text:'192.0.2.2'},'tester');await waitFor(first.id,'ready');
  const second=service.preview({ids:['b'],action:'ips_add',text:'192.0.2.3'},'tester');await waitFor(second.id,'ready');
  service.apply(first.id,'tester','apply-dns-guard-batch');service.apply(second.id,'tester','apply-dns-guard-batch');
  try{assert.equal(calls,1);}finally{release();}
  const result=await waitFor(second.id,'done');assert.equal(result.rows[0].status,'skipped');
  assert.equal((await waitFor(first.id,'done')).rows[0].status,'succeeded');
});

test('large configuration batches yield to incoming stop requests between rules',async()=>{
  const h=harness();h.mutate(state=>{for(const id of ['c','d','e','f'])state.dnsGuards.push({...structuredClone(state.dnsGuards[0]),id,domain:`${id}.example.com`});});
  const preview=await h.preview({ids:['a','b','c','d','e','f'],action:'sources_enabled',enabled:false});
  const canceled=new Promise((resolve,reject)=>setImmediate(()=>h.request('post','/api/dns-guards/batch/:jobId/cancel',{}, {jobId:preview.id}).then(resolve,reject)));
  const applying=h.apply(preview.id);await canceled;const result=await applying;
  assert.equal(result.counts.succeeded,3);assert.equal(result.counts.canceled,3);
  assert.equal(h.state().dnsGuards.filter(guard=>guard.sourcesEnabled===false).length,3);
});
