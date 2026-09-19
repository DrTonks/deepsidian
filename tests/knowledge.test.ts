import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('.runs',{recursive:true});const dir=await mkdtemp(resolve('.runs/knowledge-test-')),outfile=join(dir,'knowledge.mjs');
await build({entryPoints:['src/plugin/knowledge.ts'],outfile,bundle:true,platform:'node',format:'esm'});
const {KnowledgeTools,linkedExcerpt,publicPath}=await import(pathToFileURL(outfile).href);
function host(entries:Record<string,{text?:string;fm?:Record<string,unknown>;tags?:string[]}>,links:Record<string,Record<string,number>>={},blocked:string[]=[]) {
  const files=Object.keys(entries).map(path=>({path,basename:path.split('/').at(-1)!.replace(/\.[^.]+$/,''),extension:path.split('.').at(-1),stat:{size:entries[path]!.text?.length??0}}));
  const disclosed:string[]=[],read:string[]=[];
  const app={vault:{getMarkdownFiles:()=>files.filter(f=>f.extension==='md'),getAbstractFileByPath:(path:string)=>files.find(f=>f.path===path)},metadataCache:{resolvedLinks:links,getFileCache:(file:any)=>{assert.ok(!blocked.includes(file.path));disclosed.push(file.path);return {frontmatter:entries[file.path]!.fm,tags:entries[file.path]!.tags?.map(tag=>({tag}))};},getFirstLinkpathDest:(link:string)=>files.find(f=>f.path===link||f.path===link+'.md'||f.basename===link)}};
  return {tools:new KnowledgeTools(app,async(path:string)=>{if(blocked.includes(path))throw Error('outside');},async(file:any)=>{assert.ok(!blocked.includes(file.path));read.push(file.path);return entries[file.path]!.text??'';}),disclosed,read};
}
test('query paginates metadata, excludes hidden and containment failures, bounds long properties',async()=>{
  const entries:any={'.private/secret.md':{fm:{title:'secret'}},'symlink.md':{fm:{title:'outside'}}};
  for(let i=0;i<24;i++)entries[`posts/${String(i).padStart(2,'0')}.md`]={fm:{title:'Article '+i,tags:['agent'],category:'Learning',draft:false,description:'a'.repeat(5000)}};
  const {tools,disclosed,read}=host(entries,{},['symlink.md']);
  const first:any=await tools.handle('obsidian_query',{folder:'posts',tag:'#agent',category:'Learning',draft:false},'');
  assert.equal(first.results.length,20);assert.equal(first.nextOffset,20);assert.equal(first.truncated,true);assert.equal(first.results[0].properties.description.length,200);assert.equal(first.results[0].propertiesTruncated,true);
  const second:any=await tools.handle('obsidian_query',{offset:20},'');assert.equal(second.results.length,4);assert.equal(second.nextOffset,null);
  assert.ok(!disclosed.includes('.private/secret.md'));assert.ok(!disclosed.includes('symlink.md'));assert.deepEqual(read,[]);
  await assert.rejects(()=>tools.handle('obsidian_query',{folder:'../outside'},''));
});
test('fresh text resolves headings, nested sections and blocks without full-note fallback',()=>{
  const text='---\ntitle: Sample\n---\n# Main\nIntro\n## New title\nparagraph\n### Child\nchild\n## Next\nend\n\nFirst paragraph\nsecond line ^target\n\n```md\n## Fake\ncode ^fake\n```';
  const heading=linkedExcerpt(text,'New title');assert.equal(heading.startLine,6);assert.equal(heading.endLine,9);assert.match(heading.content,/child/);assert.doesNotMatch(heading.content,/Next/);
  const block=linkedExcerpt(text,'^target');assert.equal(block.startLine,13);assert.equal(block.endLine,14);
  assert.throws(()=>linkedExcerpt(text,'Fake'),/不会回退/);assert.throws(()=>linkedExcerpt(text,'^fake'),/不会回退/);assert.throws(()=>linkedExcerpt(text,'Missing'),/不会回退/);
  assert.equal(linkedExcerpt('x'.repeat(9000),'').content.length,6000);
});
test('resolve accepts aliases and local anchors but rejects hidden, non-markdown and escaped targets',async()=>{
  const {tools}=host({'source.md':{text:'# Source\nbody'},'notes/target.md':{text:'# Target\n## Fresh\nunsaved'},'map.base':{text:'views: []'},'.secret.md':{text:'secret'},'escaped.md':{text:'outside'}},{},['escaped.md']);
  const result:any=await tools.handle('obsidian_resolve',{link:'[[target#Fresh|alias]]'},'source.md');assert.equal(result.path,'notes/target.md');assert.equal(result.content,'## Fresh\nunsaved');
  assert.equal((await tools.handle('obsidian_resolve',{link:'[[#Source]]'},'source.md') as any).startLine,1);
  for(const link of ['[[.secret]]','[[../escape]]','[[map.base]]','[[escaped]]'])await assert.rejects(()=>tools.handle('obsidian_resolve',{link},'source.md'));
});
test('related returns bounded one-hop and tag reasons without reading text or unsafe metadata',async()=>{
  const {tools,read}=host({'a.md':{fm:{tags:['agent']}},'b.md':{fm:{tags:['agent']}},'c.md':{},'d.md':{},'.hidden.md':{},'outside.md':{}},{'a.md':{'b.md':1,'outside.md':1},'c.md':{'a.md':1}},['outside.md']);
  const result:any=await tools.handle('obsidian_related',{},'a.md');assert.deepEqual(result.candidates.map((x:any)=>x.path),['b.md','c.md']);assert.equal(result.candidates[0].reasons.length,2);assert.deepEqual(read,[]);
});
test('base returns bounded raw configuration as data and never evaluates expressions',async()=>{
  const text='filters:\n  and: [dangerous()]\n'+ 'x'.repeat(15000),{tools}=host({'map.base':{text}});
  const result:any=await tools.handle('obsidian_base',{path:'map.base'},'');assert.equal(result.content.length,12000);assert.equal(result.truncated,true);assert.match(result.notice,/不是表格查询结果/);
  for(const path of ['../outside.base','.hidden/map.base','C:/map.base'])assert.throws(()=>publicPath(path,'base'));
});
test('query reports scan cutoff, rejects malformed folders and keeps pages within output budget',async()=>{
  const entries:any={};for(let i=0;i<2005;i++)entries[`n${String(i).padStart(4,'0')}.md`]={fm:{title:'x'.repeat(200),description:'y'.repeat(200)}};
  const {tools,disclosed}=host(entries);const result:any=await tools.handle('obsidian_query',{},'');
  assert.equal(result.scanned,2000);assert.equal(disclosed.length,2000);assert.equal(result.scanTruncated,true);assert.ok(JSON.stringify(result.results).length<29000);
  for(const folder of ['..','a/../b','a\u0000b','C:/notes','.obsidian'])await assert.rejects(()=>tools.handle('obsidian_query',{folder},''));
  assert.throws(()=>linkedExcerpt('- list item ^list','^list'),/暂只支持/);
  assert.equal(linkedExcerpt('Heading\n=======\nbody\nNext\n====\nend','Heading').content,'Heading\n=======\nbody');
});

test('query applies folder scope before scan cap and does not drop colliding property names',async()=>{
  const entries:any={};for(let i=0;i<2005;i++)entries[`a/${i}.md`]={};
  const prefix='p'.repeat(80);entries['z/target.md']={fm:{title:'target',[prefix+'one']:'one',[prefix+'two']:'two'}};
  const {tools}=host(entries);const result:any=await tools.handle('obsidian_query',{folder:'z'},'');
  assert.equal(result.scanned,1);assert.equal(result.results.length,1);assert.equal(result.scanTruncated,false);
  assert.equal(result.results[0].propertiesTruncated,true);
});

test('a Base can be a link resolution source but cannot become a Markdown target',async()=>{
  const {tools}=host({'map.base':{text:'views: []'},'target.md':{text:'# Target\nbody'}});
  const result:any=await tools.handle('obsidian_resolve',{link:'[[target#Target]]'},'map.base');
  assert.equal(result.content,'# Target\nbody');
  await assert.rejects(()=>tools.handle('obsidian_resolve',{link:'[[#Target]]'},'map.base'));
});
