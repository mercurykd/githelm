import { git } from './exec';
import type { Span } from '../util/span';

/**
 * One commit as a screen of its own: who wrote it, when, what it says, and the files it
 * touched.
 *
 * This used to be `git show`: metadata, a stat and the whole patch. The patch is what the
 * reader almost never wants first — it is one screen of text that scrolls the file list
 * off the top, and the diff of a file has a better home in the editor. So the screen is
 * the answer to "what is this commit" and the list is the way into "show me that file",
 * the way a stash's screen already worked.
 */
export interface CommitMeta {
  /** Full sha of the commit, whatever the screen was asked by. */
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** Already formatted for the screen: `git log --date=<the user's format>`. */
  date: string;
  /** First line of the message. */
  subject: string;
  /** The rest of the message, verbatim, without the trailing newline. */
  body: string;
}

/** A file the commit touched, as `git diff --name-status` reports it. */
export interface CommitChange {
  /** `M`, `A`, `D`, `R`, `C`, `T`, … — the letter of the status, as git prints it. */
  status: string;
  path: string;
}

/** A row of the file list: the line of the document (1-based) and the file it names. */
export interface CommitFileRow {
  line: number;
  path: string;
  status: string;
}

export interface CommitScreen {
  text: string;
  spans: Span[];
  /** The rows that name a file, so a key can find the file under the cursor. */
  rows: CommitFileRow[];
  /**
   * The line (1-based) of the `## files (n)` header. A key on that line means the whole
   * list, which is what a click on it selects.
   */
  header: number;
}

/** The commit a ref names, or `undefined` when git cannot resolve it. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | undefined> {
  // `^{commit}` peels an annotated tag to the commit it points at, so a tag name works
  // here exactly like a sha does.
  const result = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.code !== 0) {
    return undefined;
  }
  const sha = result.stdout.trim();
  return /^[0-9a-f]{4,64}$/i.test(sha) ? sha : undefined;
}

/** The first parent of a commit, or `undefined` for a root commit. */
export async function firstParent(repoPath: string, sha: string): Promise<string | undefined> {
  const result = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^`]);
  if (result.code !== 0) {
    return undefined;
  }
  const parent = result.stdout.trim();
  return /^[0-9a-f]{4,64}$/i.test(parent) ? parent : undefined;
}

/** The commit's own metadata, read in one call. */
export async function readCommitMeta(
  repoPath: string,
  sha: string,
  dateFormat = '%Y-%m-%d %H:%M'
): Promise<CommitMeta> {
  const result = await git(repoPath, [
    'log',
    '-1',
    '--no-color',
    `--date=format:${dateFormat}`,
    '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b',
    sha,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git log failed (${result.code})`);
  }
  const [full = '', shortSha = '', author = '', email = '', date = '', subject = '', ...rest] = result.stdout
    .split('\x1f');
  return {
    sha: full.trim() || sha,
    shortSha: shortSha.trim() || sha.slice(0, 7),
    author,
    email,
    date,
    subject,
    // `%b` is the body without the subject; a trailing newline is not part of it.
    body: rest.join('\x1f').replace(/\s+$/, ''),
  };
}

/**
 * The files a commit touched, read against its first parent — the same comparison the
 * built-in diff editor will show when one of them is opened. A root commit is compared
 * with the empty tree, so every file it introduced is an addition.
 */
export async function readCommitChanges(repoPath: string, sha: string): Promise<CommitChange[]> {
  const parent = await firstParent(repoPath, sha);
  const args = ['diff', '--no-color', '--name-status', '-M'];
  if (parent) {
    args.push(parent, sha);
  } else {
    // The empty tree: `git diff` against it lists the whole root commit as additions.
    args.push('4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha);
  }
  const result = await git(repoPath, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git diff failed (${result.code})`);
  }
  const changes: CommitChange[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const [status = '', firstPath = '', secondPath = ''] = line.split('\t');
    if (firstPath.length === 0) {
      continue;
    }
    // A rename prints the old and the new path; the new one is the file to open.
    changes.push({ status: status.slice(0, 1), path: (secondPath || firstPath).trim() });
  }
  return changes;
}

/** The colour role of a status letter: added, deleted, modified — the status screen's. */
export function statusKind(status: string): Span['kind'] {
  switch (status) {
    case 'A':
    case 'C':
      return 'file-added';
    case 'D':
      return 'file-deleted';
    case 'R':
      return 'file-modified';
    default:
      return 'file-modified';
  }
}

/**
 * The commit screen in both UIs: the metadata, the message and one row per file, with the
 * spans that paint them. Kept out of the buffer so the panel and the buffer cannot draw
 * two different lists, and so the layout is testable without a window.
 */
export function renderCommitScreen(
  meta: CommitMeta,
  changes: readonly CommitChange[],
  filesTitle: string,
  hints: string,
  maxFiles = 2000
): CommitScreen {
  const shown = changes.slice(0, maxFiles);
  const lines: string[] = [];
  const spans: Span[] = [];
  const rows: CommitFileRow[] = [];

  const title = `${meta.shortSha}  ${meta.subject}`;
  lines.push(title);
  spans.push({ line: 0, start: 0, end: meta.shortSha.length, kind: 'hash' });
  if (meta.subject.length > 0) {
    spans.push({ line: 0, start: meta.shortSha.length + 2, end: title.length, kind: 'title' });
  }

  const author = `Author: ${meta.author} <${meta.email}>`;
  lines.push(author);
  spans.push({ line: 1, start: 0, end: 'Author:'.length, kind: 'meta' });
  spans.push({ line: 1, start: 'Author: '.length, end: author.length, kind: 'author' });

  const date = `Date:   ${meta.date}`;
  lines.push(date);
  spans.push({ line: 2, start: 0, end: 'Date:'.length, kind: 'meta' });
  spans.push({ line: 2, start: 'Date:   '.length, end: date.length, kind: 'date' });

  const commit = `commit ${meta.sha}`;
  lines.push(commit);
  spans.push({ line: 3, start: 0, end: 'commit '.length, kind: 'meta' });
  spans.push({ line: 3, start: 'commit '.length, end: commit.length, kind: 'hash' });

  if (meta.body.length > 0) {
    lines.push('');
    for (const line of meta.body.split('\n')) {
      // The body keeps its own indentation, two columns inside the header, as `git show`
      // and a commit message editor both print it.
      lines.push(line.length > 0 ? `    ${line}` : '');
    }
  }

  lines.push('');
  const header = `## ${filesTitle} (${shown.length})`;
  const headerLine = lines.length;
  lines.push(header);
  spans.push({ line: headerLine, start: 0, end: header.length, kind: 'section' });
  const hintLine = lines.length;
  lines.push(`  ${hints}`);
  spans.push({ line: hintLine, start: 2, end: 2 + hints.length, kind: 'help' });
  lines.push('');

  for (const change of shown) {
    const line = lines.length;
    // 1-based, because that is what the panel's line ids and the buffer both count in.
    rows.push({ line: line + 1, path: change.path, status: change.status });
    const text = `  ${change.status} ${change.path}`;
    lines.push(text);
    spans.push({ line, start: 2, end: 3, kind: statusKind(change.status) });
    spans.push({ line, start: 4, end: text.length, kind: 'path' });
  }

  if (changes.length > shown.length) {
    const note = `… (ещё ${changes.length - shown.length} файлов)`;
    const line = lines.length;
    lines.push(note);
    spans.push({ line, start: 0, end: note.length, kind: 'meta' });
  }

  lines.push('');
  return { text: lines.join('\n'), spans, rows, header: headerLine + 1 };
}
