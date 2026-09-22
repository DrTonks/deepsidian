import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { selectionContext } from '../src/plugin/selection-context.ts';

test('selection snapshots normalize reverse multiline ranges and preserve CRLF', () => {
  const text = '# Topic\r\nfirst line\r\nsecond line\r\nlast';
  const forward = selectionContext('notes/a.md', text, {line:1,ch:6}, {line:2,ch:6});
  assert.deepEqual(forward, selectionContext('notes/a.md', text, {line:2,ch:6}, {line:1,ch:6}));
  assert.equal(forward.selection, 'line\r\nsecond');
  assert.equal(forward.startLine, 2); assert.equal(forward.endLine, 3);
  assert.equal(forward.heading, 'Topic');
  assert.equal(forward.revision, createHash('sha256').update(text).digest('hex'));
  assert.ok(Object.isFrozen(forward)); assert.equal(forward.pinned, true);
});

test('heading capture excludes frontmatter and fenced code, respects fence marker and length', () => {
  const text = ['---', '# metadata', '---', '# Real', '````ts', '# Not a heading', '```', '~~~', '# Still code', '````', 'text', '~~~', '# Also code', '~~~', '## Subtopic ###', 'body'].join('\n');
  assert.equal(selectionContext('a.md', text, {line:8,ch:0}, {line:8,ch:1}).heading, 'Real');
  assert.equal(selectionContext('a.md', text, {line:12,ch:0}, {line:12,ch:1}).heading, 'Real');
  assert.equal(selectionContext('a.md', text, {line:15,ch:0}, {line:15,ch:4}).heading, 'Subtopic');
  assert.equal(selectionContext('a.md', text, {line:1,ch:0}, {line:1,ch:1}).heading, undefined);
});

test('empty selections capture nearby context and boundary ranges use inclusive content lines', () => {
  const empty = selectionContext('a.md', '', {line:0,ch:0}, {line:0,ch:0});
  assert.equal(empty.selection, ''); assert.equal(empty.nearby, '');
  assert.equal(empty.startLine, 1); assert.equal(empty.endLine, 1);
  const text = '# Topic\n\nparagraph\nnext\n';
  const cursor = selectionContext('a.md', text, {line:2,ch:4}, {line:2,ch:4});
  assert.equal(cursor.selection, ''); assert.match(cursor.nearby, /paragraph/);
  const range = selectionContext('a.md', text, {line:2,ch:0}, {line:3,ch:0});
  assert.equal(range.selection, 'paragraph\n'); assert.equal(range.endLine, 3);
  assert.equal(selectionContext('a.md', text, {line:4,ch:0}, {line:4,ch:0}).endLine, 5);
});

test('limits bound selection and neighborhood without splitting surrogate pairs', () => {
  const text = '# Title\n' + 'x'.repeat(5999) + '😀' + 'y'.repeat(16000);
  const result = selectionContext('a.md', text, {line:1,ch:0}, {line:1,ch:text.length - 8});
  assert.equal(result.selection.length, 5999); assert.ok(result.nearby.length <= 10000);
  assert.equal(result.truncated, true);
  const cursor = selectionContext('a.md', text, {line:1,ch:17000}, {line:1,ch:17000});
  assert.ok(cursor.nearby.length > 0); assert.ok(cursor.nearby.length <= 10000);
});

test('invalid coordinates, non-public paths, and oversized UTF-8 documents fail explicitly', () => {
  for (const position of [{line:-1,ch:0}, {line:0,ch:-1}, {line:0.5,ch:0}, {line:1,ch:0}, {line:0,ch:4}]) {
    assert.throws(() => selectionContext('a.md', 'abc', position, {line:0,ch:0}), /选区位置/);
  }
  assert.throws(() => selectionContext('../a.md', '', {line:0,ch:0}, {line:0,ch:0}));
  assert.throws(() => selectionContext('a.md', '中'.repeat(350000), {line:0,ch:0}, {line:0,ch:0}), /1 MB/);
  const oneMiB = selectionContext('a.md', 'x'.repeat(1024 * 1024), {line:0,ch:0}, {line:0,ch:0});
  assert.equal(oneMiB.nearby.length, 10000);
});
