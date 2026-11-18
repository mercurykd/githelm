import { Span, SpanKind } from '../util/span';

let currentColumn = 94;

/** Set once on activation from githelm.ui.hintColumn. */
export function setHintColumn(column: number): void {
  currentColumn = Number.isFinite(column) && column > 30 ? column : 94;
}

export function hintColumn(): number {
  return currentColumn;
}

/**
 * Column for the list screens — tags, branches and the history graph. Their hint
 * block only shares lines with the title, the count and the blank lines above the
 * list, so it can sit right after the text instead of at the shared column: a bit
 * over half of it, which keeps a wide window from leaving a long empty gutter.
 */
export function narrowHintColumn(): number {
  return Math.max(40, Math.round(currentColumn * 0.55));
}

export interface ColumnEntry {
  text: string;
  kind: SpanKind;
}

/** Splits `s stage   u unstage` into packing-friendly segments. */
export function keySegments(keysLine: string): string[] {
  return keysLine
    .split(/\s{3,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Every screen's key column is three lines tall — the status screen's line count,
 * which the other buffers follow so the hints read the same everywhere.
 */
const HINT_LINES = 3;

/**
 * Right-hand column with a header and the key hints. By default the hints are
 * packed so the column is at most `HINT_LINES` lines tall — the status screen's
 * line count, which the other buffers follow so the hints read the same
 * everywhere — while a short list stays on one line.
 */
export function hintEntries(keysLine: string, header: string, lines?: number): ColumnEntry[] {
  const entry: ColumnEntry[] = [{ text: header, kind: 'section' }];
  const segments = keySegments(keysLine);
  const perLine =
    lines === undefined
      ? Math.max(2, Math.ceil(segments.length / HINT_LINES))
      : Math.max(1, Math.ceil(segments.length / Math.max(1, lines)));
  for (let index = 0; index < segments.length; index += perLine) {
    entry.push({ text: `  ${segments.slice(index, index + perLine).join('   ')}`, kind: 'help' });
  }
  return entry;
}

/**
 * Merges a right-hand column into the left text. The left side is never cut: a
 * long line pushes its own hint to the right instead of losing text, so the
 * column stays aligned for every line that fits and nothing is silently hidden.
 */
export function mergeColumns(
  left: string[],
  right: ColumnEntry[],
  column = currentColumn
): { lines: string[]; spans: Span[] } {
  const spans: Span[] = [];
  const lines = [...left];
  const total = Math.max(lines.length, right.length);

  for (let index = 0; index < total; index++) {
    const leftText = lines[index] ?? '';
    const rightText = right[index]?.text ?? '';
    if (!rightText) {
      lines[index] = leftText;
      continue;
    }
    const start = Math.max(column, leftText.length + 1);
    lines[index] = `${leftText}${' '.repeat(start - leftText.length)}${rightText}`;
    spans.push({ line: index, start, end: lines[index].length, kind: right[index].kind });
  }
  return { lines, spans };
}

/** Same as `mergeColumns`, for buffers whose body is plain text. */
export function withHints(
  text: string,
  keysLine: string,
  header: string,
  column = currentColumn
): { text: string; spans: Span[] } {
  const endsWithNewline = text.endsWith('\n');
  const lines = text.replace(/\n$/, '').split('\n');
  const merged = mergeColumns(lines, hintEntries(keysLine, header), column);
  return { text: `${merged.lines.join('\n')}${endsWithNewline ? '\n' : ''}`, spans: merged.spans };
}
