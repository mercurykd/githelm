import { Span, SpanKind } from '../util/span';

let currentColumn = 94;

/** Set once on activation from githelm.ui.hintColumn. */
export function setHintColumn(column: number): void {
  currentColumn = Number.isFinite(column) && column > 30 ? column : 94;
}

export function hintColumn(): number {
  return currentColumn;
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

/** Right-hand column with a header and the key hints, two per line. */
export function hintEntries(keysLine: string, header: string, perLine = 2): ColumnEntry[] {
  const entry: ColumnEntry[] = [{ text: header, kind: 'section' }];
  const segments = keySegments(keysLine);
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
