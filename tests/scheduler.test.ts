import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryScheduler,newIdleMemory} from '../src/plugin/memory/scheduler.ts';
import {memoryStartKey,extractionPrompt} from '../src/plugin/memory/proposals.ts';

function fixture(){
  let time=Date.UTC(2026,8,16),state=newIdleMemory(),enabled=true,blocked=false,calls=0;
  const chats:any[]=[{id:'a',title:'a',messages:[{role:'user',text:'请用前端例子'}]}];
  const snapshot={vaultId:'v',revision:'r',rules:'',entries:[],excludedSources:[]};
  const host={enabled:()=>enabled,blocked:()=>blocked,chats:()=>chats,state:()=>state,
    save:async(change:any)=>{const next=structuredClone(state);change(next);state=next;},snapshot:async()=>snapshot,
    run:async(prompt:string,_signal:AbortSignal)=>{calls++;const input=JSON.parse(prompt.split('\n').at(-1)!);return JSON.stringify({proposals:[{kind:'add',text:'偏好前端例子',reason:'明确偏好',evidence:[{key:input.sources[0].key,quote:input.sources[0].text}]}]});}};
  const clock=()=>time;const scheduler=new MemoryScheduler(host,clock);
  return {host,scheduler,chats,snapshot,clock,advance:(ms=300001)=>{time+=ms;},get state(){return state;},get calls(){return calls;},enable:(v:boolean)=>enabled=v,block:(v:boolean)=>blocked=v};
}

test('extraction instructions distinguish the real user from fictional or quoted preferences',()=>{
  const f=fixture();const prompt=extractionPrompt(f.snapshot,[{key:'test',index:0,text:'这是虚构测试人物的持久偏好：我希望简短回答'}]);
  assert.match(prompt,/证据必须明确描述用户本人/);assert.match(prompt,/第三人称、转述或引用、虚构人物、角色扮演、测试样例/);assert.match(prompt,/不确定归属时不生成提案/);
});
test('idle scheduler defaults to no dispatch until enabled, idle, and foreground is free',async()=>{
  const f=fixture();f.enable(false);f.advance();await f.scheduler.tick();assert.equal(f.calls,0);
  f.enable(true);f.block(true);await f.scheduler.tick();assert.equal(f.calls,0);
  f.block(false);f.scheduler.activity();await f.scheduler.tick();assert.equal(f.calls,0);
  f.advance();await f.scheduler.tick();assert.equal(f.calls,1);assert.ok(f.state.pending);assert.equal(f.state.calls,1);assert.ok(f.state.chars>0);
  f.advance(86400000);await f.scheduler.tick();assert.equal(f.calls,1,'pending review stops subsequent jobs');
});
test('pending batch and cursor survive restart; discard advances to next source without reprocessing',async()=>{
  const f=fixture();f.advance();await f.scheduler.tick();const key=f.state.cursors.a!.key;
  const restart=new MemoryScheduler(f.host,f.clock);f.advance();await restart.tick();assert.equal(f.calls,1);assert.equal(f.state.cursors.a!.key,key);
  await f.host.save((s:any)=>{delete s.pending;});f.chats[0].messages.push({role:'user',text:'第二个偏好'});
  f.advance();await restart.tick();assert.equal(f.calls,2);assert.equal(f.state.pending!.batch.sources[0]!.index,1);
});
test('activity aborts a running job and does not advance its cursor or refund reservation',async()=>{
  const f=fixture();let entered!:()=>void,release!:(s:string)=>void;const started=new Promise<void>(r=>entered=r);
  let signal!:AbortSignal;f.host.run=async(_prompt,s)=>{signal=s;entered();return new Promise<string>(r=>release=r);};
  f.advance();const task=f.scheduler.tick();await started;f.scheduler.activity();assert.equal(signal.aborted,true);
  release('{"proposals":[]}');await task;
  assert.equal(f.state.calls,1);assert.equal(f.state.pending,undefined);assert.deepEqual(f.state.cursors,{});assert.ok(f.state.retryAt>f.clock());
});
test('failed reservations never dispatch and failed models consume at most two daily attempts across restarts',async()=>{
  const f=fixture();const save=f.host.save;f.host.save=async()=>{throw Error('disk full');};f.advance();await f.scheduler.tick();assert.equal(f.calls,0);assert.match(f.scheduler.error,/无法保存/);
  f.host.save=save;let attempts=0;f.host.run=async()=>{attempts++;throw Error('provider failure');};
  f.advance(600001);await f.scheduler.tick();assert.equal(attempts,1);
  const restart=new MemoryScheduler(f.host,f.clock);f.advance(600001);await restart.tick();assert.equal(attempts,2);
  f.advance(600001);await restart.tick();assert.equal(attempts,2);assert.equal(f.state.calls,2);assert.deepEqual(f.state.cursors,{});
  f.advance(86400000);await restart.tick();assert.equal(attempts,3);assert.equal(f.state.calls,1);
});
test('cancel during reservation persistence cannot dispatch; empty results advance incrementally',async()=>{
  const f=fixture();const save=f.host.save;let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  let first=true;f.host.save=async(change)=>{await save(change);if(first){first=false;entered();await new Promise<void>(r=>release=r);}};
  f.advance();const task=f.scheduler.tick();await started;f.scheduler.activity();release();await task;assert.equal(f.calls,0);assert.equal(f.state.calls,1);
  f.host.save=save;f.host.run=async()=>'{"proposals":[]}';f.advance(600001);await f.scheduler.tick();assert.equal(f.state.pending,undefined);assert.equal(f.state.cursors.a!.index,0);
});
test('excluded sources and contribution opt-out do not enter a batch; oldest 20 bound the cursor',async()=>{
  const f=fixture();f.chats[0].contributeMemory=false;f.advance();await f.scheduler.tick();assert.equal(f.calls,0);
  f.chats[0].contributeMemory=true;f.chats[0].messages=Array.from({length:25},(_,i)=>({role:'user',text:`偏好${i}`}));f.advance();await f.scheduler.tick();
  assert.equal(f.state.pending!.batch.sources.length,20);assert.equal(f.state.cursors.a!.index,19);
});
test('two timer ticks coalesce and disabled scheduler drops an in-flight result',async()=>{
  const f=fixture();let release!:(s:string)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  f.host.run=async()=>{entered();return new Promise<string>(r=>release=r);};f.advance();const first=f.scheduler.tick(),second=f.scheduler.tick();assert.equal(first,second);await started;
  f.enable(false);release('{"proposals":[]}');await first;assert.equal(f.state.pending,undefined);assert.deepEqual(f.state.cursors,{});
});

test('oversized batches shrink by whole messages and a single oversized chat cannot starve other chats',async()=>{
  const f=fixture();f.chats[0].messages=Array.from({length:20},()=>({role:'user',text:'x'.repeat(2500)}));
  f.host.run=async()=>'{"proposals":[]}';f.advance();await f.scheduler.tick();
  assert.ok(f.state.cursors.a!.index>=0 && f.state.cursors.a!.index<19);assert.ok(f.state.chars<=40000);
  const g=fixture();g.chats[0].messages=[{role:'user',text:'x'.repeat(40000)}];g.chats.push({id:'b',title:'b',messages:[{role:'user',text:'请用简短回答'}]});g.advance();await g.scheduler.tick();
  assert.equal(g.state.pending!.batch.chatId,'b');assert.equal(g.state.cursors.a,undefined);
});

test('character budget and failed pending persistence cannot leak a dispatch or advance progress',async()=>{
  const f=fixture();await f.host.save((s:any)=>{s.day='2026-09-16';s.chars=79999;});f.advance();await f.scheduler.tick();assert.equal(f.calls,0);assert.deepEqual(f.state.cursors,{});
  const g=fixture();const save=g.host.save;let writes=0;g.host.save=async(change)=>{if(++writes===2)throw Error('pending disk failure');return save(change);};g.advance();await g.scheduler.tick();
  assert.equal(g.calls,1);assert.equal(g.state.calls,1);assert.equal(g.state.pending,undefined);assert.deepEqual(g.state.cursors,{});assert.ok(g.state.retryAt>g.clock());
});

test('idle source floor survives restart and rejects changed anchors without rediscovering old history',async()=>{
  const f=fixture(),chat=f.chats[0];chat.memoryStart={index:1,key:memoryStartKey(chat,1)};chat.memoryPolicyVersion=1;
  chat.messages.push({role:'user',text:'新偏好'});f.advance();await f.scheduler.tick();
  assert.deepEqual(f.state.pending!.batch.sources.map(s=>s.text),['新偏好']);assert.equal(f.state.pending!.batch.memoryPolicyVersion,1);
  await f.host.save((s:any)=>{delete s.pending;delete s.cursors.a;});chat.messages[0].text='被编辑的旧偏好';
  const restart=new MemoryScheduler(f.host,f.clock);f.advance();await restart.tick();assert.equal(f.calls,1);assert.equal(f.state.pending,undefined);assert.match(f.state.lastError!,/来源起点已失效/);
});

test('idle result is rejected if contribution range changes during generation',async()=>{
  const f=fixture();f.host.run=async()=>{f.chats[0].memoryPolicyVersion=1;return '{"proposals":[]}';};f.advance();await f.scheduler.tick();
  assert.equal(f.state.pending,undefined);assert.deepEqual(f.state.cursors,{});
});
