import { t } from '../i18n';
import { TagEntry } from '../git/tags';
import { authorColumnWidth, truncate, truncateAuthor } from '../git/log';
import { hintEntries, mergeColumns } from './columns';
import { Span } from '../util/span';

export interface RenderedTags {
  text: string;
  targets: Map<number, TagEntry>;
  spans: Span[];
}

export function tagsKeys(): string {
  return t('tags.keys');
}

/** Columns of the commit part, shared with the history graph (`git/log.ts`). */
const SHA_WIDTH = 9;
const DATE_WIDTH = 18;
const GAP = 2;

export function renderTags(repoPath: string, tags: TagEntry[]): RenderedTags {
  const lines: string[] = [];
  const targets = new Map<number, TagEntry>();
  const spans: Span[] = [];

  lines.push(t('tags.title', { repo: repoPath }));
  spans.push({ line: 0, start: 0, end: lines[0].length, kind: 'title' });

  const summary = t('tags.count', { count: tags.length });
  lines.push(summary);
  spans.push({ line: 1, start: 0, end: summary.length, kind: 'meta' });
  lines.push('');

  if (tags.length === 0) {
    lines.push('  —');
  }

  // The tag name takes the place the graph drawing has in the history screen;
  // the rest of the row is that screen's commit row, column for column.
  const nameWidth = tags.reduce((width, tag) => Math.max(width, tag.name.length), 0) + GAP;
  const authorWidth = authorColumnWidth(tags.map((tag) => tag.author));
  const shaStart = 2 + nameWidth;
  const dateStart = shaStart + SHA_WIDTH;
  const authorStart = dateStart + DATE_WIDTH;

  for (const tag of tags) {
    const lineNumber = lines.length + 1;
    const date = truncate(tag.date, DATE_WIDTH);
    const author = truncateAuthor(tag.author);
    lines.push(`  ${tag.name.padEnd(nameWidth)}${tag.sha.padEnd(SHA_WIDTH)}${date.padEnd(DATE_WIDTH)}${author.padEnd(authorWidth)}${tag.subject}`);
    targets.set(lineNumber, tag);
    spans.push({ line: lineNumber - 1, start: 2, end: 2 + tag.name.length, kind: 'branch' });
    if (tag.sha) {
      spans.push({ line: lineNumber - 1, start: shaStart, end: shaStart + tag.sha.length, kind: 'hash' });
    }
    if (date) {
      spans.push({ line: lineNumber - 1, start: dateStart, end: dateStart + date.length, kind: 'date' });
    }
    if (author.length > 0) {
      spans.push({ line: lineNumber - 1, start: authorStart, end: authorStart + author.length, kind: 'author' });
    }
    // The subject stays unpainted, exactly as it is in the graph.
  }

  const merged = mergeColumns(lines, hintEntries(tagsKeys(), t('status.keysHeader')));
  for (const span of merged.spans) {
    spans.push(span);
  }

  return { text: `${merged.lines.join('\n')}\n`, targets, spans };
}
