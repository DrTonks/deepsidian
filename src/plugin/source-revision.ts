import { createHash } from 'node:crypto';

const PREFIX = 'sha256-lf:';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalize = (text: string) => text.replace(/\r\n/g, '\n');

/** Source locations use logical lines: CodeMirror exposes LF even for CRLF files.
 * Keep this separate from manifest hashes, which describe the exact sent snapshot.
 */
export function sourceRevision(text: string): string {
  return PREFIX + hash(normalize(text));
}

export function matchesSourceRevision(text: string, revision: string): boolean {
  if (revision.startsWith(PREFIX)) return sourceRevision(text) === revision;
  // Earlier snapshots stored raw hashes from either the editor or vault.read().
  // Preserve those records without rewriting their historical source text.
  const lf = normalize(text);
  return [text, lf, lf.replace(/\n/g, '\r\n')].some(value => hash(value) === revision);
}
