import { Span } from '../util/span';
import { git } from './exec';
import { hasHeadCommit } from './repo';

export interface LogCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  /** Relative date, e.g. `2 days ago`. */
  date: string;
  subject: string;
  /** Ref decorations as reported by `%D`: `HEAD -> main`, `tag: v1`, `origin/main`. */
  refs: string[];
  graphPrefix: string;
  /** < or > for --left-right ranges. */
  side?: '<' | '>';
}

export interface LogEntry {
  /** Missing on pure graph continuation rows (`|\`, `|/`, …). */
  commit?: LogCommit;
  graphPrefix: string;
}

export interface ParsedLog {
  entries: LogEntry[];
  commits: LogCommit[];
  maxPrefixWidth: number;
}

export interface LogRow {
  text: string;
  commit?: LogCommit;
  /** Spans use line indices relative to the rows array; the view offsets them. */
  spans: Span[];
}

export interface LogFilter {
  /** `--grep` — message text. */
  grep?: string;
  /** `--author` — name or e-mail. */
  author?: string;
  /** `-S` — commits that changed the number of occurrences of the string. */
  pickaxe?: string;
  /** `-G` — commits whose diff matches the regex. */
  pickaxeRegex?: string;
  since?: string;
  until?: string;
  /** Restrict history to one path. */
  path?: string;
}

export interface ReadLogOptions {
  all?: boolean;
  limit?: number;
  filter?: LogFilter;
  /** Restrict history to one path (used by the file-history view). */
  path?: string;
  /** Revision range like A..B or A...B. */
  range?: string;
  /** --left-right: mark each commit with < or > for three-dot ranges. */
  leftRight?: boolean;
}

/** Human-readable one-liner for the buffer header. */
export function describeFilter(filter: LogFilter | undefined): string {
  if (!filter) {
    return '';
  }
  const parts: string[] = [];
  if (filter.grep) {
    parts.push(`--grep="${filter.grep}"`);
  }
  if (filter.author) {
    parts.push(`--author="${filter.author}"`);
  }
  if (filter.pickaxe) {
    parts.push(`-S "${filter.pickaxe}"`);
  }
  if (filter.pickaxeRegex) {
    parts.push(`-G "${filter.pickaxeRegex}"`);
  }
  if (filter.since) {
    parts.push(`--since=${filter.since}`);
  }
  if (filter.until) {
    parts.push(`--until=${filter.until}`);
  }
  if (filter.path) {
    parts.push(`path ${filter.path}`);
  }
  return parts.join(' ');
}

export function isFilterEmpty(filter: LogFilter | undefined): boolean {
  return describeFilter(filter).length === 0;
}

const SEP = '\x1f';
const FORMAT = `--format=${SEP}%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ad${SEP}%s${SEP}%D`;
const DEFAULT_LIMIT = 200;
const DEFAULT_DATE_FORMAT = '%Y-%m-%d %H:%M';

export type LogSort = 'topo' | 'date' | 'author-date';

export interface LogDisplayOptions {
  /** `git --date=format:…` value. */
  dateFormat?: string;
  sort?: LogSort;
  /** `--all`: every ref, including custom ones (`refs/cline/*`, `refs/stash`). */
  includeAllRefs?: boolean;
}

/** Builds the `git log` invocation; exported so the flags can be unit-tested. */
export function logArgs(options: ReadLogOptions & LogDisplayOptions = {}): string[] {
  const args = ['log', '--graph', '--no-color', FORMAT, '-n', String(options.limit ?? DEFAULT_LIMIT)];
  args.push(`--date=format:${options.dateFormat ?? DEFAULT_DATE_FORMAT}`);

  if (options.sort === 'date') {
    args.push('--date-order');
  } else if (options.sort === 'author-date') {
    args.push('--author-date-order');
  }

  if (options.includeAllRefs) {
    args.push('--all');
  } else if (options.all) {
    // `--all` pulls in refs/stash too, which paints WIP/index commits as if
    // they were branch history. Branches, tags and remotes are what `a` means.
    args.push('--branches', '--tags', '--remotes');
  }
  if (options.leftRight) {
    args.push('--left-right');
  }
  if (options.range) {
    args.push(options.range);
  }

  const filter = options.filter;
  if (filter?.grep) {
    args.push(`--grep=${filter.grep}`);
  }
  if (filter?.author) {
    args.push(`--author=${filter.author}`);
  }
  if (filter?.pickaxe) {
    args.push(`-S${filter.pickaxe}`);
  }
  if (filter?.pickaxeRegex) {
    args.push(`-G${filter.pickaxeRegex}`);
  }
  if (filter?.since) {
    args.push(`--since=${filter.since}`);
  }
  if (filter?.until) {
    args.push(`--until=${filter.until}`);
  }
  const path = options.path ?? filter?.path;
  if (path) {
    args.push('--', path);
  }
  return args;
}

/**
 * `git log --graph` renders the graph itself — including merge bends — so we
 * only have to split its prefix from the commit fields. Rendering the lanes
 * ourselves buys nothing until we need per-lane overlays (fixup connections).
 */
export function parseLog(raw: string): ParsedLog {
  const entries: LogEntry[] = [];
  const commits: LogCommit[] = [];
  let maxPrefixWidth = 0;

  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const marker = line.indexOf(SEP);
    if (marker < 0) {
      entries.push({ graphPrefix: line });
      maxPrefixWidth = Math.max(maxPrefixWidth, line.length);
      continue;
    }

    const fields = line.slice(marker + 1).split(SEP);
    const graphPrefix = line.slice(0, marker);
    const sha = fields[0] ?? '';
    if (sha.length === 0) {
      entries.push({ graphPrefix });
      maxPrefixWidth = Math.max(maxPrefixWidth, graphPrefix.length);
      continue;
    }

    const sideMatch = /^\s*([<>])\s/.exec(graphPrefix);
    const commit: LogCommit = {
      ...(sideMatch ? { side: sideMatch[1] as '<' | '>' } : {}),
      sha,
      shortSha: fields[1] ?? sha.slice(0, 7),
      parents: (fields[2] ?? '').split(' ').filter(Boolean),
      author: fields[3] ?? '',
      date: fields[4] ?? '',
      subject: fields[5] ?? '',
      refs: (fields[6] ?? '')
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean),
      graphPrefix,
    };
    entries.push({ graphPrefix, commit });
    commits.push(commit);
    maxPrefixWidth = Math.max(maxPrefixWidth, graphPrefix.length);
  }

  return { entries, commits, maxPrefixWidth };
}

export async function readLog(repoPath: string, options: ReadLogOptions & LogDisplayOptions = {}): Promise<ParsedLog> {
  const result = await git(repoPath, logArgs(options));
  if (result.code === 0) {
    return parseLog(result.stdout);
  }
  // A repository created by `git init` has no HEAD yet, so `git log` exits 128
  // with "your current branch 'main' does not have any commits yet". That is an
  // empty history, not a failure — the status screen still has to render.
  if (!(await hasHeadCommit(repoPath))) {
    return { entries: [], commits: [], maxPrefixWidth: 0 };
  }
  throw new Error(`git log failed (${result.code}): ${result.stderr.trim()}`);
}

/** Author names are cut here, so one long name cannot push the subject away. */
export const AUTHOR_MAX = 18;
/** Blank columns kept between the longest author and the subject column. */
export const AUTHOR_GAP = 2;

/** Author name as it lands in a column — cut like everywhere else. */
export function truncateAuthor(author: string): string {
  return truncate(author, AUTHOR_MAX);
}

/**
 * Width the author column needs for a set of names: the longest one that
 * survives truncation plus `AUTHOR_GAP`. Every screen that shows an author in
 * front of a subject pads to this width, so the subject never wanders and a
 * short login never leaves a hole. A fixed 20-column field did exactly that.
 */
export function authorColumnWidth(authors: Iterable<string>): number {
  let longest = 0;
  for (const author of authors) {
    longest = Math.max(longest, Math.min(author.length, AUTHOR_MAX));
  }
  return longest > 0 ? longest + AUTHOR_GAP : 1;
}

/** Turns parsed history into aligned, readable buffer rows. */
export function logRows(parsed: ParsedLog): LogRow[] {
  const width = parsed.maxPrefixWidth + 1;
  const shaStart = width;
  const dateStart = shaStart + 9;
  const authorStart = dateStart + 18;
  const authorWidth = authorColumnWidth(parsed.commits.map((commit) => commit.author));
  const subjectStart = authorStart + authorWidth;

  return parsed.entries.map((entry, index) => {
    const prefix = entry.graphPrefix.padEnd(width);
    if (!entry.commit) {
      return { text: prefix.trimEnd(), spans: [] };
    }

    const commit = entry.commit;
    const date = truncate(commit.date, 18);
    const author = truncateAuthor(commit.author);
    const label = refsLabel(commit.refs);
    const labelText = label.length > 0 ? `${label} ` : '';
    const text = `${prefix}${commit.shortSha.padEnd(9)}${date.padEnd(18)}${author.padEnd(authorWidth)}${labelText}${commit.subject}`;

    const spans: Span[] = [];
    if (commit.side) {
      const markerIndex = entry.graphPrefix.indexOf(commit.side);
      if (markerIndex >= 0) {
        spans.push({ line: index, start: markerIndex, end: markerIndex + 1, kind: commit.side === '>' ? 'add' : 'del' });
      }
    }
    const graphWidth = entry.graphPrefix.trimEnd().length;
    if (graphWidth > 0) {
      spans.push({ line: index, start: 0, end: graphWidth, kind: 'graph' });
    }
    spans.push({ line: index, start: shaStart, end: shaStart + commit.shortSha.length, kind: 'hash' });
    spans.push({ line: index, start: dateStart, end: dateStart + date.length, kind: 'date' });
    spans.push({ line: index, start: authorStart, end: authorStart + author.length, kind: 'author' });
    if (label.length > 0) {
      spans.push({ line: index, start: subjectStart, end: subjectStart + label.length, kind: 'refs' });
    }

    return { text, commit, spans };
  });
}

/** `[dev, origin/dev, tag: v1]` — brackets keep the column visually distinct. */
export function refsLabel(refs: string[]): string {
  if (refs.length === 0) {
    return '';
  }
  return `[${refs.join(' ')}]`;
}

/** Cuts text to `max` columns, marking the cut with an ellipsis. */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Branch-ish refs of a commit that are safe to hand to `git checkout`. */
export function checkoutableRefs(refs: string[]): string[] {
  const result: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith('tag: ')) {
      continue;
    }
    const name = ref.startsWith('HEAD -> ') ? ref.slice('HEAD -> '.length) : ref;
    if (name === 'HEAD' || name.length === 0) {
      continue;
    }
    result.push(name);
  }
  return result;
}
