import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeline } from '../src/plugin/trace-view.ts';
import { runtimePatch } from '../src/plugin/dsh.ts';
import { traceEntry, usageSummary, enrichTraceEntry } from '../src/plugin/trace.ts';
test('timeline pairs tools by call id and does not fabricate completed durations', () => {
  const events = [
    {type:'step/start',at:100,detail:''}, {type:'assistant/message',at:400,detail:''},
    {type:'tool/call',at:410,detail:'',callId:'a'}, {type:'tool/call',at:420,detail:'',callId:'b'},
    {type:'tool/result',at:450,detail:'',callId:'b'}, {type:'tool/result',at:600,detail:'',callId:'a'},
    {type:'step/start',at:620,detail:''},
  ];
  const spans = timeline(events,800);
  assert.deepEqual(spans.filter(s=>s.lane==='tool').map(s=>[s.start,s.end]), [[420,450],[410,600]]);
  assert.equal(spans.at(-1)?.open,true);
  assert.equal(spans[0]?.end,400);
});
test('web tools are opt-in and independent', () => {
  const options = {packageRoot:'x',nodePath:'node',dshHome:'home',runtimeHome:'runtime',bridgePath:'bridge',cwd:'.',provider:'test',model:'test'};
  assert.doesNotMatch(JSON.stringify(runtimePatch(options)), /dsh-tool-web/);
  const enabled = JSON.stringify(runtimePatch({...options,webFetch:true}));
  assert.match(enabled, /dsh-web-fetch-http/); assert.doesNotMatch(enabled,/dsh-web-search-deepseek/);
});

test('long assistant replies retain usage after snapshot truncation and persistence', () => {
  const usage = { inputTokens: 100, outputTokens: 9000, cacheReadTokens: 100 };
  const entry = traceEntry({ type: 'assistant/message', data: {
    message: { content: [{ type: 'text', text: '长'.repeat(25000) }] }, usage,
  } });
  assert.throws(() => JSON.parse(entry.detail));
  const saved = JSON.parse(JSON.stringify(entry));
  assert.deepEqual(saved.usage, usage);
  assert.equal(usageSummary([saved]), `输入 200 · 输出 ${(9000).toLocaleString()} tokens · 缓存读取 50%`);
});

test('usage totals include both long and short model steps exactly once', () => {
  const entries = [25000, 10].map(length => traceEntry({ type: 'assistant/message', data: {
    message: { content: [{ type: 'text', text: 'x'.repeat(length) }] },
    usage: { inputTokens: 100, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 50 },
  } }));
  assert.equal(usageSummary(entries), '输入 400 · 输出 600 tokens · 缓存读取 25%');
});

test('legacy JSON snapshots still supply usage and can be enriched', () => {
  const entry = { type: 'assistant/message', at: 123, detail: JSON.stringify({
    message: { content: [{ type: 'text', text: 'old reply' }] },
    usage: { inputTokens: 20, outputTokens: 30 },
  }) };
  assert.equal(usageSummary([entry]), '输入 20 · 输出 30 tokens');
  const enriched = enrichTraceEntry(entry);
  assert.deepEqual(enriched.usage, { inputTokens: 20, outputTokens: 30 });
  assert.equal(enriched.at, 123);
  assert.equal(enriched.detail, entry.detail);
  assert.equal(usageSummary([{ ...entry, detail: 'truncated old snapshot' }]), '用量未报告');
});

test('current DSH uses explicit provider configs and rejects removed official protocol settings',()=>{
  const options={packageRoot:'x',nodePath:'node',dshHome:'home',runtimeHome:'runtime',bridgePath:'bridge',cwd:'.',provider:'deepseek-official',model:'deepseek-flash',webSearch:true};
  const settings={'llm-deepseek':{baseURL:'https://api.deepseek.com/anthropic'},'llm-pi-ai':{providers:{}},'web-search-deepseek':{baseURL:'https://example.com'}};
  const patch=runtimePatch(options,{settings,disabled:{}}),entries=patch.flatMap(item=>'insert' in item?item.insert:[]);
  assert.deepEqual(patch.find(item=>item.id==='llm-deepseek')?.config,settings['llm-deepseek']);
  assert.ok(!entries.some(item=>item.name==='@deepseek-ai/dsh-settings-file'));
  assert.deepEqual(entries.find(item=>item.id==='deepsidian-pi')?.config,settings['llm-pi-ai']);
  assert.deepEqual(entries.find(item=>item.id==='deepsidian-web-search')?.config,settings['web-search-deepseek']);
  assert.ok(entries.every(item=>!('inject' in item)||!item.inject?.includes('settings')));
  for(const protocol of ['messages','chat-completions'])assert.throws(()=>runtimePatch(options,{settings:{'llm-deepseek':{protocol}},disabled:{}}),/llm-deepseek.protocol/);
  assert.match(JSON.stringify(runtimePatch(options)),/dsh-settings-file/,'old runtime composition remains supported for migration');
});
