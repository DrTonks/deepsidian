import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('.runs',{recursive:true});const dir=await mkdtemp(resolve('.runs/host-test-'));
const outfile=join(dir,'host.mjs');
await build({entryPoints:['src/plugin/main.ts'],outfile,bundle:true,platform:'node',format:'esm',alias:{obsidian:resolve('tests/host-obsidian.ts')}});
const Deepsidian=(await import(pathToFileURL(outfile).href)).default;
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
  p.persist=async()=>{saved++;};p.openMemory=()=>{opened++;};
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
  p.persist=async()=>{throw Error('disk full');};
  for(const command of ['/goal 新目标','/goal clear']){
    await assert.rejects(()=>p.runCommand(command),/disk full/);
    assert.equal(p.chat.goal,'原目标');
  }
});
test('new chat awaits persistence, blocks concurrent edits, and rolls back on failure',async()=>{
  const p=new Deepsidian();const original={id:'a',title:'a',messages:[]};
  p.state.chats=[original];p.state.activeId='a';p.toolEvents=['previous tools'];
  let rejectSave!:(error:Error)=>void;
  p.persist=()=>new Promise<void>((_resolve,reject)=>{rejectSave=reject;});
  const creating=p.runCommand('/new');
  const failure=assert.rejects(creating,/新建会话保存失败.*disk full/);
  assert.equal(p.busy,true);assert.equal(p.creatingChat,true);assert.equal(p.state.chats.length,2);
  await assert.rejects(()=>p.newChat(),/当前操作/);
  await assert.rejects(()=>p.runCommand('/new'),/结束/);
  await assert.rejects(()=>p.runCommand('/goal changed'),/结束/);
  await p.ask('must not send');assert.equal(p.chat.messages.length,0);
  rejectSave(Error('disk full'));await failure;
  assert.deepEqual(p.state.chats,[original]);assert.equal(p.state.activeId,'a');
  assert.deepEqual(p.toolEvents,['previous tools']);assert.equal(p.busy,false);assert.equal(p.creatingChat,false);
  let saved=false;p.persist=async()=>{saved=true;};
  await p.runCommand('/new');assert.equal(saved,true);assert.equal(p.state.chats.length,2);
  assert.notEqual(p.state.activeId,'a');assert.deepEqual(p.toolEvents,[]);assert.equal(p.busy,false);
});
test('first activation awaits the initial chat save and reports a save failure',async()=>{
  const p=new Deepsidian();p.persist=async()=>{throw Error('disk full');};
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
