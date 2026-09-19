/** Paid synthetic quality evaluation. No real vault or memory store is opened. */
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { discover, assistantText } from '../src/plugin/dsh.ts';
import { runOrganizer } from '../src/plugin/memory/organizer.ts';
import { extractionPrompt, parseProposals, sourceKey, type Proposal } from '../src/plugin/memory/proposals.ts';
import { DEFAULT_RULES, type MemorySnapshot } from '../src/plugin/memory/store.ts';

interface Expectation { count:number; kind?:'add'|'edit'; id?:string; allOf?:string[][]; forbidden?:string[]; requiredEvidenceIndices?:number[]; }
interface Example { id:string; messages:string[]; entries:{id:string;text:string}[]; expect:Expectation; }
interface Check { name:string; passed:boolean; }
type Category='input-invalid'|'runtime-or-model-failure'|'proposal-validation-failure'|'automatic-check-failure';
const fixtureRaw=await readFile(resolve('fixtures/memory-eval.json'),'utf8');
const fixture=JSON.parse(fixtureRaw) as {version:number;synthetic:boolean;cases:Example[]};
if(fixture.version!==1 || fixture.synthetic!==true || !Array.isArray(fixture.cases) || fixture.cases.length!==12
  || new Set(fixture.cases.map(c=>c.id)).size!==12 || fixture.cases.some(c=>!/^[-a-z0-9]+$/.test(c.id)
    || !Array.isArray(c.messages)||!c.messages.length||c.messages.some(m=>typeof m!=='string')||!Array.isArray(c.entries)
    || !Number.isInteger(c.expect?.count)||c.expect.count<0||c.expect.count>12))throw Error('Synthetic evaluation fixture is invalid');
const env=discover(),model={provider:'deepseek-official',model:'deepseek-flash'};
await mkdir(resolve('.runs'),{recursive:true});
const output=await mkdtemp(resolve('.runs','memory-eval-'));
const reports:Record<string,unknown>[]=[];
const metadata={synthetic:true,versions:env.versions,model,fixtureSha256:createHash('sha256').update(fixtureRaw).digest('hex'),
  attemptsPerCase:1,modelRetries:'DSH 内部重试不受脚本控制，可能产生额外费用',
  interpretation:'自动条件只检查结构、数量、关键词和禁词，不等于语义正确。每例仍需人工复核归属、完整性与证据。',
  semanticReview:{status:'pending',criteria:['是否属于用户本人','是否为持久偏好而非临时请求','更正是否保留未变内容','引用是否真正支持提案']}};
const saveSummary=async(status:string)=>writeFile(join(output,'report.json'),JSON.stringify({...metadata,status,cases:reports},null,2));
await saveSummary('started');

// Read only this case's newly created runtime tree. Do not copy raw event objects,
// error reasons, headers or provider request diagnostics into the public report.
async function durableEvidence(runtime:string) {
  const usage:Record<string,number>[]=[];let partial='';let incomplete=false;
  const fields=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'];
  async function walk(path:string):Promise<void> {
    for(const item of await readdir(path,{withFileTypes:true})) {
      if(item.isSymbolicLink())continue;
      const file=join(path,item.name);
      if(item.isDirectory())await walk(file);
      else if(item.isFile()&&item.name==='session.v3.jsonl') {
        for(const line of (await readFile(file,'utf8')).split('\n')) {
          if(!line.trim())continue;
          let event:any;try{event=JSON.parse(line);}catch{incomplete=true;continue;}
          if(event.type!=='assistant/message')continue;
          const safe:Record<string,number>={};
          for(const key of fields){const value=event.data?.usage?.[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)safe[key]=value;}
          if(Object.keys(safe).length)usage.push(safe);
          if(Array.isArray(event.data?.stream))partial=(partial+assistantText(event.data.stream)).slice(0,32000);
        }
      }
    }
  }
  try{await walk(join(runtime,'sessions'));}catch{incomplete=true;}
  return {usage,partial,incomplete:incomplete||usage.length===0};
}
function checksFor(proposals:Proposal[],expected:Expectation,example:Example):Check[] {
  const checks:Check[]=[{name:`count=${expected.count}`,passed:proposals.length===expected.count}];
  if(expected.kind)checks.push({name:`kind=${expected.kind}`,passed:proposals.length>0&&proposals.every(p=>p.kind===expected.kind)});
  if(expected.id)checks.push({name:`id=${expected.id}`,passed:proposals.length>0&&proposals.every(p=>p.id===expected.id)});
  const text=proposals.map(p=>p.text).join('\n').toLocaleLowerCase();
  for(const alternatives of expected.allOf??[])checks.push({name:`contains any: ${alternatives.join(' | ')}`,passed:alternatives.some(word=>text.includes(word.toLocaleLowerCase()))});
  for(const word of expected.forbidden??[])checks.push({name:`excludes: ${word}`,passed:!text.includes(word.toLocaleLowerCase())});
  for(const index of expected.requiredEvidenceIndices??[])checks.push({name:`cites source index ${index}`,passed:proposals.length>0&&proposals.every(p=>p.evidence.some(e=>e.key===sourceKey(example.id,index,example.messages[index]!)))});
  return checks;
}
for(const example of fixture.cases) {
  const directory=join(output,example.id),runtime=join(directory,'runtime');await mkdir(directory);
  const report:Record<string,unknown>={id:example.id,status:'started',input:example,startedAt:new Date().toISOString(),raw:'',parsed:null,checks:[],semanticReview:'pending'};
  reports.push(report);await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2));await saveSummary('running');
  const started=Date.now();let stage:Category='input-invalid';let raw='';
  try {
    const snapshot:MemorySnapshot={vaultId:`synthetic-${example.id}`,revision:'synthetic',rules:DEFAULT_RULES,
      entries:example.entries.map(e=>({...e,source:'synthetic-evaluation',createdAt:'2026-01-01T00:00:00.000Z'}))};
    const sources=example.messages.map((text,index)=>({text,index,key:sourceKey(example.id,index,text)}));
    const prompt=extractionPrompt(snapshot,sources);report.prompt=prompt;
    // Save the exact prompt before the paid call, including cases which later fail.
    await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2));
    stage='runtime-or-model-failure';
    raw=await runOrganizer({packageRoot:env.root,nodePath:env.node,dshHome:env.home,runtimeHome:runtime,
      bridgePath:resolve('src/plugin/bridge.mjs'),cwd:resolve('fixtures'),...model},prompt,new AbortController().signal);
    stage='proposal-validation-failure';
    const parsed=parseProposals(raw,snapshot,sources);report.parsed=parsed;
    stage='automatic-check-failure';const checks=checksFor(parsed,example.expect,example);report.checks=checks;
    if(checks.some(c=>!c.passed))throw Error('Automatic conditions did not pass');
    report.status='passed-automatic';
  } catch {
    report.status='failed';report.errorCategory=stage;
  } finally {
    const durable=await durableEvidence(runtime);
    report.raw=raw||durable.partial;report.rawSource=raw?'organizer-return':'durable-assistant-messages';
    report.usage=durable.usage;report.usageIncomplete=durable.incomplete;
    report.cost={amount:null,currency:null,note:'未估算金额；用量仅为本次隔离会话已落盘的白名单字段，失败请求可能不完整。'};
    report.durationMs=Date.now()-started;
    await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2));await saveSummary('running');
    console.log(`${example.id}: ${report.status}`);
  }
}
const passed=reports.every(r=>r.status==='passed-automatic');await saveSummary(passed?'passed-automatic-review-pending':'failed-review-pending');
console.log(`合成记忆评测报告：${output}；语义人工复核仍待完成。`);
if(!passed)process.exitCode=1;
