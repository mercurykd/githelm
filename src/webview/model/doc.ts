import type { Span } from '../../util/span';
import type {
  ColorRole,
  DocGroupModel,
  DocKind,
  DocLineModel,
  DocModel,
  DocSegmentModel,
  HintModel,
} from '../protocol';

/**
 * A document as the panel draws it: every line of the buffer's text, cut at the buffer's
 * own spans. The panel does not have a second renderer for patches, commits or blame —
 * it draws the same characters with the same colours the text buffer draws, so a hunk
 * header is amber in both and the two screens can be compared line for line.
 *
 * Segments concatenate back to the line (`row.segments.map(s => s.text).join('')` is the
 * buffer's line), which is what the tests pin: a gap left unpainted stays unpainted, and
 * a span that overlaps one already taken wins on its own characters.
 */
/**
 * A file list the document draws: the header that stands for it and the lines that name a
 * file. Both are 0-based document lines here, because everything the model holds is a line
 * index; the buffers count lines from 1, the way an editor does, and convert once.
 */
export interface DocModelGroup {
  header: number;
  lines: readonly number[];
}


export interface DocModelInput {
  screen: DocKind;
  title: string;
  text: string;
  spans: readonly Span[];
  hints?: HintModel[];
  facts?: DocModel['facts'];
  groups?: readonly DocModelGroup[];
  keysTitle: string;
  selectFirst: string;
  emptyText: string;
}

/** The colour role a span kind is painted with: the palette's names, not VS Code's. */
const ROLE_OF: Record<Span['kind'], ColorRole> = {
  meta: 'meta',
  hash: 'hash',
  date: 'date',
  author: 'author',
  refs: 'refs',
  upstream: 'upstream',
  graph: 'graph',
  section: 'section',
  staged: 'staged',
  unstaged: 'unstaged',
  untracked: 'untracked',
  remotes: 'remotes',
  worktrees: 'worktrees',
  path: 'path',
  branch: 'branch',
  help: 'help',
  rule: 'rule',
  title: 'section',
  add: 'added',
  del: 'deleted',
  hunk: 'hunk',
  'file-added': 'added',
  'file-modified': 'modified',
  'file-deleted': 'deleted',
  'file-untracked': 'untracked',
  'file-conflict': 'conflict',
};

export function roleOfSpan(kind: Span['kind']): ColorRole {
  return ROLE_OF[kind];
}

/**
 * One line's painted pieces. The spans arrive in whatever order the renderer produced
 * them, may overlap and may run past the line; painting is by character, so the first
 * span that claims a character keeps it.
 */
export function lineSegments(text: string, spans: readonly Span[], line: number): DocSegmentModel[] {
  const length = text.length;
  const owner = new Array<Span['kind'] | undefined>(length).fill(undefined);
  for (const span of spans) {
    if (span.line !== line) {
      continue;
    }
    const end = Math.min(span.end, length);
    for (let at = Math.max(0, span.start); at < end; at++) {
      if (owner[at] === undefined) {
        owner[at] = span.kind;
      }
    }
  }
  const segments: DocSegmentModel[] = [];
  let at = 0;
  while (at < length) {
    const kind = owner[at];
    let end = at + 1;
    while (end < length && owner[end] === kind) {
      end += 1;
    }
    segments.push({ text: text.slice(at, end), role: kind === undefined ? 'plain' : ROLE_OF[kind] });
    at = end;
  }
  return segments;
}


/** The group as the client needs it: ids, so a click can select them without parsing text. */
export function docGroups(groups: readonly DocModelGroup[] | undefined): DocGroupModel[] {
  return (groups ?? [])
    .filter((group) => group.lines.length > 0)
    .map((group) => ({
      header: `line:${group.header}`,
      ids: group.lines.map((line) => `line:${line}`),
    }));
}

export function buildDocModel(input: DocModelInput): DocModel {
  // `withHints()` ends the document with a newline; a trailing empty line would draw a
  // row of nothing under the key line.
  const text = input.text.endsWith('\n') ? input.text.slice(0, -1) : input.text;
  const rows = text.split('\n');
  const lines: DocLineModel[] = rows.map((line, index) => ({
    id: `line:${index}`,
    text: line,
    segments: lineSegments(line, input.spans, index),
  }));

  return {
    kind: 'doc',
    screen: input.screen,
    title: input.title,
    facts: input.facts ?? [],
    keysTitle: input.keysTitle,
    hints: input.hints ?? [],
    lines,
    groups: docGroups(input.groups),
    selectFirst: input.selectFirst,
    emptyText: input.emptyText,
  };
}

/**
 * The rows a key was pressed on, as lines. `line:12` is one row; `line:11`–`line:14` is a
 * range the reader dragged. Ids that are not lines are dropped, so a stray click cannot
 * turn into line 0.
 */
export function lineNumbersOf(ids: readonly string[]): number[] {
  const lines = new Set<number>();
  for (const id of ids) {
    const match = /^line:(\d+)$/.exec(id);
    if (match) {
      lines.add(Number(match[1]));
    }
  }
  return [...lines].sort((left, right) => left - right);
}