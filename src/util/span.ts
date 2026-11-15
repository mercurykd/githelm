export type SpanKind =
  | 'meta'
  | 'hash'
  | 'date'
  | 'author'
  | 'refs'
  | 'upstream'
  | 'graph'
  | 'section'
  | 'staged'
  | 'unstaged'
  | 'untracked'
  | 'remotes'
  | 'worktrees'
  | 'path'
  | 'branch'
  | 'help'
  | 'rule'
  | 'title'
  | 'add'
  | 'del'
  | 'hunk'
  | 'file-added'
  | 'file-modified'
  | 'file-deleted'
  | 'file-untracked'
  | 'file-conflict';

/** A half-open character range `[start, end)` on a 0-based line. */
export interface Span {
  line: number;
  start: number;
  end: number;
  kind: SpanKind;
}

/**
 * Spans for a rendered commit view: header metadata plus patch lines.
 * `git show` output is close enough to a patch that plain prefix checks work.
 */
export function commitSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lines = text.split('\n');

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    if (text.startsWith('commit ')) {
      spans.push({ line, start: 0, end: 6, kind: 'meta' });
      spans.push({ line, start: 7, end: text.length, kind: 'hash' });
      continue;
    }
    if (text.startsWith('Author:')) {
      spans.push({ line, start: 0, end: text.length, kind: 'meta' });
      continue;
    }
    if (text.startsWith('Date:')) {
      spans.push({ line, start: 0, end: text.length, kind: 'meta' });
      continue;
    }
    if (text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('--- ') || text.startsWith('+++ ')) {
      spans.push({ line, start: 0, end: text.length, kind: 'meta' });
      continue;
    }
    if (text.startsWith('@@')) {
      spans.push({ line, start: 0, end: text.length, kind: 'hunk' });
      continue;
    }
    if (text.startsWith('+')) {
      spans.push({ line, start: 0, end: text.length, kind: 'add' });
      continue;
    }
    if (text.startsWith('-')) {
      spans.push({ line, start: 0, end: text.length, kind: 'del' });
    }
  }
  return spans;
}
