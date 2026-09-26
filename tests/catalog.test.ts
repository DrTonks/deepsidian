import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {catalogPath,assertCatalogPath,buildCatalog,CATALOG_LIMIT,navigationUpdate,readNavigation} from '../src/plugin/catalog-core.ts';

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

test('Astro published dates are present and take priority in the generated Base without changing source metadata',()=>{
  const articles=[
    {path:'posts/astro.md',frontmatter:{title:'Astro 合成文章',published:'2026-09-26',category:'开发',tags:['astro'],draft:false}},
    {path:'posts/combined.md',frontmatter:{published:'2026-09-26',date:'2025-01-01',pubDate:'2024-01-01'}},
    {path:'posts/date.md',frontmatter:{published:'',date:'2026-09-25'}},
    {path:'posts/pubdate.md',frontmatter:{published:null,pubDate:'2026-09-24'}},
    {path:'posts/undated.md',frontmatter:{published:'',date:null,pubDate:''}},
  ];
  const before=structuredClone(articles),plan=buildCatalog(articles,'posts','_本地管理');
  assert.equal(plan.missing.published,1);
  assert.match(plan.navigation,/- published：1 篇缺失/);
  const formula=JSON.parse(plan.base.split('\n').find(line=>line.startsWith('  published: '))!.slice('  published: '.length));
  assert.equal(formula,'if(note.published, note.published, if(date, date, pubDate))');
  assert.match(plan.base,/formula\.published:\n    displayName: "发布日期"/);
  assert.deepEqual(articles,before);
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


test('managed navigation previews additions, removals and category/title changes while retaining user sections',()=>{
  const before=buildCatalog([{path:'posts/a.md',frontmatter:{title:'Old',category:'学习'}},{path:'posts/deleted.md'}],'posts','out');
  const after=buildCatalog([{path:'posts/a.md',frontmatter:{title:'New',categories:['开发']}},{path:'posts/added.md'}],'posts','out');
  const update=navigationUpdate('手写前言\n'+before.navigation+'\n手写后记',after,'posts');
  assert.equal(update.added[0].path,'posts/added.md');assert.equal(update.removed[0].path,'posts/deleted.md');
  assert.equal(update.changed[0].before.category,'学习');assert.equal(update.changed[0].after.category,'开发');
  assert.ok(update.text.startsWith('手写前言\n'));assert.ok(update.text.endsWith('\n手写后记'));
  assert.equal(readNavigation(update.text).body,readNavigation(after.navigation).body);
  assert.throws(()=>navigationUpdate(before.navigation.replace('## 学习','## 手写分类'),after,'posts'),/已被编辑/);
  assert.throws(()=>navigationUpdate(before.navigation,after,'other'),/扫描范围/);
  assert.throws(()=>navigationUpdate('# 旧版导航',after,'posts'),/旧版/);
  assert.throws(()=>readNavigation(before.navigation+before.navigation),/唯一/);
});

test('category arrays and categories alias share the first-category navigation behavior',()=>{
  const plan=buildCatalog([{path:'a.md',frontmatter:{category:['学习','开发']}},{path:'b.md',frontmatter:{categories:['学习','开发']}}],'','out');
  assert.deepEqual(plan.entries.map(e=>e.category),['学习','学习']);assert.equal(plan.missing.category,0);
});

test('managed navigation accepts Windows line endings and preserves surrounding text exactly',()=>{
  const before=buildCatalog([{path:'posts/a.md',frontmatter:{title:'原标题'}}],'posts','out');
  const after=buildCatalog([{path:'posts/a.md',frontmatter:{title:'新标题'}}],'posts','out');
  const crlf=before.navigation.replace(/\n/g,'\r\n');
  assert.equal(readNavigation(crlf).source,'posts');
  const prefix='个人前言\r\n\n',suffix='\r\n个人后记\n';
  const update=navigationUpdate(prefix+crlf+suffix,after,'posts');
  assert.equal(update.changed.length,1);
  assert.ok(update.text.startsWith(prefix));assert.ok(update.text.endsWith(suffix));
  const parsed=readNavigation(update.text);
  assert.equal(parsed.body,readNavigation(after.navigation).body.replace(/\n/g,'\r\n'));
  assert.equal(parsed.lineEnding,'\r\n');
  assert.equal(update.text.slice(0,parsed.start),prefix);
  assert.equal(update.text.slice(parsed.end),'\r\n'+suffix);
  assert.throws(()=>readNavigation(crlf.replace('# 文章导航','# 人工改动')),/已被编辑/);
});
