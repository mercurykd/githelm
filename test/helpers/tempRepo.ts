import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Synchronous git runner that captures output through temp files.
 * Pipes are not always available (hardened Windows setups return EPERM), so
 * file-backed stdio is the portable choice inside tests.
 */
function runSync(cwd: string, args: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-sync-'));
  const outPath = path.join(dir, 'out');
  const errPath = path.join(dir, 'err');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  try {
    const result = spawnSync('git', args, { cwd, env, stdio: ['ignore', outFd, errFd], windowsHide: true });
    const stdout = fs.readFileSync(outPath, 'utf8');
    const stderr = fs.readFileSync(errPath, 'utf8');
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.status}): ${stderr || stdout}`);
    }
    return stdout;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface TempRepo {
  dir: string;
  git: (...args: string[]) => string;
  write: (relativePath: string, content: string) => void;
  read: (relativePath: string) => string;
  readIndex: (relativePath: string) => string;
  dispose: () => void;
}

/** Creates a throwaway git repository with a local identity. */
export function createTempRepo(options: { commits?: Array<Record<string, string>> } = {}): TempRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-test-'));
  const git = (...args: string[]): string => runSync(dir, args);

  git('init', '--quiet', '--initial-branch=main');

  const write = (relativePath: string, content: string): void => {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  const read = (relativePath: string): string => fs.readFileSync(path.join(dir, relativePath), 'utf8');
  const readIndex = (relativePath: string): string => git('show', `:${relativePath}`);

  for (const files of options.commits ?? []) {
    for (const [file, content] of Object.entries(files)) {
      write(file, content);
    }
    git('add', '-A');
    git('commit', '--quiet', '-m', 'commit');
  }

  return {
    dir,
    git,
    write,
    read,
    readIndex,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
