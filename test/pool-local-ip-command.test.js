import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { poolLocalIpCommand } from '../shared/pool-local-ip-command.js';

test('copied local commands run in sh, discover only the requested family, fall back safely and send the pool key only to the panel',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nurows-local-ip-command-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const log=path.join(directory,'calls.jsonl');
  const fakeCurl=`#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2);
if(args.includes('POST')){
  fs.appendFileSync(process.env.POOL_COMMAND_LOG,JSON.stringify({args,body:fs.readFileSync(0,'utf8')})+'\\n');
  process.stdout.write(process.env.POOL_UPLOAD_ERROR?'rejected':'{"ok":true}');
  process.exit(process.env.POOL_UPLOAD_ERROR?22:0);
}
fs.appendFileSync(process.env.POOL_COMMAND_LOG,JSON.stringify({args})+'\\n');
const family=args.includes('-4')?'ipv4':'ipv6';
if(process.env.POOL_LOOKUP_FAIL==='all')process.exit(7);
if(process.env.POOL_LOOKUP_FAIL==='partial'&&args.at(-1).includes('ipify')){process.stdout.write(family==='ipv4'?'192.0.2.99':'2001:db8::99');process.exit(28);}
if(process.env.POOL_LOOKUP_FAIL==='html'&&args.at(-1).includes('ipify')){process.stdout.write('<html>unavailable</html>');process.exit(0);}
if(process.env.POOL_LOOKUP_FAIL==='wrong-family'){process.stdout.write(family==='ipv4'?'2001:db8::1':'192.0.2.1');process.exit(0);}
process.stdout.write(family==='ipv4'?'192.0.2.10\\r\\n':'2001:db8::10\\r\\n');
`;
  await fs.writeFile(path.join(directory,'curl'),fakeCurl,{mode:0o700});
  // Shell metacharacters in an endpoint remain literal, including in heredocs.
  const endpoint="https://panel.example.com/api/external/ip-pools/a/ips?label=a'b&x=$(echo INJECTED)",token='pool-secret';
  for(const family of ['ipv4','ipv6'])for(const failure of ['', 'html','partial','all','wrong-family']){
    await fs.writeFile(log,'');
    const command=poolLocalIpCommand(endpoint,token,family);
    const result=spawnSync('sh',[],{input:command,encoding:'utf8',timeout:5000,env:{...process.env,PATH:directory+path.delimiter+process.env.PATH,POOL_COMMAND_LOG:log,POOL_LOOKUP_FAIL:failure}});
    assert.ifError(result.error);
    const calls=(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const lookups=calls.filter(call=>!call.args.includes('POST')),uploads=calls.filter(call=>call.args.includes('POST'));
    assert.equal(lookups.length,failure?2:1);
    for(const lookup of lookups){
      assert.ok(lookup.args.includes(family==='ipv4'?'-4':'-6'));
      assert.ok(!lookup.args.includes('-H'));assert.ok(!JSON.stringify(lookup).includes(token));
      assert.ok(lookup.args.includes('--noproxy'));assert.ok(lookup.args.includes('--max-time'));
    }
    if(['all','wrong-family'].includes(failure)){
      assert.equal(result.status,1);assert.equal(uploads.length,0);assert.match(result.stderr,/未向备用池提交/);
    }else{
      assert.equal(result.status,0,result.stderr);assert.equal(uploads.length,1);
      const upload=uploads[0];
      assert.ok(upload.args.includes(endpoint));assert.ok(upload.args.includes(`Authorization: Bearer ${token}`));
      assert.equal(upload.body,family==='ipv4'?'192.0.2.10\n':'2001:db8::10\n');
      assert.ok(!result.stdout.includes('INJECTED'));assert.ok(!result.stdout.includes(token));
    }
  }
  const rejected=spawnSync('sh',[],{input:poolLocalIpCommand(endpoint,token,'ipv4'),encoding:'utf8',timeout:5000,
    env:{...process.env,PATH:directory+path.delimiter+process.env.PATH,POOL_COMMAND_LOG:log,POOL_LOOKUP_FAIL:'',POOL_UPLOAD_ERROR:'1'}});
  assert.equal(rejected.status,22,'HTTP rejection must not report success');
});

test('missing curl is installed with the detected package manager before lookup; permission and installation failures never submit',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nurows-local-ip-bootstrap-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const script=`#!${process.execPath}
const fs=require('fs'),path=require('path');
const name=path.basename(process.argv[1]),args=process.argv.slice(2);
if(name==='id'){process.stdout.write(process.env.POOL_FAKE_UID||'0');process.exit(0);}
if(name==='sudo'){
  fs.appendFileSync(process.env.POOL_BOOTSTRAP_LOG,JSON.stringify({name,args})+'\\n');
  const child=require('child_process').spawnSync(args[0],args.slice(1),{stdio:'inherit'});process.exit(child.status??1);
}
if(name==='curl'){
  fs.appendFileSync(process.env.POOL_BOOTSTRAP_LOG,JSON.stringify({name,args,body:args.includes('POST')?fs.readFileSync(0,'utf8'):''})+'\\n');
  process.stdout.write(args.includes('POST')?'{"ok":true}':args.includes('-4')?'192.0.2.10':'2001:db8::10');process.exit(0);
}
fs.appendFileSync(process.env.POOL_BOOTSTRAP_LOG,JSON.stringify({name,args})+'\\n');
if(process.env.POOL_INSTALL_FAIL==='1')process.exit(1);
if(args.includes('curl'))fs.copyFileSync(__filename,path.join(path.dirname(__filename),'curl'));
`;
  const cases=[...['apt-get','dnf','yum','apk','zypper','pacman'].map(manager=>({manager})),
    {manager:'apt-get',sudo:true},{manager:'dnf',fail:true},{manager:'apt-get',noPermission:true},{manager:''},
    {manager:'apt-get',installed:true}];
  for(const [index,scenario] of cases.entries()){
    const directory=path.join(root,String(index));await fs.mkdir(directory);
    const log=path.join(directory,'calls.jsonl');await fs.writeFile(log,'');
    // Deliberately exclude the host's package managers. Every install here is
    // simulated inside a temporary directory; none can affect the host.
    for(const [name,target] of [['sh','/bin/sh'],['tr','/usr/bin/tr'],['env','/usr/bin/env']])await fs.symlink(target,path.join(directory,name));
    for(const name of ['id',scenario.manager,scenario.sudo?'sudo':'',scenario.installed?'curl':''].filter(Boolean))await fs.writeFile(path.join(directory,name),script,{mode:0o700});
    const result=spawnSync('/bin/sh',[],{input:poolLocalIpCommand('https://panel.example.com/api/external/ip-pools/a/ips','pool-secret','ipv4'),encoding:'utf8',timeout:5000,
      env:{...process.env,PATH:directory,POOL_BOOTSTRAP_LOG:log,POOL_FAKE_UID:scenario.sudo||scenario.noPermission?'1000':'0',POOL_INSTALL_FAIL:scenario.fail?'1':''}});
    assert.ifError(result.error);
    const calls=(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const curlCalls=calls.filter(call=>call.name==='curl');
    if(scenario.fail||scenario.noPermission||!scenario.manager){
      assert.equal(result.status,1);assert.equal(curlCalls.length,0);assert.match(result.stderr,/未向备用池提交/);
    }else{
      assert.equal(result.status,0,result.stderr);assert.equal(curlCalls.length,2);
      if(scenario.installed)assert.equal(calls.filter(call=>call.name===scenario.manager).length,0,'existing curl never installs packages');
      else{
        const install=calls.find(call=>call.name===scenario.manager&&call.args.includes('curl'));
        assert.ok(install);assert.ok(install.args.includes('ca-certificates'));
        assert.ok(calls.indexOf(install)<calls.indexOf(curlCalls[0]));
        if(scenario.manager==='apt-get')assert.deepEqual(calls.find(call=>call.name==='apt-get').args,['update']);
        if(scenario.sudo)assert.ok(calls.some(call=>call.name==='sudo'));
      }
    }
  }
});
