import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './exec';

/** `git diff --cached --quiet` exits 1 when the index differs from HEAD. */
export async function hasStagedChanges(repoPath: string): Promise<boolean> {
  const result = await git(repoPath, ['diff', '--cached', '--quiet']);
  return result.code === 1;
}

/** Full message (subject + body) of HEAD, trimmed. */
export async function headMessage(repoPath: string): Promise<string | undefined> {
  const result = await git(repoPath, ['log', '-1', '--format=%B']);
  if (result.code !== 0) {
    return undefined;
  }
  return result.stdout.replace(/\s+$/, '');
}

export async function parentOf(repoPath: string, sha: string): Promise<string> {
  const result = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^`]);
  if (result.code !== 0) {
    throw new Error(`У коммита ${sha.slice(0, 7)} нет родителя: автосквош корневого коммита не поддерживается.`);
  }
  return result.stdout.trim();
}

/** Commits whatever is staged as `fixup! <subject>` and returns the new HEAD. */
export async function createFixupCommit(repoPath: string, sha: string): Promise<string> {
  const result = await git(repoPath, ['commit', '--fixup', sha]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git commit --fixup failed (${result.code})`);
  }
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    throw new Error('Не удалось прочитать HEAD после создания fixup-коммита.');
  }
  return head.stdout.trim();
}

/** `git commit --amend` with a message from a temp file (no editor involved). */
export async function amendCommit(repoPath: string, message: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `githelm-amend-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, message.endsWith('\n') ? message : `${message}\n`, 'utf8');
  try {
    const result = await git(repoPath, ['commit', '--amend', '-F', tmp]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git commit --amend failed (${result.code})`);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
