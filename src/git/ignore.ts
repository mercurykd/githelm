import fs from 'node:fs';
import path from 'node:path';
import { git } from './exec';

export interface IgnoreResult {
  /** Paths written to `.gitignore`. */
  added: string[];
  /** Paths already listed in `.gitignore`. */
  present: string[];
  /** Paths git already tracks: `.gitignore` cannot hide those. */
  tracked: string[];
}

/** Repository-relative paths git already knows about. */
async function trackedPaths(repoPath: string, relativePaths: string[]): Promise<Set<string>> {
  if (relativePaths.length === 0) {
    return new Set();
  }
  const result = await git(repoPath, ['ls-files', '-z', '--', ...relativePaths]);
  if (result.code !== 0) {
    return new Set();
  }
  return new Set(result.stdout.split('\0').filter(Boolean));
}

function toPattern(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/**
 * Appends paths to the repository's root `.gitignore`, one per line.
 * Tracked files are reported instead of written: ignoring them changes nothing
 * until they are removed from the index with `git rm --cached`.
 */
export async function addToGitignore(repoPath: string, relativePaths: string[]): Promise<IgnoreResult> {
  const patterns = [...new Set(relativePaths.map(toPattern).filter(Boolean))];
  const tracked = await trackedPaths(repoPath, patterns);
  const file = path.join(repoPath, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const listed = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );

  const added: string[] = [];
  const present: string[] = [];
  const trackedPatterns: string[] = [];
  for (const pattern of patterns) {
    if (tracked.has(pattern)) {
      trackedPatterns.push(pattern);
      continue;
    }
    if (listed.has(pattern)) {
      present.push(pattern);
      continue;
    }
    listed.add(pattern);
    added.push(pattern);
  }

  if (added.length > 0) {
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const separator = existing.length > 0 && !existing.endsWith('\n') ? eol : '';
    fs.writeFileSync(file, `${existing}${separator}${added.join(eol)}${eol}`, 'utf8');
  }

  return { added, present, tracked: trackedPatterns };
}
