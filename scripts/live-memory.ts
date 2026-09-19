/** Paid, synthetic end-to-end memory acceptance. Never opens the user's vault. */
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DshClient, discover, configuredModels } from '../src/plugin/dsh.ts';
import { MemoryStore } from '../src/plugin/memory/store.ts';
import { prepareRecall, readRecall, type Recall } from '../src/plugin/memory/recall.ts';

const env = discover(), model = configuredModels(env.root, env.home).selected;
const output = resolve('.runs', `live-memory-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(output, {recursive:true});
const memory = new MemoryStore(join(output, 'memory'));
const options = {packageRoot:env.root, nodePath:env.node, dshHome:env.home, runtimeHome:join(output,'runtime'), bridgePath:resolve('src/plugin/bridge.mjs'), cwd:resolve('fixtures'), ...model, maxTokens:2048};
let recall:Recall;
let active:any;
const cases:any[]=[];
const report=(status:string)=>writeFileSync(join(output,'report.json'),JSON.stringify({at:new Date().toISOString(),status,synthetic:true,versions:env.versions,model,cases},null,2));
const makeClient=()=>new DshClient(options,async(name,args)=>{
  if(!['memory_search','memory_read'].includes(name))throw Error('This acceptance fixture only exposes memory results');
  const result=readRecall(recall,name,args);active.tools.push({name,args,result});return result;
},(method,data)=>{
  if(method==='deepsidian.stream' && data.frame.chunk?.type==='text-delta')active.response+=data.frame.chunk.text;
  if(method==='session.event' && data.event.type==='assistant/message' && data.event.data.usage)active.usage.push(data.event.data.usage);
});
let client=makeClient();
const sessionId=randomUUID();
async function ask(name:string, id:string, expected:string[] = [], forbidden:string[] = []){
  const question='当前长期记忆中的验收代号和示例语言是什么？请先用 memory_search 搜索验收代号，有条目时用 memory_read 核对，只依据本轮有效记忆简短回答。若没有记录，回答“没有当前记忆”，不要沿用聊天里的旧资料。';
  recall=prepareRecall(await memory.snapshot(),question);
  active={name,sessionId:id,prompt:`${recall.prompt}\n\n${question}`,response:'',tools:[],usage:[],status:'started'};
  cases.push(active);report('running');
  const start=Date.now();
  try {
    const result=await client.prompt(id,active.prompt);
    assert.equal(result.kind,'completed');assert.ok(active.tools.some((t:any)=>t.name==='memory_search'));
    if(expected.length){assert.ok(active.tools.some((t:any)=>t.name==='memory_read'));for(const value of expected)assert.ok(active.response.includes(value));}
    else assert.ok(active.response.includes('没有当前记忆'));
    for(const value of forbidden)assert.ok(!active.response.includes(value));
    active.status='passed';
  } finally {active.durationMs=Date.now()-start;report('running');}
}
report('started');
try {
  let snapshot=await memory.snapshot();
  await memory.update(snapshot.revision,{add:'验收代号 CEDAR-731；示例语言偏好 TypeScript。',source:'合成付费验收'});
  await ask('new-session-reads-saved-memory',sessionId,['CEDAR-731','TypeScript']);
  snapshot=await memory.snapshot();const id=snapshot.entries[0]!.id;
  await memory.update(snapshot.revision,{edit:{id,text:'验收代号 MAPLE-942；示例语言偏好 Python。'}});
  await ask('same-session-respects-correction',sessionId,['MAPLE-942','Python'],['CEDAR-731','TypeScript']);
  await client.stop();client=makeClient();
  await ask('new-session-after-process-restart',randomUUID(),['MAPLE-942','Python'],['CEDAR-731','TypeScript']);
  snapshot=await memory.snapshot();await memory.update(snapshot.revision,{remove:id});
  await ask('old-session-respects-deletion',sessionId,[],['MAPLE-942','CEDAR-731','Python','TypeScript']);
  report('passed');console.log(`Paid memory acceptance passed: ${output}`);
} catch {
  if(active)active.status='failed';report('failed');
  throw Error(`记忆付费验收未通过；已保留原始合成输出和用量，不自动重试：${output}`);
} finally {await client.stop();}
