import { t } from '../i18n';
import { TagEntry } from '../git/tags';
import { authorColumnWidth, truncate, truncateAuthor } from '../git/log';
import { hintEntries, mergeColumns, narrowHintColumn } from './columns';
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
/** An annotation is a note beside the tag, not a paragraph: it gets cut here. */
const ANNOTATION_WIDTH = 40;

export function renderTags(repoPath: string, tags: TagEntry[]): RenderedTags {
  const lines: string[] = [];
  const targets = new Map<number, TagEntry>();
  const spans: Span[] = [];

  lines.push(t('tags.title', { repo: repoPath }));
  spans.push({ line: 0, start: 0, end: lines[0].length, kind: 'title' });

  const summary = t('tags.count', { count: tags.length });
  lines.push(summary);
  spans.push({ line: 1, start: 0, end: summary.length, kind: 'meta' });

  // The key column is three lines tall and starts under the title, so the first
  // row waits for line 6 instead of running into the hints.
  const firstRow = 6;
  while (lines.length < firstRow - 1) {
    lines.push('');
  }

  if (tags.length === 0) {
    lines.push('  —');
  }

  // The tag name takes the place the graph drawing has in the history screen; the
  // annotation, when the tag has one, follows it in a column of its own, and the
  // rest of the row is that screen's commit row, column for column.
  const nameWidth = tags.reduce((width, tag) => Math.max(width, tag.name.length), 0) + GAP;
  const annotations = tags.map((tag) => (tag.annotation ? truncate(tag.annotation, ANNOTATION_WIDTH) : ''));
  const annotationWidth = annotations.some((text) => text.length > 0)
    ? annotations.reduce((width, text) => Math.max(width, text.length), 0) + GAP
    : 0;
  const authorWidth = authorColumnWidth(tags.map((tag) => tag.author));
  const shaStart = 2 + nameWidth + annotationWidth;
  const dateStart = shaStart + SHA_WIDTH;
  const authorStart = dateStart + DATE_WIDTH;

  tags.forEach((tag, index) => {
    const lineNumber = lines.length + 1;
    const date = truncate(tag.date, DATE_WIDTH);
    const author = truncateAuthor(tag.author);
    const annotation = annotations[index];
    lines.push(
      `  ${tag.name.padEnd(nameWidth)}${annotation.padEnd(annotationWidth)}${tag.sha.padEnd(SHA_WIDTH)}${date.padEnd(DATE_WIDTH)}${author.padEnd(authorWidth)}${tag.subject}`
    );
    targets.set(lineNumber, tag);
    spans.push({ line: lineNumber - 1, start: 2, end: 2 + tag.name.length, kind: 'branch' });
    if (annotation) {
      spans.push({ line: lineNumber - 1, start: 2 + nameWidth, end: 2 + nameWidth + annotation.length, kind: 'meta' });
    }
    if (tag.sha) {
      spans.push({ line: lineNumber - 1, start: shaStart, end: shaStart + tag.sha.length, kind: 'hash' });
    }
    if (date) {
      spans.push({ line: lineNumber - 1, start: dateStart, end: dateStart + date.length, kind: 'date' });
    }
    if (author.length > 0) {
      spans.push({ line: lineNumber - 1, start: authorStart, end: authorStart + author.length, kind: 'author' });
    }
    // The commit subject stays unpainted, exactly as it is in the graph.
  });

  const merged = mergeColumns(lines, hintEntries(tagsKeys(), t('status.keysHeader')), narrowHintColumn());
  for (const span of merged.spans) {
    spans.push(span);
  }

  return { text: `${merged.lines.join('\n')}\n`, targets, spans };
}
