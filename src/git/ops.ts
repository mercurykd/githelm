import { git } from './exec';
import { createLineSplitter, parseProgressLine, ProgressUpdate } from './progress';

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface PushOptions {
  /** Leased force: the push lands only if the remote ref still holds what we saw. */
  force?: boolean;
  /** Plain `--force`: overwrites the remote refs whatever they hold. */
  forceHard?: boolean;
  tags?: boolean;
  setUpstream?: boolean;
}

export interface PullOptions {
  rebase?: boolean;
  ffOnly?: boolean;
}

/** Pure arg builders: they are what the commands test, without touching a remote. */
export function pushArgs(remote: string, branch: string | undefined, opts: PushOptions = {}): string[] {
  const args = ['push'];
  if (opts.forceHard) {
    // `--force` disables the lease checks as well, so the two are never sent
    // together: when both are picked, the hard force is the one that was asked for.
    args.push('--force');
  } else if (opts.force) {
    args.push('--force-with-lease');
  }
  if (opts.tags) {
    args.push('--tags');
  }
  if (opts.setUpstream) {
    args.push('--set-upstream');
  }
  args.push(remote);
  if (branch) {
    args.push(branch);
  }
  return args;
}

export function fetchArgs(remote: string | undefined, opts: { prune?: boolean; tags?: boolean; progress?: boolean } = {}): string[] {
  const args = ['fetch'];
  if (opts.progress) {
    args.push('--progress');
  }
  if (opts.prune) {
    args.push('--prune');
  }
  if (opts.tags) {
    args.push('--tags');
  }
  if (remote) {
    args.push(remote);
  }
  return args;
}

export function pullArgs(remote: string | undefined, opts: PullOptions & { progress?: boolean } = {}): string[] {
  const args = ['pull'];
  if (opts.progress) {
    args.push('--progress');
  }
  if (opts.rebase) {
    args.push('--rebase');
  }
  if (opts.ffOnly) {
    args.push('--ff-only');
  }
  if (remote) {
    args.push(remote);
  }
  return args;
}

export function resetArgs(mode: ResetMode, target: string): string[] {
  const flag = mode === 'soft' ? '--soft' : mode === 'hard' ? '--hard' : '--mixed';
  return ['reset', flag, target];
}

function progressFeeder(onProgress?: (update: ProgressUpdate) => void): ((chunk: string) => void) | undefined {
  if (!onProgress) {
    return undefined;
  }
  return createLineSplitter((line) => {
    const update = parseProgressLine(line);
    if (update) {
      onProgress(update);
    }
  });
}

async function run(repoPath: string, args: string[], onStderr?: (chunk: string) => void): Promise<void> {
  const result = await git(repoPath, args, onStderr ? { onStderr } : {});
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed (${result.code})`);
  }
}

export async function fetchRemote(
  repoPath: string,
  remote: string | undefined,
  opts: { prune?: boolean; tags?: boolean } = {},
  onProgress?: (update: ProgressUpdate) => void
): Promise<void> {
  await run(repoPath, fetchArgs(remote, { ...opts, progress: Boolean(onProgress) }), progressFeeder(onProgress));
}

export async function pullRemote(
  repoPath: string,
  remote: string | undefined,
  opts: PullOptions = {},
  onProgress?: (update: ProgressUpdate) => void
): Promise<void> {
  await run(repoPath, pullArgs(remote, { ...opts, progress: Boolean(onProgress) }), progressFeeder(onProgress));
}

export async function pushRemote(
  repoPath: string,
  remote: string,
  branch: string | undefined,
  opts: PushOptions = {}
): Promise<void> {
  await run(repoPath, pushArgs(remote, branch, opts));
}

export async function resetTo(repoPath: string, mode: ResetMode, target: string): Promise<void> {
  await run(repoPath, resetArgs(mode, target));
}

/**
 * What a discard touches, split by the layer the cursor is on: the index, the
 * working tree, or the file itself. Discarding a staged row must not touch the
 * working-tree edits of the same file, and deleting an untracked file must not
 * drop an index entry that tracks it — hence four separate lists.
 */
export interface DiscardRequest {
  /** Index entries that go back to HEAD (`git restore --staged`). */
  staged: readonly string[];
  /** Working-tree changes that go back to the index (`git restore --worktree`). */
  worktree: readonly string[];
  /** Paths with no committed version: intent-to-add and conflicted files. */
  reset: readonly string[];
  /** Files git never tracked: they are deleted from disk. */
  remove: readonly string[];
}

/** Staged row: the index goes back to HEAD, the working tree is untouched. */
export function discardStagedArgs(paths: readonly string[]): string[] {
  return ['restore', '--source=HEAD', '--staged', '--', ...paths];
}

/** Unstaged row: the working tree goes back to the index, the index is untouched. */
export function discardWorktreeArgs(paths: readonly string[]): string[] {
  return ['restore', '--worktree', '--', ...paths];
}

/** Conflict or intent-to-add: both layers, so the path ends up as HEAD has it. */
export function discardAllArgs(paths: readonly string[]): string[] {
  return ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths];
}

/** Untracked paths are not in git at all, so discarding them deletes them. */
export function cleanArgs(paths: readonly string[]): string[] {
  return ['clean', '-f', '-d', '-q', '--', ...paths];
}

/** `git restore` needs 2.23+; older gits spell the same operations differently. */
export function discardFallbackArgs(layer: 'staged' | 'worktree' | 'all', paths: readonly string[]): string[] {
  if (layer === 'staged') {
    return ['reset', '-q', 'HEAD', '--', ...paths];
  }
  return ['checkout', ...(layer === 'all' ? ['HEAD'] : []), '--', ...paths];
}

async function restoreLayer(
  repoPath: string,
  layer: 'staged' | 'worktree' | 'all',
  paths: readonly string[]
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const args = layer === 'staged' ? discardStagedArgs(paths) : layer === 'worktree' ? discardWorktreeArgs(paths) : discardAllArgs(paths);
  let result = await git(repoPath, args);
  if (result.code !== 0 && /unknown (sub)?command|not a git command|usage/i.test(result.stderr)) {
    result = await git(repoPath, discardFallbackArgs(layer, paths));
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`);
  }
}

/**
 * Discards exactly the layers named in `request`. Order matters: the index is
 * reset before the working tree is restored from it, so two cursors on the
 * staged and the unstaged row of one file leave that file fully clean.
 *
 * Callers confirm first: this is the one status action that cannot be undone.
 */
export async function discardPaths(repoPath: string, request: DiscardRequest): Promise<void> {
  await restoreLayer(repoPath, 'all', request.reset);
  await restoreLayer(repoPath, 'staged', request.staged);
  await restoreLayer(repoPath, 'worktree', request.worktree);
  if (request.remove.length > 0) {
    const result = await git(repoPath, cleanArgs(request.remove));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git clean failed (${result.code})`);
    }
  }
}

export async function mergeRef(repoPath: string, ref: string): Promise<void> {
  const result = await git(repoPath, ['merge', '--no-edit', ref]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `git merge завершился с кодом ${result.code}. При конфликте разрешите его и сделайте commit, либо прервите через abort.`
    );
  }
}

/** `MERGE_HEAD`, `REVERT_HEAD`, `CHERRY_PICK_HEAD` exist only while that operation runs. */
export type PendingOperation = 'merge' | 'revert' | 'cherry-pick';

const PENDING_REFS: Array<[string, PendingOperation]> = [
  ['MERGE_HEAD', 'merge'],
  ['REVERT_HEAD', 'revert'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
];

/** Which operation is half-done in the repository, if any. */
export async function pendingOperation(repoPath: string): Promise<PendingOperation | undefined> {
  for (const [ref, kind] of PENDING_REFS) {
    const result = await git(repoPath, ['rev-parse', '--quiet', '--verify', ref]);
    if (result.code === 0) {
      return kind;
    }
  }
  return undefined;
}

/**
 * `git <kind> --abort` for whatever is half-done. `M` on the status screen calls
 * this: a conflicted merge, revert or cherry-pick all need the same key.
 */
export async function abortPendingOperation(repoPath: string): Promise<PendingOperation | undefined> {
  const kind = await pendingOperation(repoPath);
  if (!kind) {
    return undefined;
  }
  const result = await git(repoPath, [kind, '--abort']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${kind} --abort failed (${result.code})`);
  }
  return kind;
}

/**
 * `git revert --no-edit <sha>`: a new commit that undoes `sha`, with the default
 * `Revert "…"` message. A merge commit needs `mainline` (`-m N`): the parent the
 * history keeps. A conflict leaves `REVERT_HEAD` behind — resolve it and
 * `git revert --continue`, or press `M` on the status screen to abort.
 */
export async function revertCommit(repoPath: string, sha: string, mainline?: number): Promise<void> {
  const args = ['revert', '--no-edit'];
  if (mainline !== undefined) {
    args.push('-m', String(mainline));
  }
  args.push(sha);
  const result = await git(repoPath, args);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `git revert failed (${result.code})`
    );
  }
}

export async function deleteRemoteBranch(repoPath: string, remote: string, branch: string): Promise<void> {
  const result = await git(repoPath, ['push', remote, '--delete', branch]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git push --delete failed (${result.code})`);
  }
}

export async function renameRemote(repoPath: string, from: string, to: string): Promise<void> {
  const result = await git(repoPath, ['remote', 'rename', from, to]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git remote rename failed (${result.code})`);
  }
}
