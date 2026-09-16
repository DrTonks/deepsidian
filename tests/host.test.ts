import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('.runs',{recursive:true});const dir=await mkdtemp(resolve('.runs/host-test-'));
const outfile=join(dir,'host.mjs');
await build({entryPoints:['src/plugin/main.ts'],outfile,bundle:true,platform:'node',format:'esm',alias:{obsidian:resolve('tests/host-obsidian.ts')}});
const Base=(await import(pathToFileURL(outfile).href)).default;
class Deepsidian extends Base { constructor(){super();this.state.settings.useMemory=false;} }
test('auto connection waits for layout, honors opt-out, and ignores late layout after unload',async()=>{
  const old=(globalThis as any).window;(globalThis as any).window={setInterval:()=>0};
  try {
    for(const [enabled,unload,expected] of [[true,false,1],[false,false,0],[true,true,0]] as const){
      const p=new Deepsidian();p.saved={settings:{autoConnect:enabled},chats:[{id:'test',title:'test',messages:[]}],activeId:'test'};
      let calls=0;p.connect=async()=>{calls++;};await p.onload();assert.equal(calls,0);
      if(unload)p.onunload();p.ready();await Promise.resolve();assert.equal(calls,expected);
    }
  }finally{(globalThis as any).window=old;}
});
test('concurrent connection requests share one start and wait for an in-progress stop',async()=>{
  const p=new Deepsidian();let starts=0;let release!:()=>void;
  p.connectRuntime=async()=>{starts++;await new Promise<void>(r=>release=r);return {connected:true};};
  const first=p.connect(),second=p.connect();await Promise.resolve();assert.equal(starts,1);release();assert.equal(await first,await second);
  let finishStop!:()=>void;p.client={connected:true,stop:()=>new Promise<void>(r=>finishStop=r)};
  const stopping=p.disconnect();await Promise.resolve();const third=p.connect();await Promise.resolve();assert.equal(starts,1);
  finishStop();await stopping;await Promise.resolve();assert.equal(starts,2);release();await third;
});
test('host commands keep management out of model calls and persist a bounded session goal',async()=>{
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[]}];p.state.activeId='a';let saved=0,opened=0;
  p.saveData=async()=>{saved++;};p.openMemory=()=>{opened++;};
  await p.runCommand('/memory');assert.equal(opened,1);
  await p.runCommand('/goal 理解注意力');assert.equal(p.chat.goal,'理解注意力');assert.equal(saved,1);
  await p.runCommand('/goal clear');assert.equal(p.chat.goal,undefined);
  assert.match((await p.runCommand('/plan KV cache')).question,/本轮仅研究和规划/);
  await assert.rejects(()=>p.runCommand('/unknown'),/未知/);
  await assert.rejects(()=>p.runCommand('/memory discard'),/不接受/);
  p.busy=true;await assert.rejects(()=>p.runCommand('/goal new'),/结束/);
});
test('failed goal changes leave the previous goal active',async()=>{
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[],goal:'原目标'}];p.state.activeId='a';
  p.saveData=async()=>{throw Error('disk full');};
  for(const command of ['/goal 新目标','/goal clear']){
    await assert.rejects(()=>p.runCommand(command),/disk full/);
    assert.equal(p.chat.goal,'原目标');
  }
});
test('new chat awaits persistence, blocks concurrent edits, and rolls back on failure',async()=>{
  const p=new Deepsidian();const original={id:'a',title:'a',messages:[]};
  p.state.chats=[original];p.state.activeId='a';p.toolEvents=['previous tools'];
  let rejectSave!:(error:Error)=>void;
  p.saveData=()=>new Promise<void>((_resolve,reject)=>{rejectSave=reject;});
  const creating=p.runCommand('/new');
  const failure=assert.rejects(creating,/新建会话保存失败.*disk full/);
  assert.equal(p.busy,true);assert.equal(p.creatingChat,true);assert.equal(p.state.chats.length,1);
  await assert.rejects(()=>p.newChat(),/当前操作/);
  await assert.rejects(()=>p.runCommand('/new'),/结束/);
  await assert.rejects(()=>p.runCommand('/goal changed'),/结束/);
  await p.ask('must not send');assert.equal(p.chat.messages.length,0);
  rejectSave(Error('disk full'));await failure;
  assert.deepEqual(p.state.chats,[original]);assert.equal(p.state.activeId,'a');
  assert.deepEqual(p.toolEvents,['previous tools']);assert.equal(p.busy,false);assert.equal(p.creatingChat,false);
  let saved=false;p.saveData=async()=>{saved=true;};
  await p.runCommand('/new');assert.equal(saved,true);assert.equal(p.state.chats.length,2);
  assert.notEqual(p.state.activeId,'a');assert.deepEqual(p.toolEvents,[]);assert.equal(p.busy,false);
});
test('first activation awaits the initial chat save and reports a save failure',async()=>{
  const p=new Deepsidian();p.saveData=async()=>{throw Error('disk full');};
  await assert.rejects(()=>p.onload(),/新建会话保存失败.*disk full/);
  assert.equal(p.state.chats.length,0);assert.equal(p.state.activeId,'');assert.equal(p.busy,false);
});
test('host budgets the current captured context and sends the same frozen prompt',async()=>{
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[]}];p.state.activeId='a';
  let captured=0,connected=0,sent='';
  p.capture=()=>{captured++;p.source={path:'当前.md',selection:'x'.repeat(6000),nearby:'y'.repeat(10000)};};
  p.connect=async()=>{connected++;p.source={path:'另一个.md',selection:'NEW_SOURCE',nearby:''};return {options:{model:'test'},prompt:async(_id:string,prompt:string)=>{sent=prompt;return {kind:'completed'};}};};
  await p.ask('问题'.repeat(15000));
  assert.equal(captured,1);assert.equal(connected,0);assert.equal(p.chat.messages.length,0);assert.equal(p.busy,false);
  await p.ask('解释选区');
  assert.equal(captured,2);assert.equal(connected,1);assert.match(sent,/当前.md/);assert.doesNotMatch(sent,/NEW_SOURCE|另一个.md/);
  assert.equal(p.chat.messages[0].source.path,'当前.md');
});


test('failed staged changes never leak into queued background saves', async () => {
  for (const operation of ['new', 'goal', 'select']) {
    const p = new Deepsidian();
    p.state.chats = [{id:'old',title:'old',messages:[],goal:'original'}, {id:'other',title:'other',messages:[]}]; p.state.activeId='old';
    let rejectFirst!:(error:Error)=>void, started!:()=>void, disk:any, count=0;
    const entered=new Promise<void>(resolve=>started=resolve);
    p.saveData=async(snapshot:any)=>{ if(++count===1){started();await new Promise<void>((_r,reject)=>rejectFirst=reject);} disk=structuredClone(snapshot); };
    const attempt=operation==='new'?p.newChat():operation==='goal'?p.runCommand('/goal changed'):p.selectChat('other');
    const failed=assert.rejects(attempt,/disk failure/); await entered;
    p.state.settings.maxTokens=8192; const background=p.persist();
    rejectFirst(Error('disk failure')); await failed; await background;
    assert.deepEqual(disk,p.state); assert.equal(disk.activeId,'old'); assert.equal(disk.chats.length,2);
    assert.equal(disk.chats[0].goal,'original'); assert.equal(disk.settings.maxTokens,8192);
  }
});

test('successful staged creation is included in later queued saves', async () => {
  const p=new Deepsidian();p.state.chats=[{id:'old',title:'old',messages:[]}];p.state.activeId='old';
  let release!:()=>void, started!:()=>void, disk:any, count=0;
  const entered=new Promise<void>(resolve=>started=resolve);
  p.saveData=async(snapshot:any)=>{if(++count===1){started();await new Promise<void>(r=>release=r);}disk=structuredClone(snapshot);};
  const creating=p.newChat();await entered;const background=p.persist();release();await creating;await background;
  assert.deepEqual(disk,p.state);assert.equal(disk.chats.length,2);assert.notEqual(disk.activeId,'old');
});

test('focused sidebar keeps runtime alive, unfocused idle recycles, and return reconnects', async () => {
  const p=new Deepsidian();p.layoutReady=true;let focused=true, stops=0, starts=0;
  p.view={hasFocus:()=>focused};p.client={connected:true};p.lastUsed=0;
  p.disconnect=async()=>{stops++;p.client=undefined;};
  p.connect=async()=>{starts++;p.client={connected:true};return p.client;};
  p.maintainConnection();assert.equal(stops,0);
  focused=false;p.maintainConnection();assert.equal(stops,0);
  p.lastUsed=0;p.maintainConnection();assert.equal(stops,1);
  focused=true;p.sidebarActivated();await p.autoAttempt;assert.equal(starts,1);
  p.client=undefined;p.maintainConnection();await p.autoAttempt;assert.equal(starts,2);
  p.busy=true;p.client=undefined;p.maintainConnection();assert.equal(starts,2);
});

test('automatic connection coalesces focus events, backs off failures and honors opt-out/unload', async () => {
  const p=new Deepsidian();p.layoutReady=true;let attempts=0, fail!:(e:Error)=>void;
  p.connect=()=>{attempts++;return new Promise((_r,reject)=>fail=reject);};
  p.sidebarActivated();p.sidebarActivated();assert.equal(attempts,1);
  fail(Error('missing runtime'));await p.autoAttempt;
  p.sidebarActivated();assert.equal(attempts,1);assert.ok(p.retryAt>Date.now());
  p.retryAt=0;p.sidebarActivated();assert.equal(attempts,2);fail(Error('offline'));await p.autoAttempt;
  assert.equal(p.retryDelay,8000);
  p.retryAt=0;p.state.settings.autoConnect=false;p.sidebarActivated();assert.equal(attempts,2);
  p.state.settings.autoConnect=true;p.disposed=true;p.sidebarActivated();assert.equal(attempts,2);
});


test('connect waits for initialization even when the child process is already alive', async () => {
  const p=new Deepsidian();let release!:()=>void, returned=false;
  p.connectRuntime=async()=>{p.client={connected:true};await new Promise<void>(r=>release=r);return p.client;};
  const first=p.connect();await Promise.resolve();
  const second=p.connect().then((value:any)=>{returned=true;return value;});
  await Promise.resolve();await Promise.resolve();assert.equal(returned,false);
  release();assert.equal(await first,await second);
});


test('memory crosses chats, freezes in-flight edits, withdraws deletion, and honors disabled reads', async () => {
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  const root=await mkdtemp(resolve('.runs/recall-host-'));const store=new MemoryStore(join(root,'memory'));
  const p=new Deepsidian();p.state.settings.useMemory=true;p.state.chats=[{id:'a',title:'a',messages:[]}];p.state.activeId='a';
  p.memory=()=>store;p.capture=()=>{};
  await p.runCommand('/remember 我熟悉前端，请用前端例子解释');
  const id=(await store.snapshot()).entries[0]!.id;const seen:string[]=[];let phase=0;
  p.connect=async()=>({options:{model:'test'},prompt:async(_id:string,text:string)=>{
    assert.match(text,/撤回此前所有长期记忆/);
    if(phase===0){const snap=await store.snapshot();await store.update(snap.revision,{edit:{id,text:'请用Python例子解释'}});}
    if(phase<2) seen.push((await p.handleTool('memory_read',{id})).entry.text);
    else {assert.equal((await p.handleTool('memory_search',{query:''})).total,0);await assert.rejects(()=>p.handleTool('memory_read',{id}),/可能已删除/);assert.doesNotMatch(text,/请用Python例子/);}
    return {kind:'completed'};
  }});
  await p.newChat();await p.ask('解释缓存');assert.match(seen[0]!,/前端/);assert.ok(p.chat.messages.at(-1).trace.some((e:any)=>e.type==='memory/read'));
  phase=1;await p.newChat();await p.ask('解释缓存');assert.match(seen[1]!,/Python/);
  const snap=await store.snapshot();await store.update(snap.revision,{remove:id});phase=2;await p.ask('继续');
  p.state.settings.useMemory=false;p.memory=()=>{throw Error('must not touch memory');};
  p.connect=async()=>({options:{model:'test'},prompt:async(_id:string,text:string)=>{assert.match(text,/长期记忆读取已关闭/);await assert.rejects(()=>p.handleTool('memory_read',{id}),/未启用/);return {kind:'completed'};}});
  await p.ask('继续');assert.equal(p.chat.messages.at(-1).status,'完成');
});

test('memory preparation failures retain the draft and do not start a model request', async () => {
  const p=new Deepsidian();p.state.settings.useMemory=true;p.state.chats=[{id:'a',title:'a',messages:[]}];p.state.activeId='a';p.capture=()=>{};
  let accepted=0,connected=0;p.memory=()=>({snapshot:async()=>{throw Error('writer lock');}});p.connect=async()=>{connected++;};
  await p.ask('question',[],()=>accepted++);assert.equal(accepted,0);assert.equal(connected,0);assert.equal(p.chat.messages.length,0);assert.equal(p.busy,false);
});


test('memory tool output has a per-turn budget and never falls back to foreign paths', async () => {
  const p=new Deepsidian();p.state.settings.useMemory=true;p.state.chats=[{id:'a',title:'a',messages:[]}];p.state.activeId='a';p.capture=()=>{};
  const entry={id:'id',text:'x'.repeat(2000),source:'test',createdAt:'2026-09-16'};
  p.memory=()=>({snapshot:async()=>({vaultId:'local',revision:'r',rules:'',entries:[entry]})});
  p.connect=async()=>({options:{model:'test'},prompt:async()=>{
    await assert.rejects(()=>p.handleTool('memory_read',{id:'../../other-vault'}),/不在本轮本库/);
    for(let i=0;i<10;i++) await p.handleTool('memory_read',{id:'id'});
    await p.handleTool('memory_read',{id:'id'});
    await assert.rejects(()=>p.handleTool('memory_read',{id:'id'}),/预算/);
    return {kind:'completed'};
  }});
  await p.ask('question');assert.equal(p.chat.messages.at(-1).status,'完成');
});
