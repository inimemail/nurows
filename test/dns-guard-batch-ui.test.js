import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as batch from '../shared/dns-guard-batch.js';
const compiled=transformSync(fs.readFileSync(new URL('../src/DnsGuardBatchDialog.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs',jsx:'automatic'}).code;
function harness(api){
  const slots=[],effects=[],copies=[],messages=[],polls=[];let cursor=0,tree,finished=0;
  const props={state:{dnsGuards:[
    {id:'a',name:'Alpha',domain:'a.example.com',recordType:'A',sources:[{id:'s1',domain:'a-source.example.com',backupDomain:'a-backup.example.com',name:'来源 A'}]},
    {id:'b',name:'Beta',domain:'b.example.com',recordType:'AAAA',sources:[{id:'s2',domain:'b-source.example.com',name:'来源 B'}]}
  ],probes:[{id:'p',name:'探针'}],ipPools:[],telegramBots:[]},api,Dialog:'dialog',toast:message=>messages.push(message),onFinished:()=>{finished++;},onClose(){}};
  const jsx=(type,props)=>({type,props}),module={exports:{}};
  const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];};
  vm.runInNewContext(compiled,{module,exports:module.exports,require(path){
    if(path==='react')return{useState,useMemo:fn=>fn(),useRef:initial=>useState({current:initial})[0],useEffect(fn,deps){const i=cursor++,prev=slots[i];if(!prev||deps.some((value,j)=>value!==prev.deps[j]))effects.push(()=>{prev?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
    if(path==='react/jsx-runtime')return{jsx,jsxs:jsx};
    if(path==='lucide-react')return Object.fromEntries(['Search','Layers','LoaderCircle','Check','Copy','ArrowRight','SlidersHorizontal'].map(name=>[name,'svg']));
    if(path.endsWith('dns-guard-batch.js'))return batch;
    if(path.endsWith('note-clipboard.js'))return{copyNoteText:async text=>copies.push(text)};
    if(path.endsWith('polling.js'))return{startPolling(fn,interval,options){const poll={fn,interval,options,stopped:false};polls.push(poll);return()=>{poll.stopped=true;};}};
    throw Error(path);
  }});
  const render=()=>{cursor=0;tree=module.exports.default(props);while(effects.length)effects.shift()();};
  const nodes=(value=tree)=>Array.isArray(value)?value.flatMap(child=>nodes(child??null)):!value||typeof value!=='object'?[]:[value,...nodes(value.props?.children??null),...nodes(value.props?.footer??null)];
  const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):String(value??'');
  const button=label=>nodes().find(node=>node.type==='button'&&(text(node).trim()===label||text(node).startsWith(label)));
  const field=label=>nodes().find(node=>node.props?.['aria-label']===label);
  const checks=()=>nodes().filter(node=>node.type==='input'&&node.props.type==='checkbox');
  const set=(label,value)=>{field(label).props.onChange({target:{value}});render();};
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));render();};
  render();return{props,render,nodes,text,button,field,checks,set,settle,polls,copies,messages,finished:()=>finished};
}
const preview=()=>({id:'job',action:'ips_add',status:'ready',counts:{ready:1},rows:[{id:'a',name:'Alpha',domain:'a.example.com',status:'ready',before:['192.0.2.1'],after:['192.0.2.1','192.0.2.2'],message:'待确认'}]});

test('advanced selection supports search/select/invert and requires a current preview before apply',async()=>{
  const calls=[];const view=harness(async(path,options)=>{calls.push({path,options});return preview();});
  assert.equal(view.button('预览更改').props.disabled,true);
  view.set('搜索守护规则','Alpha');view.button('全选搜索结果').props.onClick();view.render();
  view.set('搜索守护规则','');assert.equal(view.checks()[0].props.checked,true);assert.equal(view.checks()[1].props.checked,false);
  view.set('批量操作内容','192.0.2.2');await view.button('预览更改').props.onClick();view.render();
  assert.deepEqual(JSON.parse(calls[0].options.body),{ids:['a'],action:'ips_add',text:'192.0.2.2'});
  assert.equal(view.button('确认执行').props.disabled,false);
  view.set('批量操作内容','192.0.2.3');assert.equal(view.button('确认执行').props.disabled,true);
  view.button('反选').props.onClick();view.render();assert.equal(view.checks()[0].props.checked,false);assert.equal(view.checks()[1].props.checked,true);
});

test('DDNS per-rule input and copied existing sources preserve different rule domains',async()=>{
  const calls=[],view=harness(async(path,options)=>{calls.push({path,options});return {...preview(),action:'sources_replace'};});
  view.button('全选搜索结果').props.onClick();view.render();
  view.set('操作类型','sources_replace');
  await view.button('复制所选规则的现有来源').props.onClick();
  view.render();assert.equal(view.field('来源输入方式').props.value,'per-rule');
  assert.equal(view.copies[0],'a.example.com#a | a-source.example.com | a-backup.example.com | 来源 A\nb.example.com#b | b-source.example.com | - | 来源 B');
  view.set('批量操作内容',view.copies[0]);await view.button('预览更改').props.onClick();view.render();
  const body=JSON.parse(calls[0].options.body);assert.equal(body.perRule,true);assert.deepEqual(body.ids,['a','b']);
});

test('background execution disables edits, prevents repeated apply and surfaces partial results and retry selection',async()=>{
  let resolveApply;const calls=[];
  const view=harness((path,options)=>{calls.push({path,options});if(path.endsWith('/apply'))return new Promise(resolve=>{resolveApply=resolve;});return Promise.resolve(path.endsWith('/preview')?preview():{
    ...preview(),status:'done',counts:{failed:1,succeeded:0},rows:[{...preview().rows[0],status:'failed',message:'连接失败'}]});});
  view.checks()[0].props.onChange();view.render();view.set('批量操作内容','192.0.2.2');
  await view.button('预览更改').props.onClick();view.render();
  const apply=view.button('确认执行').props.onClick,pending=apply();await apply();view.render();assert.equal(calls.length,2);
  resolveApply({...preview(),status:'applying',counts:{applying:1}});await pending;view.render();
  assert.equal(view.field('操作类型').props.disabled,true);assert.ok(view.checks().every(node=>node.props.disabled));
  view.props.open=false;view.render();assert.equal(view.nodes().length,0);
  const poll=view.polls.at(-1);await poll.fn(new AbortController().signal);view.render();
  view.props.open=true;view.render();
  assert.equal(view.finished(),1);assert.ok(view.text(view.nodes()).includes('连接失败'));
  view.button('仅选择失败 / 跳过项重试').props.onClick();view.render();
  assert.equal(view.checks()[0].props.checked,true);assert.equal(view.button('确认执行').props.disabled,true);
});

test('a lost apply response reconciles the existing job without resubmitting writes',async()=>{
  const calls=[];
  const view=harness(async(path,options)=>{
    calls.push(path);
    if(path.endsWith('/apply'))throw new Error('Network error');
    return path.endsWith('/preview')?preview():{...preview(),status:'done',counts:{succeeded:1},rows:[{...preview().rows[0],status:'succeeded'}]};
  });
  view.checks()[0].props.onChange();view.render();view.set('批量操作内容','192.0.2.2');
  await view.button('预览更改').props.onClick();view.render();
  await view.button('确认执行').props.onClick();view.render();
  assert.equal(view.button('确认执行').props.disabled,true);
  assert.ok(view.text(view.nodes()).includes('正在核对任务状态'));
  await view.polls.at(-1).fn(new AbortController().signal);view.render();
  assert.equal(view.finished(),1);assert.equal(calls.filter(path=>path.endsWith('/apply')).length,1);
  assert.equal(view.button('预览更改').props.disabled,false);
});

test('expired jobs after a service restart release controls and allow a fresh preview',async()=>{
  const view=harness(async()=>({...preview(),status:'preparing'}));
  view.checks()[0].props.onChange();view.render();view.set('批量操作内容','192.0.2.2');
  await view.button('预览更改').props.onClick();view.render();
  assert.equal(view.button('预览更改').props.disabled,true);
  view.polls.at(-1).options.onError(Object.assign(Error('批量任务不存在或已过期'),{status:404}));view.render();
  assert.equal(view.button('预览更改').props.disabled,false);
  assert.equal(view.field('批量操作内容').props.value,'192.0.2.2');
  assert.ok(view.text(view.nodes()).includes('批量任务不存在或已过期'));
  assert.equal(view.checks()[0].props.checked,true);
});
