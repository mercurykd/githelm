import { git } from './exec';

export type CompareMode = 'two' | 'three';

/** `A..B` (two dots) or `A...B` (three dots, from the merge base). */
export function compareRange(a: string, b: string, mode: CompareMode): string {
  return `${a}${mode === 'three' ? '...' : '..'}${b}`;
}

export async function compareDiff(repoPath: string, a: string, b: string, mode: CompareMode): Promise<string> {
  const range = compareRange(a, b, mode);
  const result = await git(repoPath, ['diff', '--no-color', '--no-ext-diff', range]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git diff ${range} failed (${result.code})`);
  }
  return result.stdout.length > 0 ? result.stdout : `(empty: ${range})\n`;
}

export async function headSha(repoPath: string): Promise<string> {
  const result = await git(repoPath, ['rev-parse', 'HEAD']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git rev-parse HEAD failed');
  }
  return result.stdout.trim();
}
