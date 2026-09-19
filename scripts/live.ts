import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DshClient, discover } from '../src/plugin/dsh.ts';
import { runOrganizer } from '../src/plugin/memory/organizer.ts';
import { extractionPrompt, parseProposals, sourceKey } from '../src/plugin/memory/proposals.ts';
import { DEFAULT_RULES } from '../src/plugin/memory/store.ts';
const env = discover();
const model = { provider: 'deepseek-official', model: 'deepseek-flash' };
const output = resolve('.runs', `live-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(output, { recursive: true });
console.log({ versions: env.versions, model, credentials: '由 DSH 读取，不复制或输出' });
let deltas = 0, calls = 0;
let response = '';
const started = Date.now();
const prompt = '这是人工构造的软件测试，不涉及真实用户资料。请调用 obsidian_context 获取虚构样例，然后用三句话解释 KV cache。';
const usage: unknown[] = [];
const events: unknown[] = [];
const chatReport = (status: string, result?: unknown) => writeFileSync(join(output, 'summary.json'), JSON.stringify({at:new Date().toISOString(), status, versions:env.versions, model, synthetic:true, prompt,response,usage,durationMs:Date.now()-started,result,textChunks:deltas,toolCalls:calls,events}, null, 2));
chatReport('started');
const client = new DshClient({ packageRoot: env.root, nodePath: env.node, dshHome: env.home, runtimeHome: join(output, 'runtime'), bridgePath: resolve('src/plugin/bridge.mjs'), cwd: resolve('fixtures'), ...model },
  async (name) => {
    if(name!=='obsidian_context')throw Error('本次合成聊天验收只启用 obsidian_context，未提供长期记忆或其他笔记。');
    calls++;return { source: 'synthetic-test', content: 'This is a fictional test, not a user profile. Explain KV cache to an imaginary student. KV cache stores attention keys and values.' };
  },
  (method, data) => {
    if (method === 'deepsidian.stream' && data.frame.type === 'chunk' && data.frame.chunk.type === 'text-delta') { deltas++; response += data.frame.chunk.text; process.stdout.write(data.frame.chunk.text); }
    if (method === 'session.event' && data.event.type === 'assistant/message' && data.event.data.usage) usage.push(data.event.data.usage);
    if (method === 'session.event') events.push({ type: data.event.type, ...(data.event.type === 'turn/end' ? { reason: data.event.data.reason?.kind } : {}) });
  });
try {
  const result = await client.prompt(randomUUID(), prompt);
  if (!deltas || !calls || result.kind !== 'completed') throw Error('真实模型未完成工具与流式闭环');
  chatReport('passed', {kind:result.kind});
} catch {
  // Upstream error messages can include request details: never serialize them.
  chatReport('failed');
  throw Error(`真实聊天验证失败，已保存局部响应与用量：${output}`);
} finally { await client.stop(); }
// A second paid scenario exercises the production extraction prompt and validator.
const text = '我希望概念解释先给简短定义，再给一个 TypeScript 示例。';
const sources = [{ key: sourceKey('synthetic', 0, text), index: 0, text }];
const snapshot = { vaultId: 'synthetic', entries: [], rules: DEFAULT_RULES, revision: 'synthetic' };
const organizerPrompt = extractionPrompt(snapshot, sources);
let raw = '';
const organizerStarted = Date.now();
const organizerReport = (status:string, proposals:unknown[] = []) => writeFileSync(join(output, 'organizer.json'), JSON.stringify({status, synthetic:true, versions:env.versions, model, durationMs:Date.now()-organizerStarted, prompt:organizerPrompt, response:raw, proposals, applied:false}, null, 2));
organizerReport('started');
try {
  raw = await runOrganizer({...client.options, runtimeHome: join(output, 'organizer')}, organizerPrompt, new AbortController().signal);
  const proposals = parseProposals(raw, snapshot, sources);
  if (!proposals.length) throw Error('没有提案');
  organizerReport('passed', proposals);
} catch {
  organizerReport('failed');
  throw Error(`真实整理器验证失败，已保存报告（不含上游错误详情）：${output}`);
}
console.log(`\n付费验证报告：${output}（提案只验证，不写入真实记忆）`);
// Negative case: fictional/quoted preferences must not become the user's memory.
const fictional = '下面是我小说里的虚构角色，不是我的偏好：小明说“我希望概念解释先给简短定义，再给一个 TypeScript 示例”。';
const negativeSources = [{key:sourceKey('synthetic-negative',0,fictional),index:0,text:fictional}];
const negativePrompt = extractionPrompt(snapshot,negativeSources);
let negativeRaw='';
const negativeReport=(status:string)=>writeFileSync(join(output,'organizer-negative.json'),JSON.stringify({status,synthetic:true,prompt:negativePrompt,response:negativeRaw,applied:false},null,2));
negativeReport('started');
try {
  negativeRaw=await runOrganizer({...client.options,runtimeHome:join(output,'organizer-negative')},negativePrompt,new AbortController().signal);
  if(parseProposals(negativeRaw,snapshot,negativeSources).length)throw Error('虚构人物被误记');
  negativeReport('passed');
} catch {
  negativeReport('failed');throw Error(`虚构人物排除验收失败，原始输出已留档：${output}`);
}
