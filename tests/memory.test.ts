import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,access,symlink,unlink} from 'node:fs/promises';
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

test('memory manager preserves other drafts across saves, tabs and refreshes',async()=>{
  const {build}=await import('esbuild');const {pathToFileURL}=await import('node:url');
  const {store,root}=await fixture();let snapshot=await store.snapshot();
  await store.update(snapshot.revision,{add:'original'});
  const outfile=join(root,'modal.mjs');
  await build({entryPoints:['src/plugin/memory/modal.ts'],outfile,bundle:true,platform:'node',format:'esm',alias:{obsidian:resolve('tests/host-obsidian.ts')}});
  const {MemoryModal}=await import(pathToFileURL(outfile).href);
  class Element {
    children:Element[]=[];value='';text='';label='';onclick?:()=>unknown;oninput?:()=>unknown;
    disabled=false; setAttribute(){} setText(text:string){this.text=text;}
    empty(){this.children=[];}
    createEl(_tag:string,options:any={}){const e=new Element();e.text=options.text??'';e.label=options.attr?.['aria-label']??'';this.children.push(e);return e;}
    createDiv(){return this.createEl('div');}
    all():Element[]{return this.children.flatMap(e=>[e,...e.all()]);}
  }
  const modal=new MemoryModal({app:{},state:{settings:{useMemory:true}},memory:()=>store,chat:{id:'test'}});
  const content=new Element();modal.contentEl=content;
  await modal.refresh();
  const edit=(label:string,value:string)=>{const e=content.all().find(e=>e.label===label)!;e.value=value;e.oninput!();};
  content.all().find(e=>e.text==='新增记忆')!.onclick!();
  edit('新记忆','new draft');
  modal.select((await store.snapshot()).entries[0]!.id);
  edit('记忆内容','entry draft');
  content.all().find(e=>e.text==='整理规则')!.onclick!();
  edit('记忆整理规则','rules draft');
  content.all().find(e=>e.text==='记忆')!.onclick!();
  modal.select('add');
  assert.equal(content.all().find(e=>e.label==='新记忆')!.value,'new draft');
  await modal.action(()=>store.update(modal.snapshot.revision,{add:'new draft'}),{key:'add',value:'new draft'});
  modal.select('add'); assert.equal(content.all().find(e=>e.label==='新记忆')!.value,'');
  modal.select((await store.snapshot()).entries[0]!.id);
  assert.equal(content.all().find(e=>e.label==='记忆内容')!.value,'entry draft');
  content.all().find(e=>e.text==='整理规则')!.onclick!();
  assert.equal(content.all().find(e=>e.label==='记忆整理规则')!.value,'rules draft');
  // Text entered during an asynchronous save must also remain available.
  let release!:()=>void;
  const saving=modal.action(()=>new Promise<void>(r=>release=r),{key:'rules',value:'rules draft'});
  edit('记忆整理规则','newer draft');release();await saving;
  assert.equal(content.all().find(e=>e.label==='记忆整理规则')!.value,'newer draft');
  const originalSnapshot=store.snapshot.bind(store);
  store.snapshot=async()=>{throw Error('read unavailable');};
  await modal.action(async()=>{}, {key:'rules',value:'newer draft'});
  assert.ok(content.all().some(e=>e.text.includes('已保存，但读取最新内容失败')));
  assert.ok(content.all().some(e=>e.text==='newer draft'));
  assert.equal(content.all().some(e=>e.text==='保存规则'),false);
  store.snapshot=originalSnapshot;await modal.refresh();
  assert.equal(modal.needsRefresh,false);
});


test('memory refuses symlinked topic files without changing the target',async(t)=>{
  const {store,root}=await fixture();await store.snapshot();
  const topic=join(root,'topics/general.md'),outside=join(root,'external.md');
  await writeFile(outside,'external content');await unlink(topic);
  try {await symlink(outside,topic,'file');}
  catch(error:any){if(error.code==='EPERM'||error.code==='EACCES'){t.skip('Symlinks require privileges on this host');return;}throw error;}
  await assert.rejects(()=>store.snapshot(),/符号链接/);
  assert.equal(await readFile(outside,'utf8'),'external content');
  await assert.rejects(()=>access(join(root,'writer.lock')));
});


test('recall uses overlapping Chinese terms, bounded index, and frozen vault-local entries', async () => {
  const {prepareRecall,readRecall}=await import('../src/plugin/memory/recall.ts');
  const {store}=await fixture();let snapshot=await store.snapshot();
  await store.update(snapshot.revision,{add:'缓存相关内容请用前端例子讲解'});snapshot=await store.snapshot();
  const recall=prepareRecall(snapshot,'什么是缓存');
  for(const query of ['什么是缓存','缓存','缓存是什么','缓']) assert.equal((readRecall(recall,'memory_search',{query}) as any).total,1);
  const id=snapshot.entries[0]!.id;snapshot.entries[0]!.text='modified outside snapshot';
  assert.match((readRecall(recall,'memory_read',{id}) as any).entry.text,/前端/);
  assert.throws(()=>readRecall(recall,'memory_read',{id:'another-vault-id'}),/不在本轮本库/);
  assert.throws(()=>readRecall(recall,'memory_search',{offset:-1}),/offset/);
  const large=prepareRecall({...snapshot,entries:Array.from({length:100},(_,i)=>({...snapshot.entries[0]!,id:String(i),text:'x'.repeat(2000)}))},'x');
  assert.equal(large.index.length,12);assert.ok(large.prompt.length<4000);
});
