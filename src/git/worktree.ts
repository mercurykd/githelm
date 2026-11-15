import * as fs from 'fs';
import * as path from 'path';
import { git } from './exec';

export interface WorktreeEntry {
  /** Absolute path of the worktree, exactly as git prints it. */
  path: string;
  /** HEAD commit of that worktree (empty for a bare repository). */
  head: string;
  /** Checked out branch, undefined when the worktree is detached. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** The directory is gone: `git worktree prune` removes the entry. */
  prunable: boolean;
}

/** Compares two repository paths the way the platform does. */
export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) {
    return true;
  }
  // Git prints `D:/…` where VS Code may hand us `d:/…`.
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
}

/**
 * `git worktree list --porcelain`. A failure (git without worktree support,
 * a broken checkout) yields an empty list: the status screen simply does not
 * show the section instead of failing to render.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const result = await git(repoPath, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const raw of result.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (current) {
        entries.push(current);
      }
      current = {
        path: line.slice('worktree '.length).trim(),
        head: '',
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

/** The worktree the repository was asked about, if git lists it. */
export function currentWorktree(worktrees: WorktreeEntry[], repoPath: string): WorktreeEntry | undefined {
  return worktrees.find((worktree) => samePath(worktree.path, repoPath));
}

/**
 * A linked worktree keeps its git directory elsewhere and only has a `.git`
 * *file* pointing at it; the main checkout has a `.git` directory. Cheap enough
 * for the status bar, which runs without a status buffer being open.
 */
export function isLinkedWorktree(repoPath: string): boolean {
  try {
    return fs.statSync(path.join(repoPath, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * `git worktree add <path> <ref>` — `ref` may be a branch, a tag or a commit.
 * Anything that does not resolve becomes a new branch started at HEAD.
 */
export async function addWorktree(repoPath: string, worktreePath: string, ref: string): Promise<void> {
  const resolves = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const args =
    resolves.code === 0
      ? ['worktree', 'add', worktreePath, ref]
      : ['worktree', 'add', '-b', ref, worktreePath];
  const result = await git(repoPath, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git worktree add failed (${result.code})`);
  }
}

/** `git worktree remove [--force] <path>`. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const args = ['worktree', 'remove'];
  if (options.force) {
    args.push('--force');
  }
  args.push(worktreePath);
  const result = await git(repoPath, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git worktree remove failed (${result.code})`);
  }
}

/** `git worktree prune -v`: returns how many stale entries were dropped. */
export async function pruneWorktrees(repoPath: string): Promise<number> {
  // `--expire now` skips the default grace period, so an entry whose directory
  // was just deleted is pruned on the first try. `--verbose` reports every
  // removal on stderr ("Removing worktrees/<name>: …").
  const result = await git(repoPath, ['worktree', 'prune', '--verbose', '--expire', 'now']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git worktree prune failed (${result.code})`);
  }
  return result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Removing ')).length;
}
