import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MemoryStore,encodeEntries,decodeEntries} from '../src/plugin/memory/store.ts';
import {parseCommand,commandMatches} from '../src/plugin/commands.ts';
async function fixture(){await mkdir('.runs',{recursive:true});const root=await mkdtemp(resolve('.runs/memory-'));return {root,store:new MemoryStore(root)};}
test('memory preserves Markdown, rejects malformed blocks and duplicate IDs',()=>{
  const entry={id:randomUUID(),text:'偏好\n\n## 标题\n```js\nconst x = 1;\n```',source:'explicit',createdAt:new Date().toISOString()};
  assert.deepEqual(decodeEntries(encodeEntries([entry]).replace(/\n/g,'\r\n')),[entry]);
  assert.throws(()=>decodeEntries(encodeEntries([entry,entry])));
  assert.throws(()=>decodeEntries(encodeEntries([entry])+'不能丢弃的外部文字'));
});
test('memory edits survive restart; stale revisions fail; deletion does not reappear on organize',async()=>{
  const {store,root}=await fixture();let s=await store.snapshot();
  await store.update(s.revision,{add:'熟悉前端',source:'explicit'});
  await assert.rejects(()=>store.update(s.revision,{add:'stale'}),/改变/);
  s=await new MemoryStore(root).snapshot();assert.equal(s.entries[0]?.text,'熟悉前端');
  const id=s.entries[0]!.id;await store.update(s.revision,{edit:{id,text:'正在学 agent'}});
  s=await store.snapshot();assert.equal(s.entries[0]?.id,id);
  await store.update(s.revision,{remove:id});s=await store.snapshot();await store.update(s.revision,{organize:true});
  assert.equal((await new MemoryStore(root).snapshot()).entries.length,0);
  assert.ok(JSON.parse(await readFile(join(root,'state.json'),'utf8')).deleted.includes(id));
});
test('prepared transaction recovers and external edits block recovery without overwrite',async()=>{
  const {store,root}=await fixture();await store.snapshot();const p='RULES.md',before=await readFile(join(root,p),'utf8');
  await writeFile(join(root,'transaction.json'),JSON.stringify({version:1,before:{[p]:before},after:{[p]:'new rules'}}));
  assert.equal((await store.snapshot()).rules,'new rules');await assert.rejects(()=>access(join(root,'transaction.json')));
  await writeFile(join(root,'transaction.json'),JSON.stringify({version:1,before:{[p]:'new rules'},after:{[p]:'proposed'}}));
  await writeFile(join(root,p),'manual edit');
  await assert.rejects(()=>store.snapshot(),/外部编辑/);assert.equal(await readFile(join(root,p),'utf8'),'manual edit');
});
test('two updates from same revision cannot overwrite each other; existing writer lock blocks access',async()=>{
  const {store,root}=await fixture();const s=await store.snapshot();
  const outcomes=await Promise.allSettled([store.update(s.revision,{add:'one'}),store.update(s.revision,{add:'two'})]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  await writeFile(join(root,'writer.lock'),'another instance');
  await assert.rejects(()=>new MemoryStore(root).snapshot(),/writer.lock/);
});
test('slash matching is anchored and preserves multiline arguments',()=>{
  assert.deepEqual(parseCommand('/PLAN a\nb'),{name:'plan',args:'a\nb'});
  assert.equal(parseCommand('text /goal'),undefined);
  assert.deepEqual(commandMatches('/rem').map(c=>c.name),['remember']);
  assert.equal(commandMatches('/remember text').length,0);
  assert.equal(commandMatches('/').length,9);
});
