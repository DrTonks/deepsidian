/** Paid acceptance: isolated synthetic history, real deepseek-flash, no personal notes. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DshClient,discover,assistantText} from '../src/plugin/dsh.ts';
const env=discover();await mkdir('.runs',{recursive:true});
const output=await mkdtemp(resolve('.runs/live-fork-'));
const options={packageRoot:env.root,nodePath:env.node,dshHome:env.home,runtimeHome:join(output,'runtime'),bridgePath:resolve('src/plugin/bridge.mjs'),cwd:output,provider:'deepseek-official',model:'deepseek-flash',maxTokens:1024,reasoningEffort:'low'};
const cases:any[]=[];let active:any,endSeq=-1;
const listener=(method:string,data:any)=>{
  if(method==='session.event'&&data.event.type==='turn/end')endSeq=data.event.seq;
  if(method==='session.event'&&data.event.type==='assistant/message'){
    active.response+=assistantText(data.event.data.stream);active.usage.push(data.event.data.usage);
  }
};
const make=()=>new DshClient(options,async()=>{throw Error('No tools needed for this synthetic history test');},listener);
let client=make();const parent=randomUUID(),child=randomUUID();
async function run(name:string,id:string,prompt:string,expected:RegExp,absent?:RegExp){
  active={name,prompt,response:'',usage:[]};cases.push(active);
  assert.equal((await client.prompt(id,prompt)).kind,'completed');
  assert.match(active.response,expected);if(absent)assert.doesNotMatch(active.response,absent);active.passed=true;
}
let status='failed';
try{
  await run('parent-initial',parent,'这是合成测试。本对话的实验代号为 CEDAR-7319。请只回复这个代号，不使用工具。',/CEDAR-7319/);
  const boundary=endSeq;
  await run('parent-later',parent,'实验代号现在更改为 MAPLE-8246。请只回复当前代号，不使用工具。',/MAPLE-8246/);
  await client.fork(parent,child,boundary);await client.stop();client=make();
  await run('child-after-restart',child,'根据本对话之前的消息，当前实验代号是什么？只回复代号，不使用工具。',/CEDAR-7319/,/MAPLE-8246/);
  await run('child-update',child,'实验代号现在更改为 BIRCH-9527。请只回复当前代号，不使用工具。',/BIRCH-9527/);
  await run('parent-isolated',parent,'根据本对话之前的消息，当前实验代号是什么？只回复代号，不使用工具。',/MAPLE-8246/,/BIRCH-9527/);
  await client.stop();client=make();
  await run('child-durable',child,'根据本对话之前的消息，当前实验代号是什么？只回复代号，不使用工具。',/BIRCH-9527/,/MAPLE-8246/);
  status='passed';
}finally{
  await client.stop();await writeFile(join(output,'report.json'),JSON.stringify({status,synthetic:true,versions:env.versions,provider:options.provider,model:options.model,cases},null,2));
  console.log(`分支付费验收 ${status}: ${output}`);
}
