/** Paid completion experiment: synthetic fixtures only; sequential calls, no script retries. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {normalizeCompletion} from '../src/plugin/completion/context.ts';
import { DshClient, discover } from '../src/plugin/dsh.ts';

interface CompletionCase {
  id: string; category: string; title: string; prefix: string; suffix: string;
  allowEmpty: boolean; reviewFocus: string;
}
interface CaseReport extends CompletionCase {
  outcome: 'candidate' | 'empty' | 'rejected' | 'timeout' | 'error';
  text: string; rawText?:string; warmWallMs: number; runtimeElapsedMs?: number;
  usage: unknown; usageKnown: boolean; review: 'pending';
}
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !/^--limit=[1-9]\d*$/.test(arg))) {
  throw Error('Usage: node scripts/live-completion.ts [--limit=N]');
}
const fixtures: CompletionCase[] = JSON.parse(await readFile(new URL('../fixtures/completion-cases.json', import.meta.url), 'utf8'));
if (!Array.isArray(fixtures) || fixtures.length !== 20 || fixtures.some(item =>
  !item || ['id', 'category', 'title', 'prefix', 'suffix', 'reviewFocus'].some(key => typeof item[key as keyof CompletionCase] !== 'string') || typeof item.allowEmpty !== 'boolean'
) || new Set(fixtures.map(item => item.id)).size !== fixtures.length) throw Error('Invalid synthetic completion fixtures');
const limit = args[0] ? Number(args[0].slice('--limit='.length)) : fixtures.length;
if (!Number.isSafeInteger(limit) || limit > fixtures.length) throw Error(`--limit must be between 1 and ${fixtures.length}`);
const selected = fixtures.slice(0, limit);
await mkdir('.runs', { recursive: true });
const output = await mkdtemp(resolve('.runs/live-completion-'));
const model = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 128 };
const cases: CaseReport[] = [];
let client: DshClient | undefined;
let versions: Record<string, string> | undefined;
let coldStartMs: number | undefined;
let coldStartOutcome: 'pending' | 'ready' | 'error' = 'pending';
let runState: 'running' | 'completed_unreviewed' | 'failed_unreviewed' = 'running';
const percentile = (values: number[], proportion: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
};
function fence(text: string) {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const delimiter = '`'.repeat(longest + 1);
  return `${delimiter}text\n${text}\n${delimiter}`;
}
async function save() {
  const returned = cases.filter(item => item.outcome === 'candidate' || item.outcome === 'empty' || item.outcome === 'rejected');
  const times = returned.map(item => item.warmWallMs);
  const failed = cases.filter(item => item.outcome === 'timeout' || item.outcome === 'error');
  const report = {
    at: new Date().toISOString(), state: runState, synthetic: true, quality: 'pending-human-review',
    model, versions, requestDeadlineMs: 8000, scriptRetries: 0, selectedCases: selected.map(item => item.id),
    coldStart: { outcome: coldStartOutcome, elapsedMs: coldStartMs ?? null },
    summary: {
      attempted: cases.length, candidates: cases.filter(item => item.outcome === 'candidate').length,
      rejected: cases.filter(item => item.outcome === 'rejected').length,
      empty: cases.filter(item => item.outcome === 'empty').length,
      timeouts: cases.filter(item => item.outcome === 'timeout').length,
      errors: cases.filter(item => item.outcome === 'error').length,
      failureRate: cases.length ? failed.length / cases.length : null,
      unknownUsage: cases.filter(item => !item.usageKnown).length,
      returnedWarmP50Ms: percentile(times, 0.5), returnedWarmP95Ms: percentile(times, 0.95),
      latencyPopulation: 'returned responses including empty; excludes failures, reported separately; excludes cold start',
    }, cases,
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const sections = cases.map(item => `## ${item.id} — ${item.category}\n\n结果：${item.outcome}；暖请求耗时：${item.warmWallMs} ms；用量：${item.usageKnown ? '见 report.json' : '未知，不能按零计算'}。\n\n审阅重点：${item.reviewFocus}\n\n允许保守空返回：${item.allowEmpty ? '是' : '否'}。\n\n前文：\n\n${fence(item.prefix)}\n\n候选：\n\n${fence(item.text)}\n\n后文：\n\n${fence(item.suffix)}\n\n拼接后的正文：\n\n${fence(item.prefix + item.text + item.suffix)}\n\n人工结论：待填写。直接插入可用 / 重复或格式问题 / 语义或事实问题 / 空返回合理 / 空返回不合理。\n`);
  await writeFile(join(output, 'review.md'), `# 补全合成样例人工评阅\n\n状态：${runState}。所有样例均为合成资料；没有自动质量通过结论。空返回、错误和超时不能自动算作通过。失败例的拼接正文仅供定位，不代表产生候选。\n\n${sections.join('\n')}`);
}
await save();
try {
  const env = discover(); versions = env.versions;
  client = new DshClient({ packageRoot: env.root, nodePath: env.node, dshHome: env.home,
    runtimeHome: join(output, 'runtime'), bridgePath: resolve('src/plugin/bridge.mjs'), cwd: output,
    ...model, webSearch: false, webFetch: false,
  }, async () => { throw Error('Synthetic completion does not permit tools'); }, () => {});
  const coldStarted = performance.now();
  try { await client.start(); coldStartOutcome = 'ready'; }
  catch { coldStartOutcome = 'error'; throw Error('Runtime startup failed'); }
  finally { coldStartMs = Math.round(performance.now() - coldStarted); }
  await save();
  for (const item of selected) {
    const controller = new AbortController();
    let deadlineExpired = false;
    const deadline = setTimeout(() => { deadlineExpired = true; controller.abort(); }, 8000);
    const started = performance.now();
    const record: CaseReport = { ...item, outcome: 'error', text: '', warmWallMs: 0, usage: null, usageKnown: false, review: 'pending' };
    try {
      const result = await client.complete({ prefix: item.prefix, suffix: item.suffix, title: item.title }, controller.signal);
      if (deadlineExpired) record.outcome = 'timeout';
      else { record.rawText=result.text; const candidate=normalizeCompletion(result.text,item);record.text=candidate??'';record.outcome=!result.text.trim()?'empty':candidate?'candidate':'rejected'; }
      record.runtimeElapsedMs = result.elapsedMs;
      record.usageKnown = result.usage !== undefined && result.usage !== null;
      record.usage = result.usage ?? null;
    } catch (error) {
      // Classify without persisting upstream error text, which may contain credentials or request details.
      const message = error instanceof Error ? error.message : '';
      record.outcome = deadlineExpired || /timeout|timed out|超时/i.test(message) ? 'timeout' : 'error';
    } finally { clearTimeout(deadline); record.warmWallMs = Math.round(performance.now() - started); }
    cases.push(record);
    await save();
    console.log(`${item.id}: ${record.outcome}, ${record.warmWallMs} ms, usage ${record.usageKnown ? 'reported' : 'unknown'}`);
  }
  runState = cases.some(item => item.outcome === 'timeout' || item.outcome === 'error') ? 'failed_unreviewed' : 'completed_unreviewed';
} catch {
  runState = 'failed_unreviewed';
  if (coldStartOutcome === 'pending') coldStartOutcome = 'error';
} finally {
  try { await client?.stop(); }
  finally { await save(); }
}
if (runState === 'failed_unreviewed') process.exitCode = 1;
console.log(`补全合成报告（质量待人工评阅）：${output}`);
