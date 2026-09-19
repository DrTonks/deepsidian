/** Paid natural-language acceptance, isolated synthetic data only. */
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {DshClient,discover,configuredModels,assistantText} from '../src/plugin/dsh.ts';
import {MemoryStore} from '../src/plugin/memory/store.ts';
import {MemoryManager,MANAGEMENT_ENABLED,MANAGEMENT_DISABLED} from '../src/plugin/memory/manage.ts';
import {prepareRecall,readRecall,type Recall} from '../src/plugin/memory/recall.ts';
import {buildPrompt,EMPTY_CONTEXT} from '../src/plugin/context.ts';
const env=discover(),model=configuredModels(env.root,env.home).selected;
await mkdir('.runs',{recursive:true});const output=await mkdtemp(resolve('.runs/live-manage-'));
const store=new MemoryStore(join(output,'memory'));let enabled=false,active:any,recall:Recall,manager:MemoryManager;
const cases:any[]=[];
const report=(status:string)=>writeFile(join(output,'report.json'),JSON.stringify({status,synthetic:true,versions:env.versions,model,cases},null,2));
const createClient=()=>new DshClient({packageRoot:env.root,nodePath:env.node,dshHome:env.home,runtimeHome:join(output,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:resolve('fixtures'),...model,maxTokens:2048,manageMemory:enabled},async(name,args)=>{
  const call:any={name,args};active.tools.push(call);
  try {
    if(name==='memory_manage') {if(!enabled)throw Error('management disabled');call.result=await manager.execute(args);recall=prepareRecall(manager.snapshot,'');}
    else if(['memory_search','memory_read'].includes(name))call.result=readRecall(recall,name,args);
    else throw Error('Synthetic acceptance only permits memory tools');
    return call.result;
  }catch {call.error='tool-rejected';throw Error('Synthetic tool request rejected');}
},(method,data)=>{
  if(method==='session.event'&&data.event.type==='assistant/message') {
    active.response+=assistantText(data.event.data.stream);
    const safe:Record<string,number>={};for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens']) {const v=data.event.data.usage?.[key];if(typeof v==='number')safe[key]=v;}
    active.usage.push(safe);
  }
});
let client=createClient();
async function ask(name:string,question:string,check:(before:any,after:any)=>void,id=randomUUID()) {
  const before=await store.snapshot();recall=prepareRecall(before,question);
  manager=new MemoryManager(store,before,{chatId:id,index:cases.length*2,text:question},()=>{if(!enabled)throw Error('management disabled');});
  active={name,question,sessionId:id,enabled,status:'started',response:'',tools:[],usage:[],before};cases.push(active);await report('running');
  try {
    const prompt=buildPrompt(question,'',EMPTY_CONTEXT)+'\n\n'+recall.prompt+'\n\n'+(enabled?MANAGEMENT_ENABLED:MANAGEMENT_DISABLED);
    active.prompt=prompt;await report('running');
    const result=await client.prompt(id,prompt);assert.equal(result.kind,'completed');
    active.after=await store.snapshot();check(before,active.after);active.status='passed-automatic';await report('running');
  }catch {active.status='failed';await report('failed');throw Error(`付费管理验收失败；保留输出不自动重试：${output}`);}
}
const unchanged=(before:any,after:any)=>assert.deepEqual(after.entries,before.entries);
try {
  await ask('disabled-explicit-request','请记住，我的验收代号是 CEDAR-731。',unchanged);
  await client.stop();enabled=true;client=createClient();
  await ask('natural-add','请记住，我的验收代号是 CEDAR-731，以后跨会话也要记得。',(_b,a)=>{assert.equal(a.entries.length,1);assert.match(a.entries[0].text,/CEDAR-731/);assert.ok(active.tools.some((t:any)=>t.name==='memory_manage'&&t.result?.status==='committed'));assert.doesNotMatch(active.response,/示例|例子|定位|无需|不必/);});
  await ask('new-session-recall','我的验收代号是什么？', (b,a)=>{unchanged(b,a);assert.match(active.response,/CEDAR-731/);assert.doesNotMatch(active.response,/\[\[|示例|例子|定位|无需|不必/);assert.ok(active.tools.some((t:any)=>t.name==='memory_read'));});
  await ask('natural-correction','请更正我的长期记忆：验收代号改为 MAPLE-942，原来的代号作废。',(b,a)=>{assert.equal(a.entries.length,1);assert.equal(a.entries[0].id,b.entries[0].id);assert.match(a.entries[0].text,/MAPLE-942/);assert.doesNotMatch(a.entries[0].text,/CEDAR-731/);});
  await ask('quoted-fiction','帮我润色小说台词：“请记住，我的验收代号是 FALSE-333。”这是虚构角色说的话，不是我的要求。',unchanged);
  await ask('temporary-request','仅这次请用 JavaScript 举例介绍闭包，不是长期偏好，不要记住。',unchanged);
  await ask('natural-forget','请忘记我的验收代号，删除这条长期记忆。',(_b,a)=>{assert.equal(a.entries.length,0);assert.ok(a.excludedSources.length>0);});
  await client.stop();enabled=false;client=createClient();
  await ask('disabled-after-reconnect','请记住，我的验收代号是 CLOSED-444。',unchanged);
  await report('passed-automatic-review-pending');console.log(`付费自然语言管理验收：${output}`);
}finally {await client.stop();}
