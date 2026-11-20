import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import http from 'node:http';
import { dnsProviderRequest, DNS_PROVIDER_TIMEOUT_MS } from '../server/dns-provider-request.js';

const success = () => new Response('{"values":["192.0.2.1"]}', { status: 200 });
function runtime(sequence) {
  const calls = [], waits = [], signals = [], deadlines = [];
  return { calls, waits, signals, deadlines,
    fetch: async (...args) => { calls.push(args); const value = sequence.shift(); if (value instanceof Error) throw value; return value; },
    wait: async ms => { waits.push(ms); },
    timeout: ms => { deadlines.push(ms); const signal=new AbortController().signal; signals.push(signal); return signal; }
  };
}
test('transient DNS reads retry once with a fresh deadline and keep their original request intact', async () => {
  for (const failure of [new DOMException('The operation was aborted due to timeout','TimeoutError'),
    Object.assign(Error('fetch failed'),{cause:{code:'ECONNRESET'}}),new Response('temporarily unavailable',{status:503})]) {
    const run=runtime([failure,success()]),options={method:'POST',headers:{authorization:'secret'},body:'signed-read'};
    const result=await dnsProviderRequest('https://provider.example/',options,{provider:'测试商',readOnly:true},run);
    assert.deepEqual(result.payload,{values:['192.0.2.1']});assert.equal(run.calls.length,2);
    assert.deepEqual(run.waits,[500]);assert.deepEqual(run.deadlines,[20000,20000]);
    assert.notEqual(run.signals[0],run.signals[1]);assert.equal(options.signal,undefined);
    assert.equal(run.calls[1][1].body,'signed-read');assert.equal(run.calls[1][1].headers.authorization,'secret');
  }
});

test('DNS write timeouts are never blindly retried and errors identify the provider without credentials or signed URLs', async () => {
  for (const method of ['GET','POST','PUT','DELETE']) {
    const run=runtime([new DOMException('The operation was aborted due to timeout','TimeoutError'),success()]);
    await assert.rejects(dnsProviderRequest('https://dns.example/?Signature=private-signature',{method,headers:{authorization:'private-key'}},
      {provider:'阿里云',readOnly:false},run),error=>{
      assert.match(error.message,/阿里云.*写入超时.*20 秒.*写入结果待确认/);
      assert.ok(!error.message.includes('private'));return true;
    });
    assert.equal(run.calls.length,1);assert.deepEqual(run.waits,[]);
  }
  const twice=runtime([new DOMException('timeout','TimeoutError'),new DOMException('timeout','TimeoutError')]);
  await assert.rejects(dnsProviderRequest('https://dns.example/',{}, {provider:'华为云',readOnly:true},twice),/华为云.*查询超时.*已尝试 2 次/);
  const network=runtime([Object.assign(Error('fetch failed'),{cause:{code:'ECONNRESET'}})]);
  await assert.rejects(dnsProviderRequest('https://dns.example/',{}, {provider:'华为云'},network),/连接失败.*写入结果待确认/);
  const unavailable=runtime([new Response('{"error":"unavailable"}',{status:503}),success()]);
  assert.equal((await dnsProviderRequest('https://dns.example/',{}, {provider:'华为云'},unavailable)).response.status,503);
  assert.equal(unavailable.calls.length,1,'write status 503 must not be retried either');
});

test('permission, rate limit and invalid JSON do not trigger repeated provider calls; empty write acknowledgements remain valid', async () => {
  for(const status of [400,401,403,404,429]) {
    const run=runtime([new Response('{"error":"denied"}',{status}),success()]);
    const result=await dnsProviderRequest('https://dns.example/',{}, {provider:'测试商',readOnly:true},run);
    assert.equal(result.response.status,status);assert.equal(run.calls.length,1);
  }
  const invalid=runtime([new Response('<html>bad gateway</html>',{status:200}),success()]);
  await assert.rejects(dnsProviderRequest('https://dns.example/',{}, {provider:'测试商',readOnly:true},invalid),/无效 JSON/);
  assert.equal(invalid.calls.length,1);
  for(const status of [200,204]) {
    const run=runtime([new Response(status===204?null:'',{status})]);
    assert.deepEqual((await dnsProviderRequest('https://dns.example/',{}, {provider:'测试商'},run)).payload,{});
  }
});

test('a stalled HTTP response body obeys the deadline and cannot be mistaken for a successful DNS write', async t => {
  let calls=0;
  const server=http.createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.write('{"partial":');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  for(const readOnly of [true,false]) {
    const before=calls;
    await assert.rejects(dnsProviderRequest(`http://127.0.0.1:${server.address().port}/`,{method:readOnly?'GET':'PUT'},
      {provider:'慢响应服务商',readOnly},{timeout:()=>AbortSignal.timeout(100),wait:async()=>{}}),/慢响应服务商.*超时/);
    assert.equal(calls-before,readOnly?2:1);
  }
  assert.equal(DNS_PROVIDER_TIMEOUT_MS,20000);
});

test('provider adapters classify RPC reads separately from mutations, including writes sent over GET', async () => {
  const source=fs.readFileSync(new URL('../server/orchestration.js',import.meta.url),'utf8'),calls=[];
  const adapters=vm.runInNewContext(source.slice(source.indexOf('async function cloudflareRequest('),source.indexOf('\nexport function normalizeRecordName('))+
    '\n({cloudflareRequest,huaweiRequest,aliyunRequest,tencentRequest,dnspodRequest,godaddyRequest,porkbunRequest,cloudnsRequest,callbackRequest})',{
    crypto,URL,URLSearchParams,uuidv4:()=>crypto.randomUUID(),
    sha256:value=>crypto.createHash('sha256').update(value).digest('hex'),hmac:(key,value)=>crypto.createHmac('sha256',key).update(value).digest(),percentEncode:encodeURIComponent,
    cleanText:value=>String(value||''),dns:{lookup:async()=>[{address:'192.0.2.1'}]},isPrivateAddress:()=>false,
    dnsProviderRequest:async(url,options,policy)=>{
      calls.push({url:String(url),options,policy});
      const payload=policy.provider==='DNSPod'?{status:{code:'1'}}:policy.provider==='Porkbun'?{status:'SUCCESS'}:{success:true};
      return {response:{ok:true,status:200},payload};
    }
  });
  const credentials={endpoint:'https://callback.example/'},account={};
  for(const [name,args,readOnly] of [
    ['cloudflareRequest',[credentials,'GET','/zones'],true],['cloudflareRequest',[credentials,'POST','/records',{}],false],
    ['huaweiRequest',[account,credentials,'GET','/v2/zones'],true],['huaweiRequest',[account,credentials,'PUT','/v2/records',{}],false],
    ['aliyunRequest',[credentials,'DescribeDomains'],true],['aliyunRequest',[credentials,'AddDomainRecord'],false],
    ['tencentRequest',[credentials,'DescribeRecord'],true],['tencentRequest',[credentials,'ModifyRecord'],false],
    ['dnspodRequest',[credentials,'Record.List'],true],['dnspodRequest',[credentials,'Record.Modify'],false],
    ['godaddyRequest',[credentials,'GET','/domains'],true],['godaddyRequest',[credentials,'DELETE','/records'],false],
    ['porkbunRequest',[credentials,'/api/json/v3/dns/retrieve/example.com'],true],['porkbunRequest',[credentials,'/api/json/v3/dns/create/example.com'],false],
    ['cloudnsRequest',[credentials,'/dns/records.json'],true],['cloudnsRequest',[credentials,'/dns/add-record.json','POST',{}],false],
    ['callbackRequest',[account,credentials,{action:'zones'}],true],['callbackRequest',[account,credentials,{action:'read'}],true],['callbackRequest',[account,credentials,{action:'write'}],false]
  ]) {
    await adapters[name](...args);assert.equal(calls.at(-1).policy.readOnly,readOnly,`${name}: ${JSON.stringify(args)}`);
  }
});
