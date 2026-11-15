export type DiffLineKind = 'context' | 'add' | 'del' | 'nonewline';

export interface DiffLine {
  kind: DiffLineKind;
  /** Full original line, including the leading marker character. */
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** 1-based line number of the `@@` header inside the rendered document. */
  docLine: number;
}

export interface DiffFile {
  oldPath: string;
  path: string;
  /** Everything from `diff --git` up to (excluding) the first hunk. */
  headerLines: string[];
  hunks: DiffHunk[];
  /** 1-based line of the `diff --git` header inside the rendered document. */
  docLine: number;
}

export interface ParsedDiff {
  text: string;
  files: DiffFile[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff` output. `docOffset` is the number of lines prepended to the
 * diff when it is rendered into a buffer, so `hunk.docLine` stays meaningful.
 */
export function parseDiff(text: string, docOffset = 0): ParsedDiff {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const docLine = docOffset + i + 1;

    if (line.startsWith('diff --git ')) {
      file = { oldPath: '', path: '', headerLines: [line], hunks: [], docLine };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) {
      continue;
    }

    // A new hunk header must be recognised even when a hunk is already open:
    // files routinely contain several hunks, and the header never appears as a
    // body line (context starts with a space, additions with '+', removals with '-').
    const match = HUNK_RE.exec(line);
    if (match) {
      hunk = {
        header: line,
        oldStart: Number.parseInt(match[1], 10),
        oldLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
        newStart: Number.parseInt(match[3], 10),
        newLines: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
        lines: [],
        docLine,
      };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      // Header block: `index`, modes, `---`/`+++`, `Binary files …`, `rename from/to`.
      file.headerLines.push(line);
      continue;
    }

    const marker = line[0];
    if (marker === '\\') {
      hunk.lines.push({ kind: 'nonewline', text: line });
    } else if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line });
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: line });
    } else {
      // ' ' for context; a bare '' can appear for an empty context line.
      hunk.lines.push({ kind: 'context', text: line.length === 0 ? ' ' : line });
    }
  }

  for (const parsed of files) {
    extractPaths(parsed);
  }
  return { text, files };
}

function extractPaths(file: DiffFile): void {
  for (const header of file.headerLines) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(header);
    if (plus && plus[1] !== '/dev/null') {
      file.path = plus[1];
    }
    const minus = /^--- (?:a\/)?(.+)$/.exec(header);
    if (minus && minus[1] !== '/dev/null') {
      file.oldPath = minus[1];
    }
  }

  if (!file.path) {
    const binary = /^Binary files (?:a\/)?(.+) and (?:b\/)?(.+) differ$/.exec(file.headerLines.find((l) => l.startsWith('Binary files')) ?? '');
    if (binary) {
      file.oldPath = file.oldPath || binary[1];
      file.path = binary[2];
    }
  }
  if (!file.path || !file.oldPath) {
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(file.headerLines[0] ?? '');
    if (gitHeader) {
      file.oldPath = file.oldPath || gitHeader[1];
      file.path = file.path || gitHeader[2];
    }
  }
  if (!file.oldPath) {
    file.oldPath = file.path;
  }
  if (!file.path) {
    file.path = file.oldPath;
  }
}

export type DiffMode = 'unstaged' | 'staged';

export interface DiffPosition {
  file: DiffFile;
  /** 1-based line in the new (working tree) version of the file. */
  line: number;
}

export interface HunkLocation {
  file: number;
  hunk: number;
}

/** Hunk that contains (or whose header starts at) the rendered document line. */
export function hunkAt(parsed: ParsedDiff, docLine: number): HunkLocation | undefined {
  for (let file = 0; file < parsed.files.length; file++) {
    const hunks = parsed.files[file].hunks;
    for (let hunk = 0; hunk < hunks.length; hunk++) {
      const start = hunks[hunk].docLine;
      const end = start + hunks[hunk].lines.length;
      if (docLine >= start && docLine <= end) {
        return { file, hunk };
      }
    }
  }
  return undefined;
}

/**
 * Maps a rendered document line to a file and a line in its new version, so
 * `Enter` in the diff buffer can jump to the code being reviewed.
 */
export function diffPosition(parsed: ParsedDiff, docLine: number): DiffPosition | undefined {
  for (const file of parsed.files) {
    const firstHunk = file.hunks[0];
    if (docLine >= file.docLine && (!firstHunk || docLine < firstHunk.docLine)) {
      return { file, line: 1 };
    }

    for (const hunk of file.hunks) {
      if (docLine === hunk.docLine) {
        return { file, line: Math.max(1, hunk.newStart) };
      }
      const bodyStart = hunk.docLine + 1;
      const offset = docLine - bodyStart;
      if (offset < 0 || offset >= hunk.lines.length) {
        continue;
      }
      let line = hunk.newStart;
      for (let index = 0; index < offset; index++) {
        const kind = hunk.lines[index].kind;
        if (kind === 'context' || kind === 'add') {
          line += 1;
        }
      }
      return { file, line: Math.max(1, line) };
    }
  }
  return undefined;
}

/** Stable short hash of a path list: two different sets never share a buffer. */
function pathsHash(paths: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of [...paths].sort().join('\u0000')) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 4);
}

/**
 * Last path segment of a diff buffer: the file path for a single file (so the
 * tab reads well), the first path plus a count and a hash for a set.
 */
export function diffSlug(paths: readonly string[]): string {
  if (paths.length === 0) {
    return '';
  }
  // Sorted, so the same set of files always names the same buffer.
  const sorted = [...paths].sort();
  const slug = sorted[0].replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'files';
  return paths.length === 1 ? slug : `${slug}+${paths.length - 1}-${pathsHash(paths)}`;
}
export function diffArgs(mode: DiffMode, paths: readonly string[] = []): string[] {
  // --submodule=log turns a gitlink change into Submodule path a..b, which is
  // readable; git ignores the flag for ordinary files.
  const common = ['--no-color', '--no-ext-diff', '--no-textconv', '--submodule=log', '-U3'];
  // Paths come last, after `--`, so a file called `-U3` stays a file.
  const scope = paths.length > 0 ? ['--', ...paths] : [];
  if (mode === 'staged') {
    return ['diff', '--cached', ...common, ...scope];
  }
  return ['diff', ...common, ...scope];
}
