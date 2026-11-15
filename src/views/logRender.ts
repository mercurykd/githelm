import { LogCommit, LogFilter, logRows, LogSort, ParsedLog } from '../git/log';
import { repoDisplayName } from '../git/repo';
import { t } from '../i18n';
import { Span } from '../util/span';
import { hintEntries, mergeColumns } from './columns';

/**
 * Everything the history buffer shows, as plain text and spans.
 *
 * Kept apart from `LogBuffer` so the same string can be produced outside the
 * editor — the demo screenshots do exactly that — and so a test can read the
 * layout without a `vscode` module.
 */
export type FilterField = keyof LogFilter;

export const FILTER_FIELDS: FilterField[] = ['grep', 'author', 'pickaxe', 'pickaxeRegex', 'since', 'until', 'path'];

export function logKeys(): string {
  return t('log.keys');
}

export function fieldLabel(field: FilterField): string {
  return t(`log.field.${field}` as `log.field.${FilterField}`);
}

function fieldHint(field: FilterField): string {
  return t(`log.fieldHint.${field}` as `log.fieldHint.${FilterField}`);
}

export function filterHint(field: FilterField): string {
  return fieldHint(field);
}

export interface LogRenderOptions {
  repoPath: string;
  all: boolean;
  filter: LogFilter;
  sort: LogSort;
  range?: string;
  leftRight?: boolean;
}

export interface RenderedLog {
  lines: string[];
  spans: Span[];
  commitsByLine: Map<number, LogCommit>;
  fieldLines: Map<number, FilterField>;
}

export function renderLog(parsed: ParsedLog, options: LogRenderOptions): RenderedLog {
  const { repoPath, all, filter, sort, range, leftRight } = options;
  const lines: string[] = [];
  const commitsByLine = new Map<number, LogCommit>();
  const fieldLines = new Map<number, FilterField>();
  const spans: Span[] = [];

  const suffix = range ?? (all ? t('log.titleAll') : '');
  const title =
    t('log.title', { repo: repoDisplayName(repoPath) }) +
    (suffix ? ` ${suffix}` : '') +
    (leftRight ? '  < >' : '');
  lines.push(title);
  spans.push({ line: 0, start: 0, end: title.length, kind: 'title' });

  const sortLabel = sort === 'topo' ? '' : `, ${sort === 'author-date' ? t('sort.authorDate') : t('sort.date')}`;
  const summary = t('log.count', { count: parsed.commits.length }) + (all ? t('log.countAll') : '') + sortLabel;
  lines.push(summary);
  spans.push({ line: 1, start: 0, end: summary.length, kind: 'meta' });

  const filterHeader = `## ${t('log.section.filters')}`;
  lines.push(filterHeader);
  spans.push({ line: 2, start: 0, end: filterHeader.length, kind: 'section' });

  const width = Math.max(...FILTER_FIELDS.map((field) => fieldLabel(field).length)) + 3;
  for (const field of FILTER_FIELDS) {
    const value = filter[field];
    const text = `  ${fieldLabel(field).padEnd(width)}${value && value.length > 0 ? value : t('log.filterPlaceholder.empty')}`;
    const lineNumber = lines.length + 1;
    lines.push(text);
    fieldLines.set(lineNumber, field);
    spans.push({ line: lineNumber - 1, start: 2, end: 2 + fieldLabel(field).length, kind: 'meta' });
    if (value && value.length > 0) {
      spans.push({ line: lineNumber - 1, start: 2 + width, end: text.length, kind: 'hunk' });
    }
  }

  lines.push('');
  const headerLines = lines.length;

  for (const row of logRows(parsed)) {
    const lineIndex = lines.length;
    if (row.commit) {
      commitsByLine.set(lineIndex + 1, row.commit);
    }
    for (const span of row.spans) {
      spans.push({ ...span, line: span.line + headerLines });
    }
    lines.push(row.text);
  }

  const merged = mergeColumns(lines, hintEntries(logKeys(), t('status.keysHeader')));
  for (const span of merged.spans) {
    spans.push(span);
  }

  return { lines: merged.lines, spans, commitsByLine, fieldLines };
}
