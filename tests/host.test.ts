import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('.runs',{recursive:true});const dir=await mkdtemp(resolve('.runs/host-test-'));
const outfile=join(dir,'host.mjs');
await build({stdin:{contents:"export {default} from './src/plugin/main.ts'; export {DshClient} from './src/plugin/dsh.ts'; export {FileSystemAdapter,MarkdownView} from 'obsidian';",resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'esm',alias:{obsidian:resolve('tests/host-obsidian.ts')}});
const {default:Base,DshClient,FileSystemAdapter,MarkdownView}=await import(pathToFileURL(outfile).href);
class Deepsidian extends Base { constructor(){super();this.state.settings.useMemory=false;} }

test('knowledge output respects per-result/turn budgets and cancelled or replaced turns',async()=>{
  const p=new Deepsidian();p.busy=true;p.activeMessage={};
  p.toolResult=async()=>({text:'x'.repeat(23000)});
  await p.handleTool('obsidian_query',{});await p.handleTool('obsidian_query',{});
  await assert.rejects(()=>p.handleTool('obsidian_query',{}),/预算不足/);
  p.knowledgeChars=0;p.toolResult=async()=>({text:'x'.repeat(24000)});
  await assert.rejects(()=>p.handleTool('obsidian_query',{}),/预算不足/);
  for(const mode of ['cancel','replace']){
    let release!:(result:unknown)=>void;p.stopRequested=false;p.activeMessage={};p.knowledgeChars=0;
    p.toolResult=()=>new Promise(r=>release=r);
    const pending=p.handleTool('obsidian_query',{}),rejected=assert.rejects(pending,/请求已停止/);
    if(mode==='cancel')p.stopRequested=true;else p.activeMessage={};
    release({results:['old response']});await rejected;assert.equal(p.knowledgeChars,0);
  }
});

test('AI memory settings preserve explicit opt-out; failed save rolls back and busy changes are rejected',async()=>{
  const p=new Deepsidian();p.state.settings.manageMemory=false;assert.equal(p.state.settings.manageMemory,false);
  let stops=0;p.disconnect=async()=>{stops++;};p.saveData=async()=>{throw Error('disk full');};
  await assert.rejects(()=>p.setManageMemory(true),/disk full/);
  assert.equal(p.state.settings.manageMemory,false);assert.equal(p.busy,false);assert.equal(stops,1);
  p.busy=true;await assert.rejects(()=>p.setManageMemory(true),/结束当前回答/);assert.equal(stops,1);
  p.busy=false;let saved:any;p.saveData=async(value:any)=>{saved=structuredClone(value);};
  await p.setManageMemory(true);assert.equal(p.state.settings.manageMemory,true);assert.equal(saved.settings.manageMemory,true);
  await p.setManageMemory(false);assert.equal(p.state.settings.manageMemory,false);assert.equal(saved.settings.manageMemory,false);
});

test('foreground agent manages real memory, reads the updated snapshot, and cannot write outside its turn',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  const {sourceKey}=await import('../src/plugin/memory/proposals.ts');
  const store=new MemoryStore(join(await mkdtemp(resolve('.runs/manage-host-')),'memory'));
  const p=new Deepsidian();p.state.settings.useMemory=true;p.state.settings.manageMemory=true;
  p.state.chats=[{id:'synthetic',title:'synthetic',messages:[]}];p.state.activeId='synthetic';p.capture=()=>{};p.memory=()=>store;
  let id='';let checked=false;const question='请记住，解释先给定义。';
  p.connect=async()=>({options:{model:'test'},prompt:async(_id:string,prompt:string)=>{
    assert.match(prompt,/本轮允许管理本库长期记忆/);
    const result=await p.handleTool('memory_manage',{action:'add',text:'解释先给定义',quote:question});id=result.id;
    assert.equal(result.status,'committed');assert.equal((await p.handleTool('memory_read',{id})).entry.text,'解释先给定义');
    checked=true;return {kind:'completed'};
  }});
  await p.ask(question);assert.equal(checked,true);assert.equal(p.chat.messages.at(-1).status,'完成');
  const saved=await store.snapshot();assert.equal(saved.entries[0]!.id,id);
  assert.deepEqual(saved.entries[0]!.sourceKeys,[sourceKey('synthetic',0,question)]);
  assert.ok(p.chat.messages.at(-1).trace.some((event:any)=>event.type==='memory/manage'));
  await assert.rejects(()=>p.handleTool('memory_manage',{action:'remove',id,quote:question}),/没有活动/);
});

test('host rejects memory writes when management, reads, or chat contribution is disabled',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  for(const disabled of ['management','reads','chat-reads','contribution']) {
    const store=new MemoryStore(join(await mkdtemp(resolve('.runs/manage-disabled-')),'memory'));
    const p=new Deepsidian();p.state.settings.useMemory=disabled!=='reads';p.state.settings.manageMemory=disabled!=='management';
    p.state.chats=[{id:'synthetic',title:'synthetic',messages:[],useMemory:disabled!=='chat-reads',contributeMemory:disabled!=='contribution'}];
    p.state.activeId='synthetic';p.capture=()=>{};p.memory=()=>store;let checked=false;
    p.connect=async()=>({options:{model:'test'},prompt:async(_id:string,prompt:string)=>{
      assert.match(prompt,/本轮不允许 AI 修改长期记忆/);
      await assert.rejects(()=>p.handleTool('memory_manage',{action:'add',text:'先定义',quote:'请记住先定义'}),/未启用/);
      checked=true;return {kind:'completed'};
    }});
    await p.ask('请记住先定义');assert.equal(checked,true,disabled);assert.equal((await store.snapshot()).entries.length,0);
  }
});

test('host revalidates a current authorization message and cancellation at tool execution',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  for(const revoke of ['cancel','message-edit','permission']) {
    const store=new MemoryStore(join(await mkdtemp(resolve('.runs/manage-revoke-')),'memory'));
    const p=new Deepsidian();p.state.settings.useMemory=true;p.state.settings.manageMemory=true;
    p.state.chats=[{id:'synthetic',title:'synthetic',messages:[]}];p.state.activeId='synthetic';p.capture=()=>{};p.memory=()=>store;
    let checked=false;
    p.connect=async()=>({options:{model:'test'},prompt:async()=>{
      if(revoke==='cancel')p.stopRequested=true;
      if(revoke==='message-edit')p.chat.messages[0].text='changed';
      if(revoke==='permission')p.state.settings.manageMemory=false;
      await assert.rejects(()=>p.handleTool('memory_manage',{action:'add',text:'先定义',quote:'请记住先定义'}));
      checked=true;return {kind:'completed'};
    }});
    await p.ask('请记住先定义');assert.equal(checked,true,revoke);assert.equal((await store.snapshot()).entries.length,0);
  }
});

test('a delayed write from an earlier turn cannot borrow a new turn authorization',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  const store=new MemoryStore(join(await mkdtemp(resolve('.runs/manage-old-turn-')),'memory'));
  const p=new Deepsidian();p.state.settings.useMemory=true;p.state.settings.manageMemory=true;
  p.state.chats=[{id:'synthetic',title:'synthetic',messages:[]}];p.state.activeId='synthetic';p.capture=()=>{};p.memory=()=>store;
  const update=store.update.bind(store);let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  store.update=async(...args:Parameters<MemoryStore['update']>)=>{entered();await gate;return update(...args);};
  let phase=0,rejected:Promise<void>|undefined,checked=false;
  p.connect=async()=>({options:{model:'test'},prompt:async()=>{
    if(phase++===0){
      const delayed=p.handleTool('memory_manage',{action:'add',text:'旧轮记忆',quote:'请记住旧轮记忆'});
      rejected=assert.rejects(delayed,/权限已关闭或请求已停止/);
      await waiting;return {kind:'completed'};
    }
    assert.ok(p.activeManager);release();await rejected;checked=true;
    return {kind:'completed'};
  }});
  await p.ask('请记住旧轮记忆');await p.ask('这是新一轮，请继续');
  assert.equal(checked,true);assert.equal((await store.snapshot()).entries.length,0);
});
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

test('session memory policy persists independently, blocks contribution, and respects the vault switch', async () => {
  const p=new Deepsidian();p.state.settings.useMemory=true;p.state.chats=[{id:'a',title:'a',messages:[]},{id:'b',title:'b',messages:[]}];p.state.activeId='a';p.capture=()=>{};
  let disk:any;p.saveData=async(s:any)=>{disk=structuredClone(s);};
  await p.setChatMemory('a',{useMemory:false,contributeMemory:false});
  assert.equal(disk.chats[0].useMemory,false);assert.equal(p.state.chats[1].useMemory,undefined);
  p.memory=()=>{throw Error('must not access store');};
  await assert.rejects(()=>p.runCommand('/remember secret'),/关闭记忆贡献/);
  p.connect=async()=>({options:{model:'test'},prompt:async(_id:string,text:string)=>{assert.match(text,/长期记忆读取已关闭/);return {kind:'completed'};}});
  await p.ask('question');assert.equal(p.chat.messages.at(-1).status,'完成');
  await p.setChatMemory('a',{useMemory:true});p.state.settings.useMemory=false;
  await p.ask('question');assert.equal(p.chat.messages.at(-1).status,'完成');
  assert.equal(p.chat.contributeMemory,false);
  await p.newChat();assert.equal(p.chat.useMemory,undefined);assert.equal(p.chat.contributeMemory,undefined);
});

test('session policy saves are atomic and cannot race a question or remember command', async () => {
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[]}];p.state.activeId='a';
  let reject!:(e:Error)=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r);
  p.saveData=()=>{entered();return new Promise<void>((_r,j)=>reject=j);};
  const pending=p.setChatMemory('a',{useMemory:false});const failed=assert.rejects(pending,/disk full/);await started;
  assert.equal(p.chat.useMemory,undefined);
  await p.ask('must not send');assert.equal(p.chat.messages.length,0);
  await assert.rejects(()=>p.runCommand('/remember secret'),/结束当前操作/);
  await assert.rejects(()=>p.setChatMemory('a',{contributeMemory:false}),/结束当前回答/);
  reject(Error('disk full'));await failed;assert.equal(p.busy,false);assert.equal(p.chat.useMemory,undefined);
  p.saveData=async()=>{};await p.setChatMemory('a',{useMemory:false});assert.equal(p.chat.useMemory,false);
});

test('M2 generates without writes, confirms selected changes, rejects stale or opted-out sources',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  const root=await mkdtemp(resolve('.runs/proposal-host-'));const store=new MemoryStore(join(root,'memory'));
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[{role:'user',text:'请用前端例子'}]}];p.state.activeId='a';p.memory=()=>store;
  p.runMemoryModel=async(prompt:string)=>{const input=JSON.parse(prompt.split('\n').at(-1)!);return JSON.stringify({proposals:[{kind:'add',text:'偏好前端例子',reason:'明确要求',evidence:[{key:input.sources[0].key,quote:'前端例子'}]}]});};
  let batch=await p.extractMemory('a',new AbortController().signal);assert.equal(p.busy,false);assert.equal((await store.snapshot()).entries.length,0);
  await p.setChatMemory('a',{contributeMemory:false});await assert.rejects(()=>p.applyMemoryProposals(batch,[0]),/关闭贡献/);
  await p.setChatMemory('a',{contributeMemory:true});await assert.rejects(()=>p.applyMemoryProposals(batch,[0]),/来源范围已改变/);batch=await p.extractMemory('a',new AbortController().signal);p.chat.messages[0].text='changed';await assert.rejects(()=>p.applyMemoryProposals(batch,[0]),/来源消息已改变/);p.chat.messages[0].text='请用前端例子';
  await assert.rejects(()=>p.applyMemoryProposals(batch,[]),/选择/);await p.applyMemoryProposals(batch,[0]);assert.equal((await store.snapshot()).entries[0].text,'偏好前端例子');
  await assert.rejects(()=>p.applyMemoryProposals(batch,[0]),/已改变/);
  const snap=await store.snapshot();await store.update(snap.revision,{remove:snap.entries[0].id});
  let calls=0;p.runMemoryModel=async()=>{calls++;return '{}';};await assert.rejects(()=>p.extractMemory('a',new AbortController().signal),/没有可提炼/);assert.equal(calls,0);
});

test('M2 cancellation before dispatch and during model call never produces a committable batch',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');
  const root=await mkdtemp(resolve('.runs/proposal-cancel-'));const p=new Deepsidian();p.memory=()=>new MemoryStore(join(root,'memory'));
  p.state.chats=[{id:'a',title:'a',messages:[{role:'user',text:'use examples'}]}];p.state.activeId='a';let calls=0;
  p.runMemoryModel=async()=>{calls++;return '{"proposals":[]}';};
  const early=new AbortController();early.abort();await assert.rejects(()=>p.extractMemory('a',early.signal));assert.equal(calls,0);assert.equal(p.busy,false);
  let entered!:()=>void,finish!:(s:string)=>void;const started=new Promise<void>(r=>entered=r);
  p.runMemoryModel=()=>{entered();return new Promise<string>(r=>finish=r);};
  const controller=new AbortController(),pending=p.extractMemory('a',controller.signal);const rejected=assert.rejects(pending);await started;controller.abort();finish('{"proposals":[]}');await rejected;assert.equal(p.busy,false);
});

test('model catalogue failure preserves a successfully connected runtime and current model',async()=>{
  const p=new Deepsidian();p.state.settings.checkUpdates=false;
  p.app.vault={adapter:Object.assign(new FileSystemAdapter(),{getBasePath:()=>dir}),configDir:'.obsidian'};
  p.resolveEnvironment=()=>({root:dir,node:process.execPath,home:dir,versions:{dsh:'0.1.5-rc.2'},model:{provider:'local',model:'available'}});
  const original={start:DshClient.prototype.start,models:DshClient.prototype.models,stop:DshClient.prototype.stop,prompt:DshClient.prototype.prompt};let stopped=0;
  try {
    DshClient.prototype.start=async function(){Object.defineProperty(this,'connected',{value:true});};
    DshClient.prototype.models=async()=>{throw Error('Unselected provider catalogue failed');};
    DshClient.prototype.stop=async()=>{stopped++;};DshClient.prototype.prompt=async()=>({kind:'completed'});
    const client=await p.connect();assert.equal(stopped,0);assert.equal(client,p.client);assert.equal(p.selectedRoute.model,'available');assert.match(p.status,/目录暂不可用/);
    assert.equal((await client.prompt('id','question')).kind,'completed');
  } finally {Object.assign(DshClient.prototype,original);}
});

test('M2 confirms only selected corrections and preserves identity plus previous evidence',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');const root=await mkdtemp(resolve('.runs/proposal-edit-'));const store=new MemoryStore(join(root,'memory'));
  let snap=await store.snapshot();await store.update(snap.revision,{batch:[{text:'使用Java例子',source:'prior confirmation',sourceKeys:['b'.repeat(64)]}]});snap=await store.snapshot();const id=snap.entries[0].id;
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[{role:'user',text:'更正，请用前端例子。请简短回答。'}]}];p.state.activeId='a';p.memory=()=>store;
  p.runMemoryModel=async(prompt:string)=>{const input=JSON.parse(prompt.split('\n').at(-1)!);return JSON.stringify({proposals:[{kind:'edit',id,text:'使用前端例子',reason:'用户明确更正',evidence:[{key:input.sources[0].key,quote:'更正，请用前端例子'}]},{kind:'add',text:'偏好简短回答',reason:'明确偏好',evidence:[{key:input.sources[0].key,quote:'请简短回答'}]}]});};
  const batch=await p.extractMemory('a',new AbortController().signal);await p.applyMemoryProposals(batch,[0]);snap=await store.snapshot();
  assert.equal(snap.entries.length,1);assert.equal(snap.entries[0].id,id);assert.equal(snap.entries[0].text,'使用前端例子');assert.equal(snap.entries[0].sourceKeys.length,2);
  await store.update(snap.revision,{remove:id});assert.equal((await store.snapshot()).excludedSources.length,2);
});

test('idle pending data survives host reload and a failed toggle preserves opt-out',async()=>{
  const old=(globalThis as any).window;(globalThis as any).window={setInterval:()=>0};
  try {
    const p=new Deepsidian();const idle={version:1,day:'2026-09-16',calls:1,chars:100,retryAt:0,cursors:{},pending:{id:'pending',batch:{chatId:'a'}}};
    p.saved={settings:{autoConnect:false,idleMemory:true},chats:[{id:'a',title:'a',messages:[]}],activeId:'a',idleMemory:idle};await p.onload();assert.deepEqual(p.state.idleMemory,idle);assert.equal(p.state.settings.idleMemory,true);
    p.state.settings.idleMemory=false;p.saveData=async()=>{throw Error('disk full');};await assert.rejects(()=>p.setIdleMemory(true));assert.equal(p.state.settings.idleMemory,false);
  } finally {(globalThis as any).window=old;}
});

test('popout activity is observed for existing and new windows, and listeners are cleaned up',async()=>{
  const old=(globalThis as any).window;(globalThis as any).window={setInterval:()=>0};
  try {
    const p=new Deepsidian();p.saved={settings:{autoConnect:false},chats:[{id:'a',title:'a',messages:[]}],activeId:'a'};
    const existing=new EventTarget(),later=new EventTarget();const events:any={};let activities=0;
    p.memoryActivity=()=>{activities++;};p.app.workspace.on=(name:string,fn:any)=>{events[name]=fn;};p.app.workspace.iterateAllLeaves=(fn:any)=>fn({view:{containerEl:{ownerDocument:existing}}});
    await p.onload();p.ready();existing.dispatchEvent(new Event('keydown'));assert.equal(activities,1);
    events['window-open']({}, {document:later});later.dispatchEvent(new Event('pointerdown'));assert.equal(activities,3);
    events['window-close']({}, {document:later});later.dispatchEvent(new Event('keydown'));assert.equal(activities,3);
    p.onunload();existing.dispatchEvent(new Event('keydown'));assert.equal(activities,3);
    p.ready();existing.dispatchEvent(new Event('keydown'));assert.equal(activities,3,'late layout after unload must not reattach listeners');
  } finally {(globalThis as any).window=old;}
});

test('discard cannot race a pending memory commit, and successful confirmation clears the pending record',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');const root=await mkdtemp(resolve('.runs/idle-apply-'));const store=new MemoryStore(join(root,'memory'));
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[{role:'user',text:'前端例子'}]}];p.state.activeId='a';p.memory=()=>store;
  p.runMemoryModel=async(prompt:string)=>{const source=JSON.parse(prompt.split('\n').at(-1)!).sources[0];return JSON.stringify({proposals:[{kind:'add',text:'使用前端例子',reason:'偏好',evidence:[{key:source.key,quote:source.text}]}]});};
  const batch=await p.extractMemory('a',new AbortController().signal);p.state.idleMemory={version:1,day:'',calls:1,chars:100,retryAt:0,cursors:{},pending:{id:'pending',batch}};
  const update=store.update.bind(store);let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  store.update=async(...args:any[])=>{entered();await new Promise<void>(r=>release=r);return update(args[0],args[1]);};
  const saving=p.applyMemoryProposals(batch,[0],'pending');await started;await assert.rejects(()=>p.discardIdleMemory('pending'),/正在处理/);release();await saving;
  assert.equal(p.state.idleMemory.pending,undefined);assert.equal((await store.snapshot()).entries.length,1);assert.equal(p.busy,false);
});

test('source range excludes existing history, survives reload and invalidates old pending/manual batches',async()=>{
  const {MemoryStore}=await import('../src/plugin/memory/store.ts');const root=await mkdtemp(resolve('.runs/range-host-'));const store=new MemoryStore(join(root,'memory'));
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[{role:'user',text:'旧偏好'}]}];p.state.activeId='a';p.memory=()=>store;
  const seen:string[][]=[];p.runMemoryModel=async(prompt:string)=>{const sources=JSON.parse(prompt.split('\n').at(-1)!).sources;seen.push(sources.map((s:any)=>s.text));return JSON.stringify({proposals:[{kind:'add',text:sources[0].text,reason:'明确要求',evidence:[{key:sources[0].key,quote:sources[0].text}]}]});};
  const old=await p.extractMemory('a',new AbortController().signal);
  p.state.idleMemory={version:1,day:'',calls:0,chars:0,retryAt:0,cursors:{a:{index:0,key:old.sources[0].key}},pending:{id:'old',batch:old}};
  let disk:any;p.saveData=async(value:any)=>{disk=structuredClone(value);};await p.setChatMemoryStart('a','now');
  assert.equal(p.state.idleMemory.pending,undefined);assert.equal(p.state.idleMemory.cursors.a,undefined);assert.equal(disk.chats[0].memoryStart.index,1);
  await assert.rejects(()=>p.applyMemoryProposals(old,[0]),/来源范围已改变/);await assert.rejects(()=>p.extractMemory('a',new AbortController().signal),/没有可提炼/);
  p.state=structuredClone(disk);p.chat.messages.push({role:'user',text:'新偏好'});
  const fresh=await p.extractMemory('a',new AbortController().signal);assert.deepEqual(seen.at(-1),['新偏好']);await p.applyMemoryProposals(fresh,[0]);
  p.chat.messages[0].text='编辑旧消息';await assert.rejects(()=>p.extractMemory('a',new AbortController().signal),/起点已失效/);
  await p.setChatMemoryStart('a','now');p.chat.messages.push({role:'user',text:'第三个偏好'});await p.extractMemory('a',new AbortController().signal);assert.deepEqual(seen.at(-1),['第三个偏好']);
  await p.setChatMemoryStart('a','all');assert.equal(p.chat.memoryStart,undefined);
  await assert.rejects(()=>p.applyMemoryProposals(old,[0]),/来源范围已改变/);
});

test('source range save failure does not change policy or discard pending work',async()=>{
  const p=new Deepsidian();p.state.chats=[{id:'a',title:'a',messages:[{role:'user',text:'old'}]}];p.state.activeId='a';
  p.state.idleMemory={version:1,day:'',calls:0,chars:0,retryAt:0,cursors:{},pending:{id:'old',batch:{chatId:'a'}}};
  p.saveData=async()=>{throw Error('disk full');};await assert.rejects(()=>p.setChatMemoryStart('a','now'),/disk full/);
  assert.equal(p.chat.memoryStart,undefined);assert.equal(p.chat.memoryPolicyVersion,undefined);assert.equal(p.state.idleMemory.pending.id,'old');assert.equal(p.busy,false);
});

 test('AI management defaults on for missing settings while saved true/false survive loading',async()=>{
  const old=(globalThis as any).window;(globalThis as any).window={setInterval:()=>0};
  try{for(const value of [undefined,false,true]){const p=new Deepsidian();p.saved={settings:{autoConnect:false,...(value===undefined?{}:{manageMemory:value})},chats:[{id:'a',title:'a',messages:[]}],activeId:'a'};await p.onload();assert.equal(p.state.settings.manageMemory,value??true);p.onunload();}}
  finally{(globalThis as any).window=old;}
 });


test('source navigation resolves duplicate names in source context and reads unsaved headings before opening',async()=>{
  const p=new Deepsidian(),files=[{path:'a/topic.md',basename:'topic',extension:'md',stat:{size:20}},{path:'b/topic.md',basename:'topic',extension:'md',stat:{size:20}},{path:'b/source.md',extension:'md',stat:{size:20}}];
  const file=files[1];let opened:any,reads=0;
  const active=Object.assign(new MarkdownView(),{file,editor:{getValue:()=> '# New heading\nunsaved contents',setCursor:()=>{},scrollIntoView:()=>{}}});
  p.assertContained=async()=>{};
  p.app={vault:{getAbstractFileByPath:(path:string)=>files.find(f=>f.path===path),getFileByPath:(path:string)=>files.find(f=>f.path===path),read:async()=>{reads++;return '# Old heading';}},workspace:{getActiveViewOfType:()=>active,getLeavesOfType:()=>[],getLeaf:()=>({view:active,openFile:async(f:any,state:any)=>{opened={file:f,state};}})},metadataCache:{getFirstLinkpathDest:(target:string,source:string)=>target==='topic'?files.find(f=>f.path===source.split('/')[0]+'/topic.md'):undefined}};
  const result=await p.knowledge('obsidian_resolve',{link:'[[topic#New heading]]'},'b/source.md');
  assert.equal(result.path,'b/topic.md');assert.match(result.content,/unsaved contents/);assert.equal(reads,0);
  await p.openSource('topic#New heading','b/source.md');assert.equal(opened.file.path,'b/topic.md');assert.equal(opened.state.eState.line,0);
  opened=undefined;await assert.rejects(()=>p.openSource('topic#Old heading','b/source.md'),/找不到标题/);assert.equal(opened,undefined);
  await assert.rejects(()=>p.openSource('renamed','b/source.md'),/不存在/);assert.equal(opened,undefined);
});

test('fork publishes only after runtime and host persistence succeed; inherited memory is excluded',async()=>{
  const {memorySourceStart,contributionSources,memoryStartKey}=await import('../src/plugin/memory/proposals.ts');
  const p=new Deepsidian();
  const parent={id:'parent',title:'学习分支',goal:'理解概念',useMemory:false,contributeMemory:true,messages:[
    {role:'user',text:'过去的问题',attachments:['image.png']},{role:'assistant',text:'过去的回答',status:'完成',forkSeq:17},
    {role:'user',text:'后来的问题'},{role:'assistant',text:'后来的回答',status:'完成',forkSeq:29}]};
  p.state.chats=[parent];p.state.activeId=parent.id;
  let forks=0,saves=0;p.connect=async()=>({fork:async(source:string,child:string,atSeq:number)=>{
    forks++;assert.equal(source,parent.id);assert.notEqual(child,parent.id);assert.equal(atSeq,17);
    assert.equal(p.chat,parent);assert.equal(p.busy,true);
  }});
  p.saveData=async()=>{saves++;throw Error('disk full');};
  await assert.rejects(p.forkChat(1),/disk full/);
  assert.equal(p.chat,parent);assert.equal(p.state.chats.length,1);assert.equal(p.busy,false);
  let saved:any;p.saveData=async(value:any)=>{saves++;saved=structuredClone(value);};
  await p.forkChat(1);
  const child=p.chat;assert.notEqual(child.id,parent.id);assert.equal(child.messages.length,2);
  assert.equal(child.goal,parent.goal);assert.equal(child.useMemory,false);assert.equal(child.fork.parentId,parent.id);
  assert.equal(saved.activeId,child.id);assert.equal(forks,2);assert.equal(saves,2);
  assert.equal(memorySourceStart(child),2);assert.deepEqual(contributionSources(child),[]);
  child.memoryStart={index:0,key:memoryStartKey(child,0)};assert.equal(memorySourceStart(child),2);
  child.messages.push({role:'user',text:'新的问题'});assert.equal(contributionSources(child).length,1);
  child.messages[0].attachments.push('another.png');assert.deepEqual(parent.messages[0].attachments,['image.png']);
  child.messages[0].text='modified';assert.throws(()=>contributionSources(child),/继承记录已改变/);
});

test('fork rejects legacy, failed and busy answers and leaves parent selected on runtime failure',async()=>{
  const p=new Deepsidian();p.state.chats=[{id:'parent',title:'parent',messages:[{role:'assistant',text:'answer',status:'完成'}]}];p.state.activeId='parent';
  let calls=0;p.connect=async()=>{calls++;throw Error('runtime unavailable');};
  await assert.rejects(p.forkChat(0),/可靠的分支位置/);assert.equal(calls,0);
  p.chat.messages[0].forkSeq=8;p.chat.messages[0].status='失败';
  await assert.rejects(p.forkChat(0),/可靠的分支位置/);assert.equal(calls,0);
  p.chat.messages[0].status='完成';p.busy=true;
  await assert.rejects(p.forkChat(0),/等待/);p.busy=false;
  await assert.rejects(p.forkChat(0),/runtime unavailable/);assert.equal(p.busy,false);assert.equal(p.state.activeId,'parent');
  p.activeMessage=p.chat.messages[0];delete p.activeMessage.forkSeq;
  p.onRuntime('session.event',{sessionId:'other',event:{type:'turn/end',seq:8,data:{reason:{kind:'completed'}}}});
  assert.equal(p.activeMessage.forkSeq,undefined);
  p.onRuntime('session.event',{sessionId:'parent',event:{type:'turn/end',seq:8,data:{reason:{kind:'aborted'}}}});
  assert.equal(p.activeMessage.forkSeq,undefined);
  p.onRuntime('session.event',{sessionId:'parent',event:{type:'turn/end',seq:12,data:{reason:{kind:'completed'}}}});
  assert.equal(p.activeMessage.forkSeq,12);
});

test('context manifest distinguishes images, text, current note and inherited history without embedding image data',async()=>{
  const p=new Deepsidian();p.state.chats=[{id:'chat',title:'chat',messages:[{role:'user',text:'old'}],fork:{inheritedMessages:1}}];p.state.activeId='chat';
  p.source={path:'n.md',selection:'a',nearby:'b'};
  const files=[{id:'t',name:'x.txt',text:'x'},{id:'i',name:'x.png',image:{name:'x.png',mimeType:'image/png',data:'eA=='}}];
  const manifest=p.previewContext(files);assert.equal(manifest.historyMessages,1);assert.equal(manifest.inheritedMessages,1);
  assert.equal(manifest.items.find((i:any)=>i.kind==='image').bytes,1);assert.doesNotMatch(JSON.stringify(manifest),/eA==/);
  const hash=manifest.items[1].hash;files[0].text='y';assert.notEqual(p.previewContext(files).items[1].hash,hash);
  assert.equal(p.previewContext([]).items.length,1);p.source={path:'',selection:'',nearby:''};assert.equal(p.previewContext([]).items.length,0);
});


test('drafts survive persistence independently; abandoned return fields never enter new requests',async()=>{
  const p=new Deepsidian();p.capture=()=>{};
  p.state.chats=[{id:'parent',title:'main',messages:[]},{id:'child',title:'branch',messages:[]}];p.state.activeId='parent';
  p.setDraftText('parent','parent draft');p.setDraftText('child','child draft');
  let saved:any;p.saveData=async(value:any)=>{saved=structuredClone(value);};await p.persist();
  const restored=new Deepsidian();restored.state=saved;
  assert.equal(restored.chat.draft.text,'parent draft');await restored.selectChat('child');assert.equal(restored.chat.draft.text,'child draft');
  p.chat.draft.conclusions=[{text:'REMOVED-RETURN-FEATURE'}];
  let request='';p.connect=async()=>({options:{model:'test'},prompt:async(_id:string,text:string)=>{request=text;return {kind:'completed'};}});
  await p.ask('new question',[{id:'x',name:'x.txt',text:'attachment snapshot'}]);
  assert.doesNotMatch(request,/REMOVED-RETURN-FEATURE/);
  assert.equal(p.chat.messages[0].manifest.items.length,1);assert.equal(p.chat.messages[0].manifest.promptChars,request.length);
  assert.equal(p.chat.draft.text,'');assert.equal(p.state.chats[1].draft.text,'child draft');
});

test('completion persists reservation before dispatch, preserves chats, and fails closed on storage failure',async()=>{
  const p=new Deepsidian();p.state.settings.completionEnabled=true;
  p.state.chats=[{id:'parent',title:'original',messages:[]}];p.state.activeId='parent';
  const before=JSON.stringify(p.state.chats);let calls=0;let persisted:any;
  const client={complete:async()=>{calls++;assert.equal(persisted.completionBudget.calls,1);return {text:'候选',elapsedMs:1};}};
  p.connect=async()=>client;p.saveData=async(data:any)=>{persisted=structuredClone(data);};
  assert.equal((await p.completeNote({prefix:'前文',suffix:'',title:'合成'},new AbortController().signal)).text,'候选');
  assert.equal(calls,1);assert.equal(JSON.stringify(p.state.chats),before);assert.equal(p.completionPending,false);
  p.state.completionBudget=undefined;p.saveData=async()=>{throw Error('disk full');};
  await assert.rejects(p.completeNote({prefix:'前文',suffix:'',title:'合成'},new AbortController().signal),/disk full/);
  assert.equal(calls,1);assert.equal(p.state.completionBudget,undefined);assert.equal(p.completionPending,false);
});
test('completion cancellation during connect/settings save never dispatches and quotas reject a second attempt',async()=>{
  const p=new Deepsidian();p.state.settings.completionEnabled=true;let calls=0,release!:(c:unknown)=>void;
  const client={complete:async()=>{calls++;return {text:'候选'};}};
  p.connect=()=>new Promise(r=>release=r);const c=new AbortController();
  const result=p.completeNote({prefix:'前',suffix:'',title:'t'},c.signal);const rejected=assert.rejects(result,/abort/i);
  await assert.rejects(p.completeNote({prefix:'另',suffix:'',title:'t'},new AbortController().signal),/上一条/);
  c.abort();release(client);await rejected;assert.equal(calls,0);assert.equal(p.completionPending,false);
  p.connect=async()=>client;let releaseSave!:()=>void;
  p.saveData=()=>new Promise<void>(r=>releaseSave=r);
  const c2=new AbortController();const result2=p.completeNote({prefix:'前',suffix:'',title:'t'},c2.signal);
  const rejected2=assert.rejects(result2,/abort/i);await new Promise(r=>setTimeout(r,0));c2.abort();releaseSave();await rejected2;
  assert.equal(calls,0);assert.equal(p.state.completionBudget.calls,1,'durable reservation is not refunded after abort');
});

test('completion settings merge independent fields after delayed saves and block requests while saving',async()=>{
  const p=new Deepsidian();p.state.settings.completionEnabled=true;
  let release!:()=>void;let calls=0;let saved:any;
  p.saveData=async(data:any)=>{calls++;if(calls===1)await new Promise<void>(r=>release=r);saved=structuredClone(data);};
  const disabled=p.setCompletion({completionEnabled:false});await new Promise(r=>setTimeout(r,0));
  assert.equal(p.completionEnabled('私人/笔记.md'),false,'settings in flight suppress new requests');
  const excluded=p.setCompletion({completionExcluded:'私人'});release();await Promise.all([disabled,excluded]);
  assert.equal(p.state.settings.completionEnabled,false);assert.equal(saved.settings.completionEnabled,false);
  assert.equal(p.state.settings.completionExcluded,'私人');assert.equal(saved.settings.completionExcluded,'私人');
  assert.equal(p.completionSettingsPending,0);
});

test('completion lease prevents idle shutdown; stalled cancellation recycles only without a running chat',()=>{
  const p=new Deepsidian();p.layoutReady=true;p.lastUsed=0;p.state.settings.autoConnect=false;
  let disconnected=0;p.disconnect=async()=>{disconnected++;};p.idleScheduler.tick=async()=>{};
  p.client={connected:true,completionActive:true,completionStalled:false};
  p.maintainConnection();assert.equal(disconnected,0);
  p.client.completionStalled=true;p.busy=true;p.maintainConnection();assert.equal(disconnected,0);
  p.busy=false;p.maintainConnection();assert.equal(disconnected,1);
});

test('completion connection status clears immediately on cancellation, before startup settles',async()=>{
  const p=new Deepsidian();p.state.settings.completionEnabled=true;
  p.completionStatusEl={textContent:'',style:{display:'none'}};
  let release!:(value:unknown)=>void;
  p.connect=()=>new Promise(resolve=>{release=resolve;});
  const abort=new AbortController(),pending=p.completeNote({title:'test',prefix:'正文',suffix:''},abort.signal);
  const rejected=assert.rejects(pending,/abort/i);
  assert.match(p.completionStatusEl.textContent,/连接/);
  assert.equal(p.completionStatusEl.style.display,'');
  abort.abort();
  assert.equal(p.completionStatusEl.style.display,'none');
  release({complete:()=>assert.fail('cancelled startup must never send a paid request')});
  await rejected;
  assert.equal(p.completionStatusEl.style.display,'none');
});
