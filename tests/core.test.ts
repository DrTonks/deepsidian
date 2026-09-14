import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, safeNotePath, excerpt } from '../src/plugin/context.ts';
import { compareVersions } from '../src/plugin/updates.ts';
import { assistantText } from '../src/plugin/dsh.ts';
import { readAttachment, attachmentText } from '../src/plugin/attachments.ts';
import { reasoningText, traceEntry } from '../src/plugin/trace.ts';
test('note paths reject traversal and hidden/absolute paths', () => {
  for (const path of ['../secret.md', '.obsidian/x.md', 'a/../b.md', 'C:/x.md', '/x.md', 'a\\b.md', 'a/.hidden.md', 'a.txt']) assert.throws(() => safeNotePath(path));
  assert.equal(safeNotePath('学习/注意力.md'), '学习/注意力.md');
});
test('note excerpts preserve line numbers and are bounded', () => {
  const result = excerpt(Array.from({length: 150}, (_,i) => `line ${i + 1}`).join('\n'), 12);
  assert.match(result.content, /^12: line 12/); assert.equal(result.content.split('\n').length, 100);
  assert.throws(() => excerpt('a', 2));
});
test('prompt freezes the source and never injects retired background', () => {
  const context = {path:'a.md', selection:'selected', nearby:'nearby'};
  const prompt = buildPrompt('why?', 'LEGACY_BACKGROUND_DO_NOT_SEND'.repeat(1000), context); context.selection='changed';
  assert.match(prompt, /selected/); assert.doesNotMatch(prompt, /changed/); assert.ok(prompt.length < 8000);
  assert.doesNotMatch(prompt, /LEGACY_BACKGROUND_DO_NOT_SEND|学习背景（由用户填写/);
});
test('long questions retain the final instruction and cannot bypass the prompt budget', () => {
  const context = {path:'', selection:'', nearby:''};
  const question = '资料'.repeat(6500) + '\n最终问题：请比较最后两段。';
  const prompt = buildPrompt(question, '', context);
  assert.ok(prompt.endsWith(question));
  assert.ok(prompt.length < 40000);
  const oversized = buildPrompt('资料'.repeat(20000) + '\n最终问题：请比较最后两段。', '', context);
  assert.ok(oversized.length > 40000, 'the send-time budget must see the entire question');
  assert.ok(oversized.endsWith('最终问题：请比较最后两段。'));
});
test('prereleases sort numerically and precede final releases', () => {
  const list = ['0.1.5-rc.2','0.1.5','0.1.5-rc.10','0.1.5-alpha.2','0.1.4'];
  assert.deepEqual(list.sort(compareVersions), ['0.1.4','0.1.5-alpha.2','0.1.5-rc.2','0.1.5-rc.10','0.1.5']);
});
test('durable response extraction excludes reasoning and tool arguments', () => {
  assert.equal(assistantText([{type:'reasoning-chunks',texts:['private']},{type:'text-chunks',texts:['hello',' world']},{type:'chunk',chunk:{type:'text-delta',text:'!'}}]), 'hello world!');
});
test('attachments reject binary/oversized text and keep complete explicit text', async () => {
  const file = (name: string, text: string, size = text.length) => ({name, size, arrayBuffer: async () => new TextEncoder().encode(text).buffer});
  await assert.rejects(readAttachment(file('a.pdf','binary')));
  await assert.rejects(readAttachment(file('a.md','x',200000)));
  await assert.rejects(readAttachment(file('a.txt','a\0b')));
  const text = await readAttachment(file('note.md','example'));
  assert.match(attachmentText([text]), /example/);
});
test('reasoning and trace snapshots preserve evidence without duplicating raw streams', () => {
  assert.equal(reasoningText([{type:'reasoning-chunks',texts:['a','b']},{type:'text-chunks',texts:['answer']}]), 'ab');
  const entry = traceEntry({type:'assistant/message',data:{message:{content:[]},stream:['duplicate'],usage:{outputTokens:5}}});
  assert.doesNotMatch(entry.detail,/duplicate/); assert.match(entry.detail,/outputTokens/);
});
