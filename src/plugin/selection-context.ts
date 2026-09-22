import { createHash } from 'node:crypto';
import { safeNotePath } from './context.ts';

export interface EditorPosition { line: number; ch: number; }
export interface SelectionContext {
  path: string;
  selection: string;
  nearby: string;
  heading?: string;
  startLine: number;
  endLine: number;
  revision: string;
  pinned: true;
  truncated: boolean;
}

function prefix(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  // Do not cut a Unicode surrogate pair in half at either display limit.
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}

function headingAt(lines: string[], target: number): string | undefined {
  let heading: string | undefined;
  let frontmatter = lines[0]?.replace(/^\uFEFF/, '') === '---';
  let fence: { marker: string; length: number } | undefined;
  for (let index = 0; index <= target; index++) {
    const line = lines[index];
    if (frontmatter) {
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }
    const match = /^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/.exec(line);
    if (match) heading = prefix((match[1] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim(), 500);
  }
  return heading;
}

/** Capture editor coordinates immediately; later editor changes never alter this snapshot.
 * Coordinates are zero-based UTF-16 positions, as in Obsidian's Editor API.
 * Returned line numbers are one-based and describe the original selection, even if truncated.
 */
export function selectionContext(path: string, text: string, from: EditorPosition, to: EditorPosition): SelectionContext {
  safeNotePath(path);
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw Error('笔记超过 1 MB，请选用较小的笔记');
  const rawLines = text.split('\n');
  const lines = rawLines.map(line => line.replace(/\r$/, ''));
  const position = (value: EditorPosition) => {
    if (!Number.isInteger(value.line) || !Number.isInteger(value.ch) || value.line < 0 || value.ch < 0
      || value.line >= lines.length || value.ch > lines[value.line].length) throw Error('选区位置已超出笔记范围，请重新选择');
    return { line: value.line, ch: value.ch };
  };
  let start = position(from), end = position(to);
  if (start.line > end.line || (start.line === end.line && start.ch > end.ch)) [start, end] = [end, start];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of rawLines) { offsets.push(offset); offset += line.length + 1; }
  const original = text.slice(offsets[start.line] + start.ch, offsets[end.line] + end.ch);
  const lastLine = original && end.line > start.line && end.ch === 0 ? end.line - 1 : end.line;
  // A bounded neighborhood keeps the cursor/selection in view, including very long lines.
  // When there is no selection the selection field stays empty; nearby provides context.
  const windowStart = Math.max(offsets[Math.max(0, start.line - 12)], offsets[start.line] + start.ch - 2500);
  const windowEnd = Math.min(text.length, offsets[Math.min(lines.length - 1, lastLine + 12)] + rawLines[Math.min(lines.length - 1, lastLine + 12)].length);
  let adjustedStart = windowStart;
  if (adjustedStart > 0 && /[\uDC00-\uDFFF]/.test(text[adjustedStart] ?? '')) adjustedStart++;
  const neighborhood = text.slice(adjustedStart, windowEnd);
  const selection = prefix(original, 6000), nearby = prefix(neighborhood, 10000);
  return Object.freeze({
    path, selection, nearby, heading: headingAt(lines, start.line),
    startLine: start.line + 1, endLine: lastLine + 1,
    revision: createHash('sha256').update(text).digest('hex'), pinned: true,
    truncated: selection.length < original.length || nearby.length < neighborhood.length || adjustedStart > offsets[Math.max(0, start.line - 12)],
  });
}
