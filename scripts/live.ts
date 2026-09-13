import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DshClient, discover, configuredModels } from '../src/plugin/dsh.ts';
const env = discover();
const model = configuredModels(env.root, env.home).selected;
const output = resolve('.runs', `live-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(output, { recursive: true });
console.log({ versions: env.versions, model, credentials: '由 DSH 读取，不复制或输出' });
let deltas = 0, calls = 0;
const events: unknown[] = [];
const client = new DshClient({ packageRoot: env.root, nodePath: env.node, dshHome: env.home, runtimeHome: join(output, 'runtime'), bridgePath: resolve('src/plugin/bridge.mjs'), cwd: resolve('fixtures'), ...model },
  async () => { calls++; return { source: 'synthetic-test', content: 'This is a fictional test, not a user profile. Explain KV cache to an imaginary student. KV cache stores attention keys and values.' }; },
  (method, data) => {
    if (method === 'deepsidian.stream' && data.frame.type === 'chunk' && data.frame.chunk.type === 'text-delta') { deltas++; process.stdout.write(data.frame.chunk.text); }
    if (method === 'session.event') events.push({ type: data.event.type, ...(data.event.type === 'turn/end' ? { reason: data.event.data.reason } : {}) });
  });
try {
  const result = await client.prompt(randomUUID(), '这是人工构造的软件测试，不涉及真实用户资料。请调用 obsidian_context 获取虚构样例，然后用三句话解释 KV cache。');
  const summary = { result, textChunks: deltas, toolCalls: calls, events };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n', summary);
  if (!deltas || !calls || result.kind !== 'completed') throw Error('真实模型未完成工具与流式闭环');
} finally { await client.stop(); }
