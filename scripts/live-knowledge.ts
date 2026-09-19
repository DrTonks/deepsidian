/** Paid real-DSH acceptance against an isolated synthetic vault, never personal notes. */
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import type {App,TFile} from 'obsidian';
import {DshClient,discover,assistantText} from '../src/plugin/dsh.ts';
import {KnowledgeTools} from '../src/plugin/knowledge.ts';

const env=discover(),model={provider:'deepseek-official',model:'deepseek-flash'};
await mkdir('.runs',{recursive:true});const output=await mkdtemp(resolve('.runs/live-knowledge-'));
const entries:Record<string,{text:string;fm:Record<string,unknown>}>={
  'posts/cache.md':{text:'# 缓存实验\n## 特殊结论\n本合成实验的阈值是 7319，标记为 CEDAR-KV。\n## 不相关内容\n这里不是答案。',fm:{title:'缓存实验 CEDAR-KV',category:'学习',tags:['runtime'],draft:false}},
  'posts/draft.md':{text:'# 尚未发布\n草稿',fm:{title:'草稿 FALSE-DRAFT',category:'学习',tags:['runtime'],draft:true}},
  'posts/garden.md':{text:'# 园艺\n植物',fm:{title:'园艺 FALSE-GARDEN',category:'生活',tags:['garden'],draft:false}},
  'posts/linked.md':{text:'# 关联资料\n关联证据',fm:{title:'关联资料 MAPLE-LINK',category:'参考',tags:[],draft:false}},
  'posts/tagged.md':{text:'# 标签资料\n标签证据',fm:{title:'标签资料 BIRCH-TAG',category:'参考',tags:['runtime'],draft:false}},
};
const files=Object.keys(entries).map(path=>({path,basename:path.split('/').at(-1)!.replace(/\.md$/,''),extension:'md',stat:{size:entries[path]!.text.length}}));
const app={vault:{getMarkdownFiles:()=>files,getAbstractFileByPath:(path:string)=>files.find(f=>f.path===path)},metadataCache:{
  resolvedLinks:{'posts/cache.md':{'posts/linked.md':1}},
  getFileCache:(file:TFile)=>({frontmatter:entries[file.path]!.fm}),
  getFirstLinkpathDest:(link:string)=>files.find(f=>f.path===link||f.path===link+'.md'||f.basename===link),
}} as unknown as App;
const knowledge=new KnowledgeTools(app,async path=>{if(!Object.hasOwn(entries,path))throw Error('Synthetic vault boundary');},async file=>entries[file.path]!.text);
const cases:any[]=[];let active:any;
const report=(status:string)=>writeFile(join(output,'report.json'),JSON.stringify({status,synthetic:true,versions:env.versions,model,fixtures:entries,cases},null,2));
const client=new DshClient({packageRoot:env.root,nodePath:env.node,dshHome:env.home,runtimeHome:join(output,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:output,...model,maxTokens:1400},async(name,args)=>{
  const call:any={name,args};active.tools.push(call);
  try {
    if(active.tools.length>16)throw Error('Tool budget exhausted');
    if(name==='obsidian_context')call.result={path:'posts/cache.md',selection:'',nearby:''};
    else if(name==='obsidian_metadata') {
      const path=String(args.path??'');if(!Object.hasOwn(entries,path))throw Error('Synthetic vault boundary');
      const entry=entries[path]!;
      call.result={path,headings:entry.text.split('\n').flatMap((line,index)=>{const match=/^(#{1,6}) (.+)$/.exec(line);return match?[{text:match[2],level:match[1]!.length,line:index+1}]:[];}),tags:entry.fm.tags,links:Object.keys(app.metadataCache.resolvedLinks[path]??{}).map(link=>({link})),backlinks:Object.entries(app.metadataCache.resolvedLinks).filter(([,links])=>links[path]).map(([source])=>source)};
    }
    else if(['obsidian_query','obsidian_resolve','obsidian_related','obsidian_base'].includes(name))call.result=await knowledge.handle(name,args,'posts/cache.md');
    else throw Error('This synthetic fixture supports knowledge tools only');
    return call.result;
  } catch {call.error='tool-rejected';throw Error('Synthetic tool rejected');}
},(method,data)=>{
  if(method==='session.event'&&data.event.type==='assistant/message') {
    active.response+=assistantText(data.event.data.stream);
    const usage:Record<string,number>={};for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens']) {const value=data.event.data.usage?.[key];if(typeof value==='number')usage[key]=value;}
    active.usage.push(usage);
  }
});
async function run(name:string,question:string,check:()=>void) {
  active={name,question,sessionId:randomUUID(),status:'started',response:'',tools:[],usage:[]};cases.push(active);await report('running');
  try {
    const result=await client.prompt(active.sessionId,question);assert.equal(result.kind,'completed');check();active.status='passed-automatic';
  } catch {active.status='failed';}
  await report('running');
}
try {
  await run('query-published-learning','请查一下 posts 目录下分类为“学习”、draft 为 false 的文章，只列符合条件的文章标题和路径，不要读全文。',()=>{
    assert.ok(active.tools.some((t:any)=>t.name==='obsidian_query'&&t.args.folder==='posts'&&t.args.category==='学习'&&t.args.draft===false));
    assert.match(active.response,/CEDAR-KV/);assert.match(active.response,/posts\/cache\.md/);assert.doesNotMatch(active.response,/FALSE-DRAFT|FALSE-GARDEN/);
  });
  await run('resolve-heading','请只阅读 [[posts/cache#特殊结论]] 指向的小节，告诉我实验阈值和标记，并给出来源。',()=>{
    assert.ok(active.tools.some((t:any)=>t.name==='obsidian_resolve'&&t.result?.subpath==='特殊结论'&&t.result?.startLine===2));assert.match(active.response,/7319/);assert.match(active.response,/CEDAR-KV/);
  });
  await run('related-evidence','当前笔记是 posts/cache.md。帮我找与它直接关联的笔记，区分链接关系和共同标签，不要读文章正文，也不要推断我掌握了什么。请列标题、路径和关联理由。',()=>{
    assert.ok(active.tools.some((t:any)=>t.name==='obsidian_related'));
    assert.match(active.response,/MAPLE-LINK/);assert.match(active.response,/BIRCH-TAG/);assert.match(active.response,/链接/);assert.match(active.response,/标签/);
    assert.ok(active.tools.every((t:any)=>!['obsidian_read','obsidian_resolve'].includes(t.name)));
  });
  const passed=cases.every(c=>c.status==='passed-automatic');await report(passed?'passed-automatic-review-pending':'failed');console.log(`知识库付费验收 ${cases.filter(c=>c.status==='passed-automatic').length}/${cases.length}: ${output}`);
  if(!passed)process.exitCode=1;
}finally {await client.stop();}
