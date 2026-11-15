import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './exec';

/**
 * Git LFS keeps big blobs on its own server and commits a small text file
 * instead — a pointer. The spec line is the only reliable marker, so prose that
 * merely mentions git-lfs is never mistaken for a pointer.
 */
const SPEC_LINE = 'version https://git-lfs.github.com/spec/v1';
const OID_RE = /^oid sha256:([0-9a-f]{64})$/;
const SIZE_RE = /^size (\d+)$/;

export interface LfsPointer {
  oid: string;
  size: number;
}

export interface LfsFile {
  /** Path relative to the repository root. */
  path: string;
  /** Oid as `git lfs ls-files` abbreviates it. */
  oid: string;
}

/** Parses a pointer file, or returns undefined for anything else. */
export function parseLfsPointer(text: string): LfsPointer | undefined {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.length < 3 || lines[0].trimEnd() !== SPEC_LINE) {
    return undefined;
  }
  const oid = OID_RE.exec(lines[1]);
  const size = SIZE_RE.exec(lines[2]);
  if (!oid || !size) {
    return undefined;
  }
  return { oid: oid[1], size: Number(size[1]) };
}

export function isLfsPointer(text: string): boolean {
  return parseLfsPointer(text) !== undefined;
}

/**
 * True when a diff carries a pointer instead of content — the blobs live on the
 * LFS server, so `git diff` can only show oid and size.
 */
export function diffHasLfsPointer(diffText: string): boolean {
  return diffText.split('\n').some((line) => {
    // A unified diff marks every line with one character: ` ` context, `+` added,
    // `-` removed. The spec line is usually context, so all three are stripped.
    const body = /^[ +\-]/.test(line) ? line.slice(1) : line;
    return body.trimEnd() === SPEC_LINE;
  });
}

/**
 * Files tracked by LFS. `git lfs ls-files` prints `<oid> <marker> <path>`, and
 * the path may contain spaces, so only the first two fields are split off.
 * Without git-lfs installed the command fails and the repo simply has no LFS
 * files to report — that is a normal state, not an error.
 */
export async function listLfsFiles(repoPath: string): Promise<LfsFile[]> {
  const result = await git(repoPath, ['lfs', 'ls-files']);
  if (result.code !== 0) {
    return [];
  }
  const files: LfsFile[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^([0-9a-f]{7,64})\s+[*-]\s+(.+?)\s*$/.exec(line);
    if (match) {
      files.push({ oid: match[1], path: match[2] });
    }
  }
  return files;
}

/** Reads a working-tree file and returns its pointer, or undefined. */
export async function readLfsPointer(repoPath: string, relPath: string): Promise<LfsPointer | undefined> {
  try {
    return parseLfsPointer(await fs.readFile(path.join(repoPath, relPath), 'utf8'));
  } catch {
    return undefined;
  }
}
