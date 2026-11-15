import { DiffFile, DiffHunk, ParsedDiff } from './diff';

export interface LineSelection {
  /** Index into `ParsedDiff.files`. */
  file: number;
  /** Index into `file.hunks`. */
  hunk: number;
  /** Index into `hunk.lines`. */
  line: number;
}

export class PatchBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchBuildError';
  }
}

/**
 * Collects selectable (add/del) body lines that make up the rendered document
 * range `[fromDocLine, toDocLine]` (1-based, inclusive).
 */
export function selectionToLines(parsed: ParsedDiff, fromDocLine: number, toDocLine: number): LineSelection[] {
  const result: LineSelection[] = [];
  const from = Math.min(fromDocLine, toDocLine);
  const to = Math.max(fromDocLine, toDocLine);

  parsed.files.forEach((file, fileIndex) => {
    file.hunks.forEach((hunk, hunkIndex) => {
      hunk.lines.forEach((line, lineIndex) => {
        if (line.kind !== 'add' && line.kind !== 'del') {
          return;
        }
        const docLine = hunk.docLine + 1 + lineIndex;
        if (docLine >= from && docLine <= to) {
          result.push({ file: fileIndex, hunk: hunkIndex, line: lineIndex });
        }
      });
    });
  });
  return result;
}

/**
 * The contiguous run of add/del lines that contains `bodyIndex`. This is what
 * "stage this change" means: one edit inside a hunk, without its neighbours.
 */
export function selectionForBlock(
  parsed: ParsedDiff,
  fileIndex: number,
  hunkIndex: number,
  bodyIndex: number
): LineSelection[] {
  const hunk = parsed.files[fileIndex]?.hunks[hunkIndex];
  if (!hunk) {
    return [];
  }
  const isChange = (index: number): boolean => {
    const kind = hunk.lines[index]?.kind;
    return kind === 'add' || kind === 'del';
  };
  if (!isChange(bodyIndex)) {
    return [];
  }

  let start = bodyIndex;
  while (start > 0 && isChange(start - 1)) {
    start -= 1;
  }
  let end = bodyIndex;
  while (end + 1 < hunk.lines.length && isChange(end + 1)) {
    end += 1;
  }

  const result: LineSelection[] = [];
  for (let index = start; index <= end; index++) {
    if (isChange(index)) {
      result.push({ file: fileIndex, hunk: hunkIndex, line: index });
    }
  }
  return result;
}

/** Every add/del line of a hunk — what `s` stages when nothing is selected. */
export function selectionForHunk(parsed: ParsedDiff, fileIndex: number, hunkIndex: number): LineSelection[] {
  const hunk = parsed.files[fileIndex]?.hunks[hunkIndex];
  if (!hunk) {
    return [];
  }
  const result: LineSelection[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.kind === 'add' || line.kind === 'del') {
      result.push({ file: fileIndex, hunk: hunkIndex, line: index });
    }
  });
  return result;
}

function isDeletedFile(file: DiffFile): boolean {
  return file.headerLines.some((line) => line.startsWith('deleted file mode'));
}

function selectableLines(hunk: DiffHunk): number[] {
  const result: number[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.kind === 'add' || line.kind === 'del') {
      result.push(index);
    }
  });
  return result;
}

/**
 * Rebuilds a hunk so that only the selected add/del lines are applied.
 *
 * - a selected `-` line stays a removal, an unselected one becomes context
 *   (the line stays in the working tree, so it must also stay in the patch),
 * - a selected `+` line is added, an unselected one is dropped entirely,
 * - context lines are always kept,
 * - hunk header counts and start positions are recomputed.
 *
 * Returns `undefined` when nothing in the hunk is selected.
 */
export function rebuildHunk(hunk: DiffHunk, selected: Set<number>): string[] | undefined {
  const hasEofMarker = hunk.lines.some((line) => line.kind === 'nonewline');
  const selectable = selectableLines(hunk);

  if (hasEofMarker) {
    const fullySelected = selectable.every((index) => selected.has(index));
    if (!fullySelected) {
      throw new PatchBuildError(
        'Этот фрагмент содержит файл без перевода строки в конце и не может быть выделен частично. Выделите весь хунк.'
      );
    }
  }

  const out: string[] = [];
  let oldPos = hunk.oldStart;
  let newPos = hunk.newStart;
  let oldCount = 0;
  let newCount = 0;
  let firstOld = -1;
  let firstNew = -1;
  let emittedAny = false;

  for (let index = 0; index < hunk.lines.length; index++) {
    const line = hunk.lines[index];
    if (line.kind === 'nonewline') {
      continue; // handled together with the body line it follows
    }

    const picked = selected.has(index);
    const body = line.text.slice(1);
    let text: string | undefined;

    if (line.kind === 'context') {
      text = ` ${body}`;
      oldCount += 1;
      newCount += 1;
      oldPos += 1;
      newPos += 1;
    } else if (line.kind === 'del') {
      if (picked) {
        text = `-${body}`;
        oldCount += 1;
        oldPos += 1;
      } else {
        text = ` ${body}`;
        oldCount += 1;
        newCount += 1;
        oldPos += 1;
        newPos += 1;
      }
    } else {
      if (picked) {
        text = `+${body}`;
        newCount += 1;
        newPos += 1;
      }
    }

    if (text === undefined) {
      continue;
    }
    if (!emittedAny) {
      emittedAny = true;
      firstOld = line.kind === 'add' ? oldPos - 0 : oldPos - 1;
      firstNew = line.kind === 'add' ? newPos - 1 : newPos - 1;
    }
    out.push(text);

    const next = hunk.lines[index + 1];
    if (next && next.kind === 'nonewline') {
      out.push(next.text);
    }
  }

  if (!emittedAny) {
    return undefined;
  }

  const section = hunk.header.replace(/^@@ -[^@]+@@/, '');
  const header = `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@${section}`;
  return [header, ...out];
}

export function buildPatch(parsed: ParsedDiff, selection: LineSelection[]): string {
  const grouped = new Map<number, Map<number, Set<number>>>();

  for (const item of selection) {
    const file = parsed.files[item.file];
    if (!file) {
      continue;
    }
    const hunk = file.hunks[item.hunk];
    if (!hunk) {
      continue;
    }
    const line = hunk.lines[item.line];
    if (!line || (line.kind !== 'add' && line.kind !== 'del')) {
      continue;
    }
    let hunks = grouped.get(item.file);
    if (!hunks) {
      hunks = new Map();
      grouped.set(item.file, hunks);
    }
    let lines = hunks.get(item.hunk);
    if (!lines) {
      lines = new Set();
      hunks.set(item.hunk, lines);
    }
    lines.add(item.line);
  }

  const out: string[] = [];

  for (const fileIndex of [...grouped.keys()].sort((a, b) => a - b)) {
    const file = parsed.files[fileIndex];
    const hunks = grouped.get(fileIndex)!;

    if (isDeletedFile(file)) {
      const everyHunkComplete = file.hunks.every((hunk) => {
        const picked = hunks.get(file.hunks.indexOf(hunk));
        return selectableLines(hunk).every((index) => picked?.has(index) ?? false);
      });
      if (!everyHunkComplete) {
        throw new PatchBuildError('Файл удалён целиком: его можно выделить только полностью.');
      }
    }

    const chunks: string[][] = [];
    for (const hunkIndex of [...hunks.keys()].sort((a, b) => a - b)) {
      const rebuilt = rebuildHunk(file.hunks[hunkIndex], hunks.get(hunkIndex)!);
      if (rebuilt) {
        chunks.push(rebuilt);
      }
    }
    if (chunks.length === 0) {
      continue;
    }
    out.push(...file.headerLines);
    for (const chunk of chunks) {
      out.push(...chunk);
    }
  }

  return out.length > 0 ? `${out.join('\n')}\n` : '';
}
