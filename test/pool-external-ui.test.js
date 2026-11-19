import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { poolLocalIpCommand } from '../shared/pool-local-ip-command.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/PoolExternalAccessDialog.jsx', import.meta.url),'utf8'),
  {loader:'jsx',format:'cjs',jsx:'automatic'}).code;
const configuration = (id='a',token='secret-a',enabled=true)=>({poolId:id,path:`/api/external/ip-pools/${id}/ips`,token,
  access:{externalApiEnabled:enabled,externalApiConfigured:true,externalTokenUpdatedAt:'2026-11-19T01:00:00Z'}});

function harness(api) {
  const slots=[],effects=[],copies=[],updates=[],messages=[];
  let cursor=0,tree;
  const props={pool:{id:'a',name:'池 A'},api,toast:message=>messages.push(message),onChange:access=>updates.push(access),onClose(){},Dialog:'dialog'};
  const jsx=(type,props)=>({type,props}),module={exports:{}};
  const useState=initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];};
  vm.runInNewContext(compiled,{module,exports:module.exports,AbortController,URL,window:{location:{origin:'https://panel.example.com'}},require(path){
    if(path==='react')return {useState,useRef:initial=>useState({current:initial})[0],useEffect(fn,deps){const i=cursor++,previous=slots[i];if(!previous||deps.some((value,j)=>value!==previous.deps[j]))effects.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
    if(path==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(path==='lucide-react')return Object.fromEntries(['Check','Copy','Eye','EyeOff','KeyRound','Link','LoaderCircle','RefreshCw','Terminal'].map(name=>[name,'svg']));
    if(path.endsWith('note-clipboard.js'))return {copyNoteText:async text=>copies.push(text)};
    if(path.endsWith('pool-local-ip-command.js'))return {poolLocalIpCommand};
    throw Error(path);
  }});
  const render=()=>{cursor=0;tree=module.exports.default(props);while(effects.length)effects.shift()();};
  const nodes=(value=tree)=>Array.isArray(value)?value.flatMap(nodes):!value||typeof value!=='object'?[]:[value,...nodes(value.props?.children ?? null),...nodes(value.props?.footer ?? null)];
  const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):String(value??'');
  const button=label=>nodes().find(node=>node.type==='button'&&(text(node)===label||node.props['aria-label']===label));
  const input=label=>nodes().find(node=>node.type==='input'&&node.props['aria-label']===label);
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));render();};
  render();
  return {props,render,nodes,text,button,input,settle,copies,updates,messages,unmount(){for(const value of slots)value?.cleanup?.();}};
}

test('pool dialog masks credentials but copies complete single, multiple and text commands for the right pool',async()=>{
  const view=harness(async()=>configuration());await view.settle();
  assert.equal(view.input('本池调用密钥').props.type,'password');
  assert.equal(view.input('调用地址').props.value,'https://panel.example.com/api/external/ip-pools/a/ips');
  assert.ok(!view.text(view.nodes().find(node=>node.type==='pre')).includes('secret-a'));
  for(const [label,expected] of [['单个 IP','"ip":"192.0.2.10"'],['多个 IP','"ips":['],['文本文件','--data-binary @ips.txt']]){
    view.button(label).props.onClick();view.render();
    await view.button('复制命令').props.onClick();
    assert.ok(view.copies.at(-1).includes('Authorization: Bearer secret-a'));
    assert.ok(view.copies.at(-1).includes(expected));
    assert.ok(view.copies.at(-1).includes(' \\\n'), 'curl line continuations are real newlines');
  }
  await view.button('复制调用密钥').props.onClick();assert.equal(view.copies.at(-1),'secret-a');
  view.button('显示密钥').props.onClick();view.render();assert.equal(view.input('本池调用密钥').props.type,'text');
  assert.ok(view.text(view.nodes().find(node=>node.type==='pre')).includes('secret-a'));
});

test('rotation confirms before sending, prevents duplicate submissions and replaces all copied credentials',async()=>{
  const calls=[];let finish;
  const view=harness((path,options)=>{calls.push({path,options});return options.method==='POST'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(configuration());});
  await view.settle();view.button('轮换密钥').props.onClick();view.render();assert.equal(calls.length,1);
  view.button('取消').props.onClick();view.render();assert.equal(calls.length,1);
  view.button('轮换密钥').props.onClick();view.render();
  const confirm=view.button('确认轮换').props.onClick;
  const pending=confirm();await confirm();view.render();
  assert.equal(calls.length,2);assert.equal(calls[1].path,'/api/ip-pools/a/external-access/rotate-token');
  assert.equal(view.button('复制命令').props.disabled,true);
  finish(configuration('a','new-key'));await pending;view.render();
  assert.equal(view.input('本池调用密钥').props.value,'new-key');assert.equal(view.input('本池调用密钥').props.type,'password');
  await view.button('复制命令').props.onClick();assert.ok(view.copies.at(-1).includes('Bearer new-key'));assert.ok(!view.copies.at(-1).includes('secret-a'));
});

test('local IPv4 and IPv6 have separate commands and use the current pool key after rotation',async()=>{
  let token='secret-a';
  const view=harness(async(_path,options)=>{if(options.method==='POST')token='rotated-key';return configuration('a',token);});
  await view.settle();
  for(const [label,version,other] of [['本机 IPv4',4,6],['本机 IPv6',6,4]]){
    view.button(label).props.onClick();view.render();
    const preview=view.text(view.nodes().find(node=>node.type==='pre'));
    assert.ok(preview.includes(`curl -q -${version}`));assert.ok(!preview.includes(`curl -q -${other}`));
    assert.ok(!preview.includes('secret-a'));
    await view.button('复制命令').props.onClick();
    assert.equal(view.copies.at(-1),poolLocalIpCommand('https://panel.example.com/api/external/ip-pools/a/ips','secret-a',version===4?'ipv4':'ipv6'));
  }
  view.button('轮换密钥').props.onClick();view.render();
  await view.button('确认轮换').props.onClick();view.render();
  await view.button('复制命令').props.onClick();
  assert.ok(view.copies.at(-1).includes('Bearer rotated-key'));assert.ok(!view.copies.at(-1).includes('secret-a'));
});

test('late credentials never cross pool selection and closed dialogs ignore an in-flight rotation',async()=>{
  const pending=[];
  const view=harness((path,options)=>new Promise(resolve=>pending.push({path,options,resolve})));
  view.props.pool={id:'b',name:'池 B'};view.render();
  assert.equal(pending[0].options.signal.aborted,true);
  pending[0].resolve(configuration());await view.settle();assert.equal(view.input('本池调用密钥'),undefined);
  pending[1].resolve(configuration('b','secret-b'));await view.settle();assert.equal(view.input('本池调用密钥').props.value,'secret-b');
  assert.equal(view.updates.length,1);
  view.button('轮换密钥').props.onClick();view.render();const operation=view.button('确认轮换').props.onClick();
  view.unmount();pending[2].resolve(configuration('b','rotated-b'));await operation;
  assert.equal(view.updates.length,1);assert.equal(view.messages.length,0);
});

test('disable/enable keeps the key; ambiguous rotation failure hides it until a fresh read',async()=>{
  const calls=[];let failRotation=true;
  const view=harness(async(path,options)=>{
    calls.push({path,options});
    if(options.method==='PUT')return {access:{externalApiEnabled:JSON.parse(options.body).enabled}};
    if(options.method==='POST'&&failRotation){failRotation=false;throw Error('连接已断开');}
    return configuration('a',failRotation?'secret-a':'actually-rotated');
  });await view.settle();
  await view.button('停用调用').props.onClick();view.render();
  assert.equal(JSON.parse(calls.at(-1).options.body).enabled,false);assert.ok(view.button('启用调用'));
  assert.equal(view.input('本池调用密钥').props.value,'secret-a');
  await view.button('启用调用').props.onClick();view.render();
  view.button('轮换密钥').props.onClick();view.render();await view.button('确认轮换').props.onClick();view.render();
  assert.equal(view.button('复制命令'),undefined);assert.equal(view.input('本池调用密钥'),undefined);
  view.button('重新读取').props.onClick();view.render();await view.settle();
  assert.equal(view.input('本池调用密钥').props.value,'actually-rotated');
});
