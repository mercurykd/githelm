import { git } from './exec';

/** Resolves the repository root for any path inside a work tree. */
export async function findRepoRoot(fromPath: string): Promise<string | undefined> {
  const result = await git(fromPath, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) {
    return undefined;
  }
  const root = result.stdout.trim();
  return root.length > 0 ? root : undefined;
}

export async function hasHeadCommit(repoPath: string): Promise<boolean> {
  const result = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return result.code === 0;
}

/** Creates a repository in a folder that has none; returns the repository root. */
export async function initRepository(folderPath: string): Promise<string> {
  const result = await git(folderPath, ['init']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git init exited ${result.code}`);
  }
  const root = await findRepoRoot(folderPath);
  return root ?? folderPath;
}

export async function currentBranch(repoPath: string): Promise<string | undefined> {
  const result = await git(repoPath, ['symbolic-ref', '--short', '--quiet', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Normalizes a repo path for display: `C:/x/y` -> `x/y`. */
export function repoDisplayName(repoPath: string): string {
  const parts = repoPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? repoPath;
}
