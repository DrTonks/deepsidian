import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {catalogPath,assertCatalogPath,buildCatalog,CATALOG_LIMIT} from '../src/plugin/catalog-core.ts';

test('catalog supports existing field aliases without guessing dates or changing originals',()=>{
  const articles=[
    {path:'posts/one.md',frontmatter:{title:'第一篇',category:'学习',tags:['agent'],date:'2026-01-01',draft:false}},
    {path:'posts/two.md',frontmatter:{categories:['开发','学习'],pubDate:'2026-01-02',draft:true}},
    {path:'posts/three.md',frontmatter:{title:'第三篇',draft:'false'}},
    {path:'other.md',frontmatter:{title:'范围外'}},
  ];
  const before=JSON.stringify(articles),plan=buildCatalog(articles,'posts','_本地管理');
  assert.equal(JSON.stringify(articles),before);
  assert.equal(plan.count,3);assert.deepEqual(plan.missing,{title:1,category:1,tags:2,published:1,draft:1});
  assert.match(plan.base,/file\.inFolder/);assert.match(plan.base,/pubDate/);assert.match(plan.base,/categories/);
  assert.doesNotMatch(plan.base,/mtime|ctime/);assert.match(plan.base,/draft == true/);
  assert.match(plan.navigation,/## 开发/);assert.match(plan.navigation,/## 未分类/);assert.doesNotMatch(plan.navigation,/范围外/);
});

test('catalog destinations and labels escape Markdown syntax and exclude output directory',()=>{
  const plan=buildCatalog([{path:'posts/a)#x.md',frontmatter:{title:'[link]\n<script>'}},{path:'_本地管理/文章导航.md'}],'','_本地管理');
  assert.equal(plan.count,1);assert.match(plan.navigation,/posts\/a%29%23x.md/);
  assert.match(plan.navigation,/\\\[link\\\]/);assert.doesNotMatch(plan.navigation,/<script>/);
  assert.match(buildCatalog([{path:'x.md'}],'','a/b').navigation,/\.\.\/\.\.\/x.md/);
});

test('catalog relative paths reject traversal, absolute, hidden, stream and Windows aliases',()=>{
  for(const path of ['../notes','a/../b','/tmp','C:/notes','a\\b','.obsidian','a/.secret','a//b','a/','a/CON.txt','a/NUL','a/b.','a/b ','a:name'])assert.throws(()=>catalogPath(path));
  assert.equal(catalogPath('',true),'');assert.equal(catalogPath('posts/学习'),'posts/学习');assert.throws(()=>catalogPath(''));
  assert.throws(()=>buildCatalog(Array.from({length:CATALOG_LIMIT+1},(_,i)=>({path:`${i}.md`})),'','output'),/2000/);
});

test('catalog containment verifies missing output and refuses directory junctions',async(t)=>{
  await mkdir('.runs',{recursive:true});const root=await mkdtemp(resolve('.runs/catalog-'));
  await mkdir(resolve(root,'posts'));await writeFile(resolve(root,'posts/a.md'),'hello');
  await assertCatalogPath(root,'posts/a.md');await assertCatalogPath(root,'new/nested/file.base',true);
  await assert.rejects(assertCatalogPath(root,'../outside',true));
  try{await symlink(resolve(root,'posts'),resolve(root,'linked'),process.platform==='win32'?'junction':'dir');}
  catch(e:any){if(e.code==='EPERM'){t.skip('Windows does not allow test junction creation');return;}throw e;}
  await assert.rejects(assertCatalogPath(root,'linked/a.md'),/junction/);
  await assert.rejects(assertCatalogPath(root,'linked/new.base',true),/junction/);
});
