import { git } from './exec';

export interface StashEntry {
  /** `stash@{0}` */
  ref: string;
  subject: string;
}

export async function listStashes(repoPath: string): Promise<StashEntry[]> {
  const result = await git(repoPath, ['stash', 'list', '--format=%gd%x1f%gs']);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const separator = line.indexOf('\x1f');
      return {
        ref: separator >= 0 ? line.slice(0, separator) : line,
        subject: separator >= 0 ? line.slice(separator + 1) : '',
      };
    });
}

/** How `z` was asked to stash: the flags and the paths of `git stash push`. */
export interface StashOptions {
  /** `--staged`: stash the index and leave the working tree alone. */
  staged?: boolean;
  /** `-u`: untracked files go into the stash too. */
  includeUntracked?: boolean;
  /** Paths to stash; empty means the whole working tree. */
  paths?: readonly string[];
}

/** A file the cursor covers, as the status screen reports it. */
export interface StashCandidate {
  path: string;
  section: string;
}

/**
 * The rule of `z`: files under the cursors answer the question themselves, so
 * the picked options do not apply then — but a selected untracked file needs
 * `-u`, otherwise `git stash push -- <path>` refuses a path it does not track.
 * With no file selected the picked options decide, and picking none is a plain
 * stash of the working tree.
 */
export function planStash(selected: readonly StashCandidate[], options: StashOptions = {}): StashOptions {
  if (selected.length === 0) {
    return {
      ...(options.staged ? { staged: true } : {}),
      ...(options.includeUntracked ? { includeUntracked: true } : {}),
    };
  }
  return {
    paths: [...new Set(selected.map((entry) => entry.path))],
    ...(selected.some((entry) => entry.section === 'untracked') ? { includeUntracked: true } : {}),
  };
}

/** The arguments of `git stash push` for these options, in the order git reads them. */
export function stashArgs(options: StashOptions, message?: string): string[] {
  const args = ['stash', 'push'];
  if (options.staged) {
    args.push('--staged');
  }
  if (options.includeUntracked) {
    args.push('--include-untracked');
  }
  const trimmed = message?.trim();
  if (trimmed) {
    args.push('-m', trimmed);
  }
  const paths = options.paths ?? [];
  if (paths.length > 0) {
    args.push('--', ...paths);
  }
  return args;
}

export async function pushStash(repoPath: string, message?: string, options: StashOptions = {}): Promise<void> {
  const result = await git(repoPath, stashArgs(options, message));
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git stash push failed (${result.code})`);
  }
}

export async function applyStash(repoPath: string, ref: string): Promise<void> {
  const result = await git(repoPath, ['stash', 'apply', ref]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git stash apply failed (${result.code})`);
  }
}

export async function popStash(repoPath: string, ref: string): Promise<void> {
  const result = await git(repoPath, ['stash', 'pop', ref]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git stash pop failed (${result.code})`);
  }
}

export async function dropStash(repoPath: string, ref: string): Promise<void> {
  const result = await git(repoPath, ['stash', 'drop', ref]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git stash drop failed (${result.code})`);
  }
}

export interface StashFile {
  status: string;
  path: string;
}

/** Files touched by a stash, for the stash browser screen. */
export async function stashFiles(repoPath: string, ref: string): Promise<StashFile[]> {
  let result = await git(repoPath, ['stash', 'show', '--name-status', '--include-untracked', '--no-color', ref]);
  if (result.code !== 0) {
    result = await git(repoPath, ['stash', 'show', '--name-status', '--no-color', ref]);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git stash show --name-status failed (${result.code})`);
  }

  const files: StashFile[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    files.push({ status: parts[0] ?? '?', path: parts[parts.length - 1] ?? '' });
  }
  return files;
}

/**
 * The revision each stashed file's content lives under. A tracked file is in the stash
 * commit itself; an untracked file stashed with `-u` lives in the stash's third parent;
 * a file deleted by the stash is in neither and is left out. The list is read twice
 * instead of asking git per file, so a large stash does not turn into a process storm.
 */
export async function stashRefsForFiles(
  repoPath: string,
  ref: string,
  files: readonly string[]
): Promise<Map<string, string>> {
  const wanted = new Set(files);
  const refs = new Map<string, string>();
  for (const revision of [ref, `${ref}^3`]) {
    const result = await git(repoPath, ['ls-tree', '-r', '--name-only', revision]);
    if (result.code !== 0) {
      continue;
    }
    for (const line of result.stdout.split('\n')) {
      const path = line.replace(/\r$/, '');
      if (path.length > 0 && wanted.has(path) && !refs.has(path)) {
        refs.set(path, revision);
      }
    }
  }
  return refs;
}

export async function stashFileDiff(repoPath: string, ref: string, path: string): Promise<string> {
  // `git stash show` does not take a pathspec, so diff the stash against its
  // first parent instead — that is exactly what `stash show -p` prints.
  const result = await git(repoPath, ['diff', '--no-color', `${ref}^1`, ref, '--', path]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git diff ${ref}^1 ${ref} failed (${result.code})`);
  }
  if (result.stdout.trim().length > 0) {
    return result.stdout;
  }
  // Untracked files stashed with -u live in the third parent.
  const untracked = await git(repoPath, ['show', '--no-color', `${ref}^3`, '--', path]);
  if (untracked.code === 0 && untracked.stdout.trim().length > 0) {
    return untracked.stdout;
  }
  return `(no changes for ${path})\n`;
}

/** Patch of one stash, including untracked files when git supports it. */
export async function showStash(repoPath: string, ref: string): Promise<string> {
  let result = await git(repoPath, ['stash', 'show', '-p', '--no-color', '--include-untracked', ref]);
  if (result.code !== 0) {
    result = await git(repoPath, ['stash', 'show', '-p', '--no-color', ref]);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git stash show failed (${result.code})`);
  }
  return result.stdout.length > 0 ? result.stdout : `(empty stash ${ref})\n`;
}
