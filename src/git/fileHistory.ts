import path from 'node:path';
import type { Span } from '../util/span';
import { git } from './exec';
import { authorColumnWidth, truncateAuthor } from './log';

/** Path of a file relative to the repository root, using forward slashes. */
export function repoRelativePath(repoPath: string, filePath: string): string {
  return path.relative(repoPath, filePath).split(path.sep).join('/');
}

/**
 * What `prepare` hands a document: the text the buffer shows and the ranges the highlighter
 * paints. A file's *log* is read as text, so it is this shape; its *blame* is read as code,
 * and is a `BlameView`.
 */
export interface HistoryView {
  text: string;
  spans: Span[];
}

/** The rule under a header, as long as the header or 20 columns, whichever is wider. */
function ruleFor(header: string): string {
  return '─'.repeat(Math.max(20, header.length));
}

/** A blame row, as `git blame` prints it, split into the cells a reader scans. */
export interface BlameLine {
  /**
   * The sha, without the `^` git puts in front of a boundary commit. `fileBlame` asks for
   * the full forty characters, so a second command can find the commit again; the gutter
   * still prints eight of them.
   */
  sha: string;
  author: string;
  /** `YYYY-MM-DD`, because blame is asked for `--date=short`. */
  date: string;
  /** The line number in the file, 1-based. */
  line: number;
  /** The line itself, exactly as it is in the file. */
  text: string;
  /** A line that is not in a commit yet: git prints a zero sha for it. */
  uncommitted: boolean;
}

/**
 * `git blame --date=short -- <file>` output, one row per line of the file.
 *
 * The format is `<sha> (<author> <date> <line>) <text>`, with the author possibly
 * containing spaces and the text possibly containing anything at all — parentheses
 * included — so the date anchors the split instead of the first `)`.
 */
export function parseBlame(stdout: string): BlameLine[] {
  const rows: BlameLine[] = [];
  // A file checked out with CRLF arrives with them, and a row is one line of that file:
  // the split takes them off, or every row would end with a stray carriage return.
  for (const line of stdout.split(/\r?\n/)) {
    const raw = line.replace(/\r$/, '');
    if (raw.length === 0) {
      continue;
    }
    // `git blame` pads the sha to eight columns, so a shorter one is preceded by spaces.
    const match = /^\s*(\^?[0-9a-fA-F]+)\s+\((.*?)\s+(\d{4}-\d{2}-\d{2})\s+(\d+)\)\s?(.*)$/.exec(raw);
    if (!match) {
      continue;
    }
    const sha = match[1].replace(/^\^/, '');
    rows.push({
      sha,
      author: match[2],
      date: match[3],
      line: Number(match[4]),
      text: match[5].replace(/\r$/, ''),
      uncommitted: /^0+$/.test(sha),
    });
  }
  return rows;
}

/** The width of each cell of a blame's gutter, in characters of the editor's font. */
export const BLAME_WIDTHS = { sha: 8, author: 16, date: 10, subject: 28 } as const;

/** One space between two cells, and the two that separate the gutter from the code. */
const BLAME_SEPARATOR = ' ';
const BLAME_GAP = '  ';

/** What a whole line of the gutter is worth: the separators, the four cells, the gap. */
export const BLAME_GUTTER_WIDTH =
  BLAME_SEPARATOR.length +
  BLAME_WIDTHS.sha +
  BLAME_SEPARATOR.length +
  BLAME_WIDTHS.author +
  BLAME_SEPARATOR.length +
  BLAME_WIDTHS.date +
  BLAME_SEPARATOR.length +
  BLAME_WIDTHS.subject +
  BLAME_GAP.length;

/** How many commits one `git show` is asked for: well under the command line's limit. */
const BLAME_MESSAGE_CHUNK = 100;

/** The subject of a commit message: its first non-empty line, which is what a cell fits. */
function firstLine(message: string): string {
  const line = message.split('\n').find((part) => part.trim().length > 0);
  return (line ?? '').trim();
}

/** A cell value cut to its column, so a long login cannot push the code to the right. */
function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

/** One cell of a gutter line, padded to its column and led by its separator. */
function cell(text: string, width: number, last = false): string {
  const padded = `${BLAME_SEPARATOR}${text.padEnd(width)}`;
  return last ? `${padded}${BLAME_GAP}` : padded;
}

/** A line of the gutter with nothing in it but the width of one: a block goes on. */
function blankGutter(): string {
  return ' '.repeat(BLAME_GUTTER_WIDTH);
}

/** One line of a blame's gutter, as the editor draws it in front of the code. */
export interface BlameLineView {
  /** 0-based line of the file this row annotates. */
  line: number;
  /**
   * The first line of a commit's block: only it prints the metadata. Every other line of the
   * block carries blank cells of the same width, or the code would move on it.
   */
  block: boolean;
  /** The gutter in one string, `BLAME_GUTTER_WIDTH` characters wide; blank mid-block. */
  gutter: string;
  /**
   * The whole commit message, newlines and all: what the line's hover shows. The gutter only
   * fits the subject, cut. Empty when there is no message — a line that is not committed.
   */
  message: string;
  /** A line that is not in a commit yet: no sha, no author and no message. */
  uncommitted: boolean;
}

/**
 * A blame: the file's own code, and the metadata of every line of it.
 *
 * The code is the file's text, not a rendering of it. A blame is read for its code, so the
 * code has to be the one thing a reader trusts: the file itself, in a real editor, highlighted
 * by the grammar VS Code would use to open it, as wide as its longest line needs and scrolled
 * rather than wrapped. Padding the gutter into that text would make it a different file —
 * tokens would start at column 68, no grammar would read them, and the whitespace between the
 * metadata and the code would be part of the code.
 *
 * So the metadata is not text at all: it is drawn *in front of* the line by a decoration
 * (`views/blameGutter.ts`), one fixed-width cell per column. A column is a width, and text
 * cannot have one; a decoration can, which is also why the gutter stays a column while the
 * code scrolls under it.
 *
 * The log of a file is the opposite case — it *is* text, and both screens draw it from one
 * `HistoryView`.
 */
export interface BlameView {
  relativePath: string;
  /** The file's lines: what the editor shows, highlights and lets the reader select. */
  text: string;
  /** One row per line of `text`, in the same order. */
  lines: BlameLineView[];
  /** Lines the blame stopped short of, when it was cut at `maxLines`. */
  truncated: number;
}

/**
 * Lays a blame out as the two things a reader needs: the file's code, and the gutter of every
 * line of it.
 *
 * A run of consecutive lines from one commit prints its metadata on the first line and is
 * blank on the rest — twenty copies of the same sha is what makes a blame unreadable — and
 * every line of the block still carries the whole message as its hover, because the question
 * a line raises is about the commit, not about which line of the block it is. `messages`
 * supplies it: `git blame` knows who and when but not *why*.
 */
export function blameLines(
  relativePath: string,
  rows: readonly BlameLine[],
  maxLines = 3000,
  messages?: ReadonlyMap<string, string>
): BlameView {
  const shown = rows.slice(0, maxLines);
  const lines: BlameLineView[] = [];
  let current: string | undefined;
  for (const row of shown) {
    const line = lines.length;
    const key = row.uncommitted ? 'uncommitted' : row.sha;
    // The first line of a block prints the cells; the rest of the block leaves them empty.
    const block = key !== current;
    current = key;

    // A line that is not committed has no commit to ask, so it has no message either.
    const message = row.uncommitted ? '' : messages?.get(row.sha) ?? '';
    let gutter = blankGutter();
    if (block) {
      gutter = row.uncommitted
        ? [
            cell('—', BLAME_WIDTHS.sha),
            cell('не в коммите', BLAME_WIDTHS.author),
            cell('—', BLAME_WIDTHS.date),
            cell('', BLAME_WIDTHS.subject, true),
          ].join('')
        : [
            // Eight characters of sha: the whole forty belong to the command, not the reader.
            cell(row.sha.slice(0, BLAME_WIDTHS.sha), BLAME_WIDTHS.sha),
            cell(truncate(row.author, BLAME_WIDTHS.author), BLAME_WIDTHS.author),
            cell(row.date.slice(0, BLAME_WIDTHS.date), BLAME_WIDTHS.date),
            // The subject of the commit, cut to its cell: the rest of the message — and its
            // body — is the line's hover.
            cell(truncate(firstLine(message), BLAME_WIDTHS.subject), BLAME_WIDTHS.subject, true),
          ].join('');
    }

    lines.push({ line, block, gutter, message, uncommitted: row.uncommitted });
  }

  return {
    relativePath,
    text: shown.map((row) => row.text).join('\n'),
    lines,
    truncated: rows.length - shown.length,
  };
}

export async function fileLog(repoPath: string, relativePath: string, limit = 200): Promise<HistoryView> {
  const result = await git(repoPath, [
    'log',
    '--follow',
    '--no-color',
    '--date=short',
    `--max-count=${limit}`,
    '--format=%h%x1f%ad%x1f%an%x1f%s%x1f%D',
    '--',
    relativePath,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git log --follow failed (${result.code})`);
  }

  const lines = result.stdout.split('\n').filter((line) => line.length > 0);
  const header = `История файла: ${relativePath} (${lines.length} коммитов)`;
  const commits = lines.map((line) => {
    const [sha = '', date = '', author = '', subject = '', refs = ''] = line.split('\x1f');
    return { sha, date, author, subject, refs };
  });
  // Same author column as the history graph: as wide as the longest name, so
  // the subject starts two columns after it instead of after a fixed 20.
  const authorWidth = authorColumnWidth(commits.map((commit) => commit.author));
  const text = ['', header, ruleFor(header)];
  const spans: Span[] = [
    { line: 1, start: 0, end: header.length, kind: 'section' },
    { line: 2, start: 0, end: text[2].length, kind: 'rule' },
  ];
  for (const { sha, date, author, subject, refs } of commits) {
    // `%D` gives bare ref names (the history graph reads the same field), so the
    // parentheses below are the only ones — with `%d` they were doubled up.
    const decorations = refs.trim() ? `  (${refs.trim()})` : '';
    const line = text.length;
    let row = sha.padEnd(9);
    spans.push({ line, start: 0, end: sha.length, kind: 'hash' });
    const dateStart = row.length;
    row += date.padEnd(12);
    spans.push({ line, start: dateStart, end: dateStart + date.length, kind: 'date' });
    const authorStart = row.length;
    const name = truncateAuthor(author);
    row += name.padEnd(authorWidth);
    spans.push({ line, start: authorStart, end: authorStart + name.length, kind: 'author' });
    row += subject;
    // The decorations are `  (ref, ref)`: paint the names, not the parentheses.
    if (decorations.length > 0) {
      const refsStart = row.length + 3;
      spans.push({ line, start: refsStart, end: refsStart + refs.trim().length, kind: 'refs' });
    }
    row += decorations;
    text.push(row);
  }
  text.push('');
  return { text: text.join('\n'), spans };
}

/**
 * The messages of the commits a blame names, by sha, in one `git show` per hundred of them.
 *
 * `git blame` knows the author and the date and says nothing about what the commit said.
 * `git show -s --format=%H%x1f%B` prints the full body of a whole list of commits in one
 * process, and the sha keys it: blame is asked for the full one, so no abbreviation has to
 * be guessed at. A failed lookup is not fatal — the message decorates rows the blame itself
 * already laid out, and a repository that refuses one command still has a blame.
 */
async function blameMessages(repoPath: string, rows: readonly BlameLine[]): Promise<Map<string, string>> {
  const shas = [...new Set(rows.filter((row) => !row.uncommitted).map((row) => row.sha))];
  const messages = new Map<string, string>();
  for (let at = 0; at < shas.length; at += BLAME_MESSAGE_CHUNK) {
    const chunk = shas.slice(at, at + BLAME_MESSAGE_CHUNK);
    const result = await git(repoPath, ['show', '-s', '--no-color', '--format=%H%x1f%B%x1e', ...chunk]);
    if (result.code !== 0) {
      continue;
    }
    for (const record of result.stdout.split('\x1e')) {
      const [sha = '', body = ''] = record.replace(/^\n+/, '').split('\x1f');
      if (sha.length > 0) {
        // `%B` ends with the newline git keeps; the message itself ends where it ends.
        messages.set(sha, body.replace(/\s+$/, ''));
      }
    }
  }
  return messages;
}

export async function fileBlame(repoPath: string, relativePath: string, maxLines = 3000): Promise<BlameView> {
  // The full sha, because a second command has to find the commit again to read its message;
  // the column still prints eight characters of it, so nothing a reader sees changes.
  // `--root` is not about the layout: git marks a root commit's sha with a `^`, and that
  // caret is one of the forty columns the sha may fill, which would leave thirty-nine
  // characters of sha and a message lookup that misses the very first commit of a file.
  const result = await git(repoPath, ['blame', '--root', '--abbrev=40', '--date=short', '--', relativePath]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git blame failed (${result.code})`);
  }
  const rows = parseBlame(result.stdout);
  const messages = await blameMessages(repoPath, rows.slice(0, maxLines));
  return blameLines(relativePath, rows, maxLines, messages);
}
