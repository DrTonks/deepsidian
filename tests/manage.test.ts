import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {MemoryStore} from '../src/plugin/memory/store.ts';
import {MemoryManager} from '../src/plugin/memory/manage.ts';
import {sourceKey} from '../src/plugin/memory/proposals.ts';

const source={chatId:'synthetic-memory-management',index:2,text:'请记住：先定义再举例。改为先举例。忘记这个偏好。'};
async function fixture(authorize:()=>void=()=>{}) {
  await mkdir('.runs',{recursive:true});
  const store=new MemoryStore(await mkdtemp(resolve('.runs/manage-')));
  const manager=new MemoryManager(store,await store.snapshot(),source,authorize);
  return {store,manager};
}
const add=(text='先定义再举例')=>({action:'add',text,quote:'请记住：先定义再举例。'});

test('agent memory CRUD persists source identity and deletion excludes its extraction source',async()=>{
  const {store,manager}=await fixture();
  const added=await manager.execute(add());
  assert.equal(added.action,'add');assert.ok(added.id);assert.equal(typeof added.status,'string');
  let saved=await store.snapshot();
  assert.equal(added.revision,saved.revision);assert.equal(manager.snapshot.revision,saved.revision);
  assert.equal(saved.entries[0]?.id,added.id);
  assert.deepEqual(saved.entries[0]?.sourceKeys,[sourceKey(source.chatId,source.index,source.text)]);
  await manager.execute({action:'edit',id:added.id,text:'先举例',quote:'改为先举例。'});
  saved=await store.snapshot();assert.equal(saved.entries[0]?.text,'先举例');assert.equal(saved.entries[0]?.id,added.id);
  await manager.execute({action:'remove',id:added.id,quote:'忘记这个偏好。'});
  saved=await store.snapshot();assert.equal(saved.entries.length,0);
  assert.ok(saved.excludedSources?.includes(sourceKey(source.chatId,source.index,source.text)));
  assert.equal(manager.snapshot.revision,saved.revision);
});

test('disabled permission rejects mutation before touching the store',async()=>{
  const {store,manager}=await fixture(()=>{throw Error('management disabled');});
  const before=await store.snapshot();
  await assert.rejects(()=>manager.execute(add()),/disabled/);
  assert.deepEqual(await store.snapshot(),before);
});

test('evidence must be a nonempty exact quote from this user message, within the limit',async()=>{
  const {store,manager}=await fixture();const before=await store.snapshot();
  for(const quote of ['', '   ', '我喜欢 Python', source.text+'！', 'a'.repeat(501), 42]) {
    await assert.rejects(()=>manager.execute({...add(),quote}));
  }
  assert.deepEqual(await store.snapshot(),before);
  const longSource={...source,text:'x'.repeat(501)};
  const longManager=new MemoryManager(store,before,longSource,()=>{});
  await assert.rejects(()=>longManager.execute({...add(),quote:longSource.text}));
  assert.deepEqual(await store.snapshot(),before);
});

test('unknown operations, blank text, and IDs outside the snapshot fail without mutation',async()=>{
  const {store,manager}=await fixture();const before=await store.snapshot();
  for(const args of [
    {...add(),action:'clear'}, {...add(),text:''}, {...add(),text:'x'.repeat(2001)},
    {...add(),action:'edit',id:'00000000-0000-0000-0000-000000000000'},
    {action:'remove',id:'00000000-0000-0000-0000-000000000000',quote:'忘记这个偏好。'},
  ])await assert.rejects(()=>manager.execute(args));
  assert.deepEqual(await store.snapshot(),before);
});

test('external edits invalidate a turn snapshot instead of overwriting other writers',async()=>{
  const {store,manager}=await fixture();const before=await store.snapshot();
  await store.update(before.revision,{add:'external memory'});const external=await store.snapshot();
  await assert.rejects(()=>manager.execute(add()));
  assert.deepEqual(await store.snapshot(),external);
});

test('retrying the latest successful request is idempotent, but a distinct duplicate add is rejected',async()=>{
  const {store,manager}=await fixture();const request=add();
  const first=await manager.execute(request);const revision=(await store.snapshot()).revision;
  const repeated=await manager.execute({...request});
  assert.equal(repeated.id,first.id);assert.equal(repeated.revision,first.revision);
  assert.equal((await store.snapshot()).revision,revision);
  await assert.rejects(()=>manager.execute({...request,quote:'先定义再举例'}));
  assert.equal((await store.snapshot()).entries.length,1);
});

test('permission is checked again even for an idempotent request',async()=>{
  let enabled=true;const {store,manager}=await fixture(()=>{if(!enabled)throw Error('disabled');});
  const request=add();await manager.execute(request);const before=await store.snapshot();enabled=false;
  await assert.rejects(()=>manager.execute(request),/disabled/);
  assert.deepEqual(await store.snapshot(),before);
});

test('five actual mutations are permitted per turn; retries and rejected requests do not spend the budget',async()=>{
  const {store,manager}=await fixture();
  await assert.rejects(()=>manager.execute({...add(),quote:'not a quote'}));
  for(let i=0;i<5;i++) {
    const request=add(`偏好 ${i}`);await manager.execute(request);await manager.execute(request);
  }
  const before=await store.snapshot();assert.equal(before.entries.length,5);
  await assert.rejects(()=>manager.execute(add('第六项')));
  assert.deepEqual(await store.snapshot(),before);
});

test('revoking authorization while update waits prevents the commit',async()=>{
  let enabled=true;const {store,manager}=await fixture(()=>{if(!enabled)throw Error('cancelled');});
  const original=store.update.bind(store);const before=await store.snapshot();
  store.update=(...args:Parameters<MemoryStore['update']>)=>{enabled=false;return original(...args);};
  await assert.rejects(()=>manager.execute(add()),/cancelled/);
  assert.deepEqual(await store.snapshot(),before);
});

test('concurrent tool requests serialize against the refreshed revision without losing writes',async()=>{
  const {store,manager}=await fixture();
  const results=await Promise.all([manager.execute(add('偏好一')),manager.execute(add('偏好二')),manager.execute(add('偏好三'))]);
  const saved=await store.snapshot();assert.deepEqual(saved.entries.map(e=>e.text),['偏好一','偏好二','偏好三']);
  assert.equal(new Set(results.map(r=>r.id)).size,3);assert.equal(manager.snapshot.revision,saved.revision);
});

test('a failed queued request does not block later valid requests, and arguments are captured on submission',async()=>{
  const {store,manager}=await fixture();
  const bad=manager.execute({...add(),quote:'not from user'});
  const request=add('捕获提交时的文本');const good=manager.execute(request);request.text='随后修改的文本';
  await assert.rejects(()=>bad);await good;
  assert.equal((await store.snapshot()).entries[0]?.text,'捕获提交时的文本');
});

test('manager uses the committed snapshot without rereading or accepting an intervening external write',async()=>{
  const {store,manager}=await fixture();const snapshot=store.snapshot.bind(store),update=store.update.bind(store);
  store.snapshot=async()=>{throw Error('manager must not reread after commit');};
  let committedRevision='';
  store.update=async(...args:Parameters<MemoryStore['update']>)=>{
    const committed=await update(...args);committedRevision=committed.revision;
    await update(committed.revision,{add:'外部写入'});
    return committed;
  };
  const result=await manager.execute(add());assert.equal(result.status,'committed');
  assert.equal(result.revision,committedRevision);assert.equal(manager.snapshot.entries.length,1);
  assert.equal(manager.snapshot.entries[0]?.text,'先定义再举例');
  store.snapshot=snapshot;store.update=update;
  const external=await store.snapshot();assert.equal(external.entries.length,2);
  await assert.rejects(()=>manager.execute(add('下一项')));
  assert.deepEqual(await store.snapshot(),external);
});

test('cancellation during the final asynchronous file check still prevents transaction publication',async()=>{
  let enabled=true;const {store,manager}=await fixture(()=>{if(!enabled)throw Error('cancelled during file check');});
  const before=await store.snapshot();const internals=store as any;
  const commit=internals.commit.bind(store),files=internals.files.bind(store);
  let insideCommit=false,release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  internals.commit=async(...args:unknown[])=>{insideCommit=true;try{return await commit(...args);}finally{insideCommit=false;}};
  internals.files=async()=>{const result=await files();if(insideCommit){entered();await gate;}return result;};
  const attempt=manager.execute(add());const rejected=assert.rejects(attempt,/cancelled during file check/);
  await waiting;enabled=false;release();await rejected;
  assert.deepEqual(await store.snapshot(),before);
});
