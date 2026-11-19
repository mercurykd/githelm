import { git } from './exec';

export class PatchApplyError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

function applyArgs(reverse: boolean): string[] {
  const args = ['apply', '--cached', '--whitespace=nowarn'];
  if (reverse) {
    args.push('--reverse');
  }
  return args;
}

/**
 * Applies a patch to the index only (the working tree is untouched).
 * Validates with `--check` first so a bad patch never half-applies.
 */
export async function applyPatchToIndex(
  repoPath: string,
  patch: string,
  options: { reverse?: boolean } = {}
): Promise<void> {
  if (!patch.trim()) {
    return;
  }
  const args = applyArgs(options.reverse ?? false);

  const check = await git(repoPath, [...args, '--check', '-'], { input: patch });
  if (check.code !== 0) {
    throw new PatchApplyError(`git apply --check failed: ${check.stderr.trim()}`, check.stderr);
  }

  const applied = await git(repoPath, [...args, '-'], { input: patch });
  if (applied.code !== 0) {
    throw new PatchApplyError(`git apply failed: ${applied.stderr.trim()}`, applied.stderr);
  }
}

export async function stageFile(repoPath: string, filePath: string): Promise<void> {
  await stageFiles(repoPath, [filePath]);
}

/** `git add` is batched so a whole section or a multi-line selection is one call. */
export async function stageFiles(repoPath: string, paths: string[]): Promise<void> {
  for (const chunk of chunkPaths(paths)) {
    const result = await git(repoPath, ['add', '--', ...chunk]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git add failed (${result.code})`);
    }
  }
}

/**
 * Marks an untracked file as "intent to add" so it shows up in `git diff`
 * and can be staged partially, line by line, like any other file.
 */
export async function addIntentToAdd(repoPath: string, filePath: string): Promise<void> {
  const result = await git(repoPath, ['add', '--intent-to-add', '--', filePath]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git add --intent-to-add failed (${result.code})`);
  }
}

export async function unstageFile(repoPath: string, filePath: string): Promise<void> {
  await unstageFiles(repoPath, [filePath]);
}

/** `git add -A`: every change in the work tree, deletions included. */
export async function stageAll(repoPath: string): Promise<void> {
  const result = await git(repoPath, ['add', '-A']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git add -A failed (${result.code})`);
  }
}

/**
 * The way back: nothing stays in the index, the work tree keeps its files. A
 * repository without a commit has no `HEAD` to reset to, so its index is emptied
 * directly — the same fallback `unstageFiles` uses for a single path.
 */
export async function unstageAll(repoPath: string): Promise<void> {
  const head = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const args =
    head.code === 0
      ? ['reset', '--quiet', 'HEAD']
      : ['rm', '--cached', '--quiet', '--ignore-unmatch', '-r', '--', '.'];
  const result = await git(repoPath, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`);
  }
}

export async function unstageFiles(repoPath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  const head = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  for (const chunk of chunkPaths(paths)) {
    const args =
      head.code === 0
        ? ['reset', '--quiet', 'HEAD', '--', ...chunk]
        : ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...chunk];
    const result = await git(repoPath, args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`);
    }
  }
}

/** Keeps a single git invocation well below the Windows command-line limit. */
function chunkPaths(paths: string[], size = 50): string[][] {
  const unique = [...new Set(paths)];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += size) {
    chunks.push(unique.slice(index, index + size));
  }
  return chunks;
}

export async function readFileFromIndex(repoPath: string, filePath: string): Promise<string | undefined> {
  const result = await git(repoPath, ['show', `:${filePath}`]);
  return result.code === 0 ? result.stdout : undefined;
}
