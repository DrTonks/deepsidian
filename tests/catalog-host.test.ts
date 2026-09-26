import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp,writeFile,readFile,access,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

await mkdir('.runs',{recursive:true});
const compiled=await mkdtemp(resolve('.runs/catalog-host-bundle-')),outfile=join(compiled,'catalog.mjs');
await build({stdin:{contents:"export {CatalogModal} from './src/plugin/catalog.ts'; export {FileSystemAdapter,TFolder} from 'obsidian';",resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'esm',alias:{obsidian:resolve('tests/host-obsidian.ts')}});
const {CatalogModal,FileSystemAdapter,TFolder}=await import(pathToFileURL(outfile).href);

async function fixture(){
  const root=await mkdtemp(resolve('.runs/catalog-host-'));
  await mkdir(join(root,'posts'));const original='---\ntitle: 原文章\ntags: [agent]\n---\n原文正文\n';
  await writeFile(join(root,'posts/note.md'),original);
  const folder=Object.assign(new TFolder(),{path:'posts'}),file={path:'posts/note.md',extension:'md'};
  const map=new Map<string,any>([['posts',folder],['posts/note.md',file]]),created:string[]=[];
  const adapter=Object.assign(new FileSystemAdapter(),{getBasePath:()=>root,exists:async(path:string)=>{try{await access(join(root,path));return true;}catch(e:any){if(e.code==='ENOENT')return false;throw e;}}});
  const vault={adapter,getAbstractFileByPath:(path:string)=>map.get(path),getMarkdownFiles:()=>[file],createFolder:async(path:string)=>{await mkdir(join(root,path));map.set(path,Object.assign(new TFolder(),{path}));},create:async(path:string,text:string)=>{await writeFile(join(root,path),text,{flag:'wx'});created.push(path);map.set(path,{path,stat:{size:Buffer.byteLength(text)}});}};
  Object.assign(vault,{getFileByPath:(path:string)=>map.get(path),read:(file:any)=>readFile(join(root,file.path),'utf8'),process:async(file:any,fn:(text:string)=>string)=>{const current=await readFile(join(root,file.path),'utf8');await writeFile(join(root,file.path),fn(current));}});
  const metadataCache={getFileCache:(_file:any)=>({frontmatter:{title:'原文章',tags:['agent']}})};
  // Only skip rendering; preview/create are the real production methods and use disk-backed Vault operations.
  const modal=Object.assign(Object.create(CatalogModal.prototype),{app:{vault,metadataCache},source:'posts',output:'_本地管理',busy:false,closed:false,message:'',render:()=>{}});
  return {root,modal,vault,metadataCache,created,original};
}

test('catalog preview is read-only and confirmation creates exactly the two previewed files',async()=>{
  const {root,modal,created,original}=await fixture();
  await modal.preview();assert.equal(modal.plan.count,1);assert.deepEqual(created,[]);
  await assert.rejects(access(join(root,'_本地管理')));
  const plan=modal.plan;await modal.create();
  assert.deepEqual(created,['_本地管理/文章管理.base','_本地管理/文章导航.md']);
  assert.equal(await readFile(join(root,created[0]!),'utf8'),plan.base);
  assert.equal(await readFile(join(root,created[1]!),'utf8'),plan.navigation);
  assert.equal(await readFile(join(root,'posts/note.md'),'utf8'),original);assert.match(modal.message,/已创建/);assert.equal(modal.plan,undefined);
});

test('catalog rechecks a file added after preview and never overwrites it or creates its sibling',async()=>{
  const {root,modal,created,original}=await fixture();await modal.preview();
  await mkdir(join(root,'_本地管理'));await writeFile(join(root,'_本地管理/文章导航.md'),'用户已有导航');
  await modal.create();assert.deepEqual(created,[]);assert.match(modal.message,/已存在/);
  assert.equal(await readFile(join(root,'_本地管理/文章导航.md'),'utf8'),'用户已有导航');
  await assert.rejects(access(join(root,'_本地管理/文章管理.base')));
  assert.equal(await readFile(join(root,'posts/note.md'),'utf8'),original);
});

test('catalog previews and creates a published-date Astro schema without altering the article',async()=>{
  const {root,modal,metadataCache}=await fixture();
  const original='---\ntitle: 合成博客文章\npublished: 2026-09-26\ncategory: 开发\ntags: [astro]\ndraft: false\n---\n合成正文\n';
  await writeFile(join(root,'posts/note.md'),original);
  metadataCache.getFileCache=()=>({frontmatter:{title:'合成博客文章',published:'2026-09-26',category:'开发',tags:['astro'],draft:false}} as any);
  await modal.preview();
  assert.equal(modal.plan.missing.published,0);
  await modal.create();
  assert.match(await readFile(join(root,'_本地管理/文章管理.base'),'utf8'),/if\(note\.published, note\.published, if\(date, date, pubDate\)\)/);
  assert.match(await readFile(join(root,'_本地管理/文章导航.md'),'utf8'),/- published：0 篇缺失/);
  assert.equal(await readFile(join(root,'posts/note.md'),'utf8'),original);
});

test('catalog preserves the first output and accurately reports failure of the second',async()=>{
  const {root,modal,vault,created,original}=await fixture();await modal.preview();
  const create=vault.create;vault.create=async(path,text)=>{if(path.endsWith('.md'))throw Error('模拟磁盘空间不足');return create(path,text);};
  await modal.create();assert.deepEqual(created,['_本地管理/文章管理.base']);
  assert.match(modal.message,/磁盘空间不足/);assert.match(modal.message,/保留供检查；其余未完成/);
  assert.equal(await readFile(join(root,'posts/note.md'),'utf8'),original);
  await assert.rejects(access(join(root,'_本地管理/文章导航.md')));
});

test('catalog invalidated previews cannot create files and unavailable metadata blocks preview',async()=>{
  const {modal,created,metadataCache}=await fixture();await modal.preview();assert.ok(modal.plan);
  modal.output='new-output';modal.invalidate();await modal.create();assert.deepEqual(created,[]);assert.match(modal.message,/重新扫描/);
  metadataCache.getFileCache=()=>null as any;await modal.preview();assert.equal(modal.plan,undefined);assert.match(modal.message,/索引尚未就绪/);
});

test('catalog refuses a junction inserted at output after preview',async(t)=>{
  const {root,modal,created}=await fixture();await modal.preview();
  const outside=await mkdtemp(resolve('.runs/catalog-outside-'));
  try{await symlink(outside,join(root,'_本地管理'),process.platform==='win32'?'junction':'dir');}
  catch(e:any){if(e.code==='EPERM'){t.skip('Host does not allow junction creation');return;}throw e;}
  await modal.create();assert.deepEqual(created,[]);assert.match(modal.message,/junction/);
  await assert.rejects(access(join(outside,'文章管理.base')));
});


test('catalog update preserves edited Base and user navigation sections, then refuses stale previews',async()=>{
  const {root,modal,metadataCache}=await fixture();await modal.preview();await modal.create();
  const nav=join(root,'_本地管理/文章导航.md'),base=join(root,'_本地管理/文章管理.base');
  await writeFile(base,'custom Base settings');
  await writeFile(nav,'个人前言\n'+await readFile(nav,'utf8')+'\n个人后记');
  metadataCache.getFileCache=()=>({frontmatter:{title:'新标题',tags:['agent'],category:'开发'}} as any);
  await modal.preview();assert.equal(modal.update.changed.length,1);await modal.create();
  assert.equal(await readFile(base,'utf8'),'custom Base settings');
  const result=await readFile(nav,'utf8');assert.ok(result.startsWith('个人前言'));assert.ok(result.endsWith('个人后记'));assert.match(result,/新标题/);
  await modal.preview();await writeFile(nav,result+'\n预览后的修改');await modal.create();
  assert.match(modal.message,/预览后导航已变更/);assert.equal(await readFile(nav,'utf8'),result+'\n预览后的修改');
});

test('catalog refuses user changes in its generated section and unsaved navigation edits',async()=>{
  const {root,modal}=await fixture();await modal.preview();await modal.create();
  const nav=join(root,'_本地管理/文章导航.md'),original=await readFile(nav,'utf8');
  modal.app.workspace={getLeavesOfType:()=>[{view:{file:{path:'_本地管理/文章导航.md'},editor:{getValue:()=>original+'unsaved'}}}]};
  await modal.preview();assert.equal(modal.plan,undefined);assert.match(modal.message,/未保存/);
  modal.app.workspace=undefined;await writeFile(nav,original.replace('# 文章导航','# 手写导航'));
  await modal.preview();assert.equal(modal.plan,undefined);assert.match(modal.message,/已被编辑/);
});

test('catalog rechecks unsaved edits after waiting for the Vault process callback',async()=>{
  const {root,modal,vault,metadataCache}=await fixture();await modal.preview();await modal.create();
  const nav=join(root,'_本地管理/文章导航.md'),original=await readFile(nav,'utf8');
  let editorText=original;
  modal.app.workspace={getLeavesOfType:()=>[{view:{file:{path:'_本地管理/文章导航.md'},editor:{getValue:()=>editorText}}}]};
  metadataCache.getFileCache=()=>({frontmatter:{title:'新标题',tags:['agent']}});
  await modal.preview();assert.ok(modal.update);
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(r=>entered=r),resume=new Promise<void>(r=>release=r);
  const process=(vault as any).process;
  (vault as any).process=async(file:any,fn:(text:string)=>string)=>{entered();await resume;return process(file,fn);};
  const creating=modal.create();await waiting;
  editorText=original+'\n另一个窗口的未保存编辑';release();await creating;
  assert.match(modal.message,/未保存编辑/);
  assert.equal(await readFile(nav,'utf8'),original);
  assert.equal(editorText,original+'\n另一个窗口的未保存编辑');
});

test('catalog accepts CRLF on disk with LF editor text but still rejects real unsaved changes',async()=>{
  const {EditorState}=await import('@codemirror/state');
  const {root,modal,metadataCache}=await fixture();await modal.preview();await modal.create();
  const nav=join(root,'_本地管理/文章导航.md');
  const original=(await readFile(nav,'utf8')).replace(/\n/g,'\r\n');await writeFile(nav,original);
  let editorText=EditorState.create({doc:original}).doc.toString();
  assert.notEqual(editorText,original);
  modal.app.workspace={getLeavesOfType:()=>[{view:{file:{path:'_本地管理/文章导航.md'},editor:{getValue:()=>editorText}}}]};
  metadataCache.getFileCache=()=>({frontmatter:{title:'新标题',tags:['agent']}});
  await modal.preview();assert.ok(modal.update,modal.message);
  await modal.create();assert.match(modal.message,/导航已更新/);
  const updated=await readFile(nav,'utf8');assert.match(updated,/新标题/);assert.doesNotMatch(updated,/(?<!\r)\n/);
  editorText=EditorState.create({doc:updated}).doc.toString()+'\n真实未保存编辑';
  await modal.preview();assert.equal(modal.plan,undefined);assert.match(modal.message,/未保存编辑/);
  assert.equal(await readFile(nav,'utf8'),updated);
});
