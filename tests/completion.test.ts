import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,EditorSelection} from '@codemirror/state';
import {markdown} from '@codemirror/lang-markdown';
import {ensureSyntaxTree} from '@codemirror/language';
import {completionContext,normalizeCompletion} from '../src/plugin/completion/context.ts';

function context(doc:string,at=doc.length){
  const state=EditorState.create({doc,selection:{anchor:at},extensions:markdown()});
  ensureSyntaxTree(state,at,100);
  return completionContext(state,'笔记标题');
}
test('completion bounds unsaved prefix, suffix and title at the actual insertion point',()=>{
  const doc='前'.repeat(3500)+'后'.repeat(1500),state=EditorState.create({doc,selection:{anchor:3500},extensions:markdown()});
  ensureSyntaxTree(state,3500,100);
  const value=completionContext(state,'标题'.repeat(200));
  assert.ok(value);assert.equal(value.prefix,'前'.repeat(3000));assert.equal(value.suffix,'后'.repeat(1000));assert.equal(value.title.length,200);
});
test('completion refuses unparsed, selected, multiple-cursor and readonly editors',()=>{
  assert.equal(completionContext(EditorState.create({doc:'正文'}),'title'),null);
  for(const state of [
    EditorState.create({doc:'正文',selection:{anchor:0,head:1},extensions:markdown()}),
    EditorState.create({doc:'正文',selection:EditorSelection.create([EditorSelection.cursor(0),EditorSelection.cursor(2)]),extensions:[markdown(),EditorState.allowMultipleSelections.of(true)]}),
    EditorState.create({doc:'正文',extensions:[markdown(),EditorState.readOnly.of(true)]}),
  ])assert.equal(completionContext(state,'title'),null);
});
test('completion allows prose and refuses structured or incomplete Markdown constructs',()=>{
  assert.ok(context('这是普通正文'));
  assert.ok(context('- 这是列表中的正文'));
  assert.ok(context('> 这是引用中的正文'));
  assert.ok(context('>> 这是嵌套引用中的正文'));
  for(const doc of ['---\ntitle: private','```ts\nconst a =','~~~\ncode','$$\nx =','正文 $x','正文 `code','正文 [[链接','正文 [链接](address','正文 #标签','| 表格 | 内容 |','# 正在写标题','<!-- private'])assert.equal(context(doc),null,doc);
  assert.ok(context('---\ntitle: note\n---\n\n正文'));
  assert.ok(context('```\ncode\n```\n\n正文'));
});
test('completion finalization preserves boundary spaces and rejects multiline/control output',()=>{
  assert.equal(normalizeCompletion(' continuation  '),' continuation  ');
  for(const value of ['','  ','第一行\n第二行','第一行\r第二行','第一行\u2028第二行','bad\u0000text','a'.repeat(501),'```bad','```text\n一句补全\n```','\n正文','正文\n'])assert.equal(normalizeCompletion(value),null);
});
test('completion rejects repeated suffix punctuation and emphasis without rewriting candidates',()=>{
  for(const [text,suffix] of [['收起。','。后文'],['收起。**','。**\n下一段'],['收起。','。**\n下一段'],[' done.','. Next'],['收起，','，然后继续']]){
    assert.equal(normalizeCompletion(text!,{prefix:'操作后',suffix:suffix!,title:''}),null);
  }
  assert.equal(normalizeCompletion('收起',{prefix:'操作后',suffix:'。**',title:''}),'收起');
  assert.equal(normalizeCompletion('完成。接着收起',{prefix:'操作后',suffix:'。',title:''}),'完成。接着收起');
  assert.equal(normalizeCompletion('收起。',{prefix:'操作后',suffix:'\n下一段',title:''}),'收起。');
});
test('completion rejects joined ASCII words without inventing boundary spaces',()=>{
  const input={prefix:'The newest item is',suffix:' before older items.',title:'Queue'};
  assert.equal(normalizeCompletion('removed first',input),null);
  assert.equal(normalizeCompletion(' removed first',input),' removed first');
  const right={prefix:'The newest item is ',suffix:'before older items.',title:'Queue'};
  assert.equal(normalizeCompletion('removed first',right),null);
  assert.equal(normalizeCompletion('removed first ',right),'removed first ');
  assert.equal(normalizeCompletion('2',{prefix:'version1',suffix:'',title:''}),null);
  assert.equal(normalizeCompletion('3',{prefix:'',suffix:'4 items',title:''}),null);
  assert.equal(normalizeCompletion('中文',{prefix:'中文',suffix:'后文',title:''}),'中文');
  assert.equal(normalizeCompletion(', then',{prefix:'first',suffix:'.',title:''}),', then');
  assert.equal(context('The queue removes items.',5),null);
  assert.ok(context('The queue removes items.',9));
});
test('closed display math does not disable later ordinary paragraphs',()=>{
  for(const doc of [
    '$$x^2$$\n\n接下来说明',
    '$$\nx^2\n$$\n\n接下来说明',
    '$$x^2$$\n\n$$y^2$$\n\n接下来说明',
    '\\$$不是公式\n\n接下来说明',
    '```text\n$$\n```\n\n接下来说明',
    '~~~\n$$\n~~~\n\n接下来说明',
    '文字 `$$` 是代码\n\n接下来说明',
    '参考 [标签$$](https://example.com)\n\n接下来说明',
  ])assert.ok(context(doc),doc);
  for(const doc of ['$$x^2\n\n尚未闭合','$$x^2\\$$\n\n转义不会闭合'])assert.equal(context(doc),null,doc);
});
test('completed inline constructs permit subsequent prose but open constructs remain excluded',()=>{
  for(const doc of [
    '用 `Map` 存储数据，接下来说明',
    '用 ``a`b`` 存储数据，接下来说明',
    '参考 [官方文档](https://example.com)，接下来说明',
    '参考 [[算法笔记]]，接下来说明',
    '当 $x>0$ 时，接下来说明',
    '当 $$x>0$$ 时，接下来说明',
    '正文 \\[ 转义括号不会打开链接',
    '正文 \\` 转义符号不会打开代码',
    '正文 \\$ 转义符号不会打开公式',
  ])assert.ok(context(doc),doc);
  for(const doc of ['正文 `Map 后续','正文 ``Map` 后续','正文 [[算法笔记] 后续','正文 [文档](address','正文 $x>0 时','正文 \\[ 链接[未闭合'])assert.equal(context(doc),null,doc);
  const source='用 `Map` 存储数据';assert.equal(context(source,source.indexOf('Map')+1),null);
  const linked='参考 [官方文档](https://example.com)，后文';assert.equal(context(linked,linked.indexOf('官方')+1),null);
});

test('completion refuses dangling clauses before a line boundary but preserves valid mid-sentence joins',()=>{
  for(const suffix of ['', '\n- 下一步', '\r\n\r\n下一段', '  \n# 下一节']){
    for(const text of ['查找原因，','查找原因；',' find the cause,',' find the cause;'])
      assert.equal(normalizeCompletion(text,{prefix:'先',suffix,title:''}),null);
    assert.equal(normalizeCompletion('查找原因。',{prefix:'先',suffix,title:''}),'查找原因。');
  }
  for(const suffix of ['再修复。','\n再修复。','\r\n  再修复。'])assert.equal(normalizeCompletion('查找原因，',{prefix:'先',suffix,title:''}),'查找原因，');
  assert.equal(normalizeCompletion('查找原因，',{prefix:'> 先',suffix:'\n然后修复。',title:''}),'查找原因，');
  assert.equal(normalizeCompletion('查找原因，',{prefix:'> 先',suffix:'\n> 再修复。',title:''}),'查找原因，');
  for(const suffix of ['\n>\n> 新段落','\n> - 新条目','\n> # 新标题'])assert.equal(normalizeCompletion('查找原因，',{prefix:'> 先',suffix,title:''}),null);
});
