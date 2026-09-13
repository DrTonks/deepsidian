import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeline } from '../src/plugin/trace-view.ts';
import { runtimePatch } from '../src/plugin/dsh.ts';
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
