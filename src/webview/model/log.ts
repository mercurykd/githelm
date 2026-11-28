import { LogFilter, LogSort, ParsedLog, isFilterEmpty, logRows } from '../../git/log';
import { t } from '../../i18n';
import type { Span, SpanKind } from '../../util/span';
import { FILTER_FIELDS, fieldLabel } from '../../views/logFilters';
import type {
  ColorRole,
  FactModel,
  LogFilterRowModel,
  LogModel,
  LogRowModel,
  LogSegmentModel,
} from '../protocol';
import { parseHints } from './hints';
import { refSegments } from './refs';

export interface LogModelInput {
  repoPath: string;
  parsed: ParsedLog;
  all: boolean;
  filter: LogFilter;
  sort: LogSort;
  range?: string;
  leftRight?: boolean;
  /** The `-n` the rows were read with, so the model can say whether more exist. */
  limit: number;
  /**
   * The tag names that exist on the remote the screen checked. A tag ref in a row that
   * is not in this set is painted amber; absent means the remote is unknown, so nothing
   * is marked.
   */
  pushedTags?: ReadonlySet<string>;
}

/**
 * The history screen as the panel draws it.
 *
 * The rows are `logRows()` — the very function the text buffer renders — split into
 * segments at the buffer's own spans. The panel therefore draws the graph as the same
 * character grid, with the same columns and the same colours, instead of growing a
 * second graph renderer that could drift from the first.
 */
export function buildLogModel(input: LogModelInput): LogModel {
  const { repoPath, parsed, all, filter, sort, range, leftRight, limit, pushedTags } = input;

  const suffix = range ?? (all ? t('log.titleAll') : '');
  // The header names the screen the way every other screen does — the repository, an
  // em dash, the screen — so a tab of the history reads like a tab of the branches.
  const title =
    t('log.title', { repo: repoPath }) +
    (suffix ? ` ${suffix}` : '') +
    (leftRight ? '  < >' : '');

  // No count line: the block heading counts the commits. The order stays, because the key
  // that changes it says nowhere else what it is set to — and the graph order is the
  // silence of the buffer, so only a chosen order gets a line under the title.
  const sortLabel = sort === 'author-date' ? t('sort.authorDate') : t('sort.date');
  const facts: FactModel[] = sort === 'topo' ? [] : [{ label: '', value: sortLabel, role: 'meta' }];

  const rows: LogRowModel[] = logRows(parsed).map((row, index) => {
    const model: LogRowModel = {
      id: row.commit ? `commit:${row.commit.sha}` : `row:${index}`,
      // A tag the default remote does not have is painted amber inside the refs label;
      // the local graph is on screen already, so the remote check never blocks it.
      segments: highlightUnpushedTags(segmentsOf(row.text, row.spans), pushedTags),
    };
    if (row.commit) {
      model.commit = { sha: row.commit.sha, shortSha: row.commit.shortSha, refs: row.commit.refs };
    }
    if (row.subjectStart !== undefined) {
      model.subjectColumn = row.subjectStart;
    }
    return model;
  });

  return {
    kind: 'log',
    title,
    facts,
    // The key line is the buffer's, unedited: the panel has no keys of its own here, so
    // the hint line cannot drift from what the keys actually do.
    hints: parseHints(t('log.keys')),
    filterTitle: t('log.section.filters'),
    filters: filterRows(filter),
    rows,
    selectFirst: t('webview.selectItem'),
    // An empty history and a history whose filters match nothing look the same on
    // screen but are not the same answer: the second one is a filter to loosen.
    emptyText: isFilterEmpty(filter) ? t('webview.emptyLog') : t('webview.emptyLogFiltered'),
    // `-n` capped the read: a full page means there may be another one behind it.
    more: parsed.commits.length >= limit,
    moreText: t('webview.moreLog'),
  };
}

function filterRows(filter: LogFilter): LogFilterRowModel[] {
  return FILTER_FIELDS.map((field) => {
    const value = filter[field] ?? '';
    return {
      id: `field:${field}`,
      field,
      label: fieldLabel(field),
      // The raw value: the panel edits it in an input, and an empty one shows its hint
      // in the placeholder instead of a printed dash.
      value,
      filled: value.length > 0,
    };
  });
}

/**
 * Splits a refs segment around the tags the remote does not have, so only `tag: v1`
 * takes the coral `untracked` colour and the rest of the label keeps the refs colour.
 * Git ref names contain no whitespace, and the label is built by `refsLabel()` as
 * `[HEAD -> main tag: v1 origin/main]`, which is why the tag is one token.
 */
export function highlightUnpushedTags(
  segments: LogSegmentModel[],
  pushedTags: ReadonlySet<string> | undefined
): LogSegmentModel[] {
  if (!pushedTags) {
    return segments;
  }
  const result: LogSegmentModel[] = [];
  for (const segment of segments) {
    if (segment.role !== 'refs') {
      result.push(segment);
    } else {
      result.push(...refSegments(segment.text, pushedTags));
    }
  }
  return result;
}

/**
 * Splits a row at the buffer's spans. The gaps between two spans are left unpainted, as
 * the buffer leaves them, and a span that only partly overlaps one already taken (the
 * `<`/`>` of a --left-right range lies inside the graph prefix) wins on its own part.
 */
export function segmentsOf(text: string, spans: Span[]): LogSegmentModel[] {
  const segments: LogSegmentModel[] = [];
  const push = (chunk: string, role: ColorRole): void => {
    if (chunk.length > 0) {
      segments.push({ text: chunk, role });
    }
  };

  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start));
  let at = 0;
  for (const span of ordered) {
    const start = Math.max(span.start, at);
    const end = Math.min(span.end, text.length);
    if (end <= start) {
      continue;
    }
    push(text.slice(at, start), 'plain');
    push(text.slice(start, end), roleOf(span.kind));
    at = end;
  }
  push(text.slice(at), 'plain');
  return segments;
}

/**
 * The colour role of a span kind. The log uses a handful of them, and their names are
 * the roles' names — except the two diff markers, and the kinds that have no colour of
 * their own in the panel, which read as plain text.
 */
function roleOf(kind: SpanKind): ColorRole {
  switch (kind) {
    case 'add':
      return 'added';
    case 'del':
      return 'deleted';
    case 'meta':
    case 'hash':
    case 'date':
    case 'author':
    case 'refs':
    case 'upstream':
    case 'graph':
    case 'branch':
    case 'help':
      return kind;
    default:
      return 'plain';
  }
}
