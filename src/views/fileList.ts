/**
 * A file list as the keys see it: a header line, the lines that name a file, and the file
 * each of them names. Line numbers are 1-based, the way a text editor counts them, because
 * a list is read either from a cursor or from the panel's rows.
 */
export interface FileList {
  /** The `## files (n)` line. */
  header: number;
  /** The lines that name a file, ascending. */
  lines: readonly number[];
  /** Line → the file it names. */
  targets: ReadonlyMap<number, string>;
}

/**
 * The files a selection means, in the order of the list.
 *
 * A row names one file, and the header of the list names all of them — that is the whole
 * of "click `files`, press `d`, see every file": the panel selects the rows under the
 * clicked header and the buffer may put its cursor on it, and both arrive here as the same
 * question. A line that names no file (the metadata, the hint line, the key line) is
 * skipped rather than failing the key, so dragging across the document diffs the files in
 * it instead of nothing.
 */
export function filesOf(list: FileList | undefined, lines: readonly number[]): string[] {
  if (!list) {
    return [];
  }
  const wanted = new Set(lines.includes(list.header) ? list.lines : lines);
  // Walked in the order of the list, not of the selection: a drag upwards opens the files
  // in the order the document prints them, the way the buffer's cursor would.
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of list.lines) {
    const path = list.targets.get(line);
    if (path !== undefined && wanted.has(line) && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}
