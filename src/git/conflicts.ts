import fs from 'node:fs';
import path from 'node:path';
import { git } from './exec';

export interface ConflictRegion {
  /** 1-based line of the `<<<<<<<` marker. */
  startLine: number;
  ours: string[];
  theirs: string[];
  base: string[];
}

export type ConflictSide = 'ours' | 'theirs' | 'base';

/** Parses conflict markers (`<<<<<<<`, optional `|||||||`, `=======`, `>>>>>>>`). */
export function parseConflictRegions(content: string): ConflictRegion[] {
  const lines = content.split('\n');
  const regions: ConflictRegion[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith('<<<<<<<')) {
      index += 1;
      continue;
    }
    const startLine = index + 1;
    index += 1;

    const ours: string[] = [];
    while (index < lines.length && !lines[index].startsWith('=======') && !lines[index].startsWith('|||||||')) {
      ours.push(lines[index]);
      index += 1;
    }

    const base: string[] = [];
    if (index < lines.length && lines[index].startsWith('|||||||')) {
      index += 1;
      while (index < lines.length && !lines[index].startsWith('=======')) {
        base.push(lines[index]);
        index += 1;
      }
    }

    if (index < lines.length && lines[index].startsWith('=======')) {
      index += 1;
    }

    const theirs: string[] = [];
    while (index < lines.length && !lines[index].startsWith('>>>>>>>')) {
      theirs.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) {
      index += 1;
    }

    regions.push({ startLine, ours, theirs, base });
  }
  return regions;
}

export async function readConflict(repoPath: string, relativePath: string): Promise<ConflictRegion[]> {
  const fullPath = path.join(repoPath, relativePath);
  if (!fs.existsSync(fullPath)) {
    return [];
  }
  return parseConflictRegions(fs.readFileSync(fullPath, 'utf8'));
}

/** Writes one side of the conflict into the working tree (does not stage). */
export async function takeSide(repoPath: string, relativePath: string, side: ConflictSide): Promise<boolean> {
  const stage = side === 'ours' ? 2 : side === 'theirs' ? 3 : 1;
  const content = await git(repoPath, ['show', `:${stage}:${relativePath}`]);
  if (content.code !== 0) {
    // That side does not exist: the file was deleted there.
    await git(repoPath, ['rm', '--quiet', '--', relativePath]);
    return false;
  }
  fs.writeFileSync(path.join(repoPath, relativePath), content.stdout, 'utf8');
  return true;
}

export async function markResolved(repoPath: string, relativePath: string): Promise<void> {
  const result = await git(repoPath, ['add', '--', relativePath]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git add failed (${result.code})`);
  }
}

export async function unmergedPaths(repoPath: string): Promise<string[]> {
  const result = await git(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
