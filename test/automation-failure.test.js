import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { automationJobFailure } from '../server/automation-failure.js';

test('automation failure summaries include the host and useful cause without terminal output',()=>{
  const job={results:[
    {host:'192.0.2.1',status:'error',ok:false,error:'Timed out while waiting for handshake',stdout:'password-secret'},
    {host:'192.0.2.2',status:'done',ok:false,exitCode:7,stderr:'private-token'},
    {host:'192.0.2.3',status:'error',ok:false,error:'All configured authentication methods failed'},
    {host:'192.0.2.4',status:'done',ok:true,exitCode:0}
  ]};
  const message=automationJobFailure(job);
  assert.match(message,/3 台执行失败/);assert.match(message,/192.0.2.1：SSH 握手超时/);
  assert.match(message,/192.0.2.2：命令退出码 7/);assert.match(message,/192.0.2.3：SSH 认证失败/);
  assert.ok(!message.includes('password-secret'));assert.ok(!message.includes('private-token'));assert.ok(!message.includes('192.0.2.4'));
});

test('automation wait timeouts retain pending and interactive details before cancellation overwrites them',async()=>{
  const source=fs.readFileSync(new URL('../server/index.js',import.meta.url),'utf8');
  const job={results:[{host:'192.0.2.1',status:'running',awaitingInput:true},{host:'192.0.2.2',status:'queued'}]};
  let poll,now=0,cancelled=0;
  const wait=vm.runInNewContext(`(${source.slice(source.indexOf('function waitForAutomationJob('),source.indexOf('\nfunction checkProbePresence('))})`,{
    commandJobs:new Map([['job',job]]),automationJobFailure,
    Date:{now:()=>now},setInterval:callback=>{poll=callback;return 1;},clearInterval(){},
    cancelCommandJob:()=>{cancelled++;for(const item of job.results){item.error='已取消';item.awaitingInput=false;item.status='error';}}
  });
  const waiting=wait('job',30);now=31000;poll();
  await assert.rejects(waiting,error=>{
    assert.match(error.message,/等待超时（30 秒）/);assert.match(error.message,/192.0.2.1：等待交互输入/);assert.match(error.message,/192.0.2.2：仍在等待执行名额/);return true;
  });
  assert.equal(cancelled,1);
  job.results=[{host:'192.0.2.8',status:'done',ok:false,exitCode:22}];
  const failed=wait('job');poll();await assert.rejects(failed,/192.0.2.8：命令退出码 22/);
  job.results=[{host:'192.0.2.8',status:'done',ok:true,exitCode:0}];
  const succeeded=wait('job');poll();assert.equal(await succeeded,job.results);
});

test('failed incident notifications show the detailed failure instead of the generic failed-state label',async()=>{
  const source=fs.readFileSync(new URL('../server/index.js',import.meta.url),'utf8'),sent=[];
  const incident={id:'incident',status:'failed',targetName:'主站',message:'执行失败',error:'DNS 更新：华为云 DNS API 查询超时（单次 20 秒，已尝试 2 次）'};
  const notify=vm.runInNewContext(`(${source.slice(source.indexOf('function notifyIncidentViaTelegram('),source.indexOf('\nasync function notifyDynamicGuardViaTelegram('))})`,{
    readState:()=>({incidents:[incident],telegramBots:[{enabled:true,tokenEnc:'encrypted',userIds:['1']}]}),
    STATUS_LABELS:{failed:'失败',succeeded:'成功'},telegramNotice:(_title,lines)=>lines.join('\n'),
    telegramNoticeValue:(value,fallback)=>value||fallback,telegramNoticeTime:()=>'',decryptSecret:()=>'',
    sendTelegramNotice:async(_token,_chatId,message)=>{sent.push(message);}
  });
  notify('incident');assert.ok(sent[0].includes(incident.error));assert.ok(!sent[0].includes('说明：执行失败'));
  incident.status='succeeded';incident.message='故障切换完成';incident.error='';
  notify('incident');assert.ok(sent[1].includes('故障切换完成'));
});
