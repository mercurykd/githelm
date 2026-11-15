import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { RebaseAbortedError, runInteractiveRebase, startEditorBridge } from '../src/rebase/bridge';
import { runProcess } from '../src/util/process';
import { probeGitShell } from './helpers/gitShell';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

const shimsDir = path.resolve(process.cwd(), 'media', 'shims');

let repo: TempRepo | undefined;
let cleanupDirs: string[] = [];

afterEach(() => {
  repo?.dispose();
  repo = undefined;
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];
});

function tempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-shim-'));
  cleanupDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * `git rebase -i` needs git's own POSIX shell for the editor shim. Hardened
 * environments (CI sandboxes, some EDR setups) refuse to create the signal
 * pipes that shell needs, so the git-level tests are skipped there; the shim
 * contract itself is still covered below without git.
 */
const shellProbe = probeGitShell();
const shSkip = shellProbe.ok
  ? false
  : `git не может выполнить shell-команду (probe exit ${shellProbe.status}) — GIT_SEQUENCE_EDITOR недоступен`;

describe('editor shim contract', () => {
  it('hands file content to the extension and writes the edited text back', async () => {
    const file = tempFile('git-rebase-todo', 'pick aaa one\npick bbb two\n');
    const session = await startEditorBridge({
      shimsDir,
      onEdit: async (request) => {
        assert.equal(request.content, 'pick aaa one\npick bbb two\n');
        return request.content.replace('pick bbb', 'squash bbb');
      },
    });

    try {
      const result = await runProcess(process.execPath, [path.join(shimsDir, 'git-editor-main.js'), file], {
        env: { ...process.env, ...session.env },
        timeoutMs: 30_000,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(fs.readFileSync(file, 'utf8'), 'pick aaa one\nsquash bbb two\n');
      assert.equal(session.aborted(), false);
    } finally {
      session.dispose();
    }
  });

  it('fails the shim and flags abort when the user cancels', async () => {
    const file = tempFile('COMMIT_EDITMSG', 'original message\n');
    const session = await startEditorBridge({ shimsDir, onEdit: async () => undefined });

    try {
      const result = await runProcess(process.execPath, [path.join(shimsDir, 'git-editor-main.js'), file], {
        env: { ...process.env, ...session.env },
        timeoutMs: 30_000,
      });
      assert.notEqual(result.code, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), 'original message\n');
      assert.equal(session.aborted(), true);
    } finally {
      session.dispose();
    }
  });

  it('rejects requests with a wrong token', async () => {
    const file = tempFile('todo', 'pick aaa one\n');
    const session = await startEditorBridge({ shimsDir, onEdit: async () => 'hijacked\n' });

    try {
      const result = await runProcess(process.execPath, [path.join(shimsDir, 'git-editor-main.js'), file], {
        env: { ...process.env, ...session.env, GITHELM_TOKEN: 'wrong-token' },
        timeoutMs: 30_000,
      });
      assert.notEqual(result.code, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), 'pick aaa one\n');
    } finally {
      session.dispose();
    }
  });
});

describe('GIT_SEQUENCE_EDITOR through real git', () => {
  it('squashes a commit through the editor shim', { skip: shSkip, timeout: 60_000 }, async () => {
    repo = createTempRepo({
      commits: [{ 'a.txt': '1\n' }, { 'b.txt': '2\n' }, { 'c.txt': '3\n' }],
    });
    const repoPath = repo.dir;
    assert.equal(repo.git('log', '--format=%s').trim().split('\n').length, 3);

    const editedFiles: string[] = [];
    const result = await runInteractiveRebase({
      repoPath,
      base: 'HEAD~2',
      shimsDir,
      onEdit: async (request) => {
        const name = path.basename(request.path);
        editedFiles.push(name);
        if (name.includes('git-rebase-todo')) {
          let pickCount = 0;
          return request.content
            .split('\n')
            .map((line) => {
              if (!line.startsWith('pick ')) {
                return line;
              }
              pickCount += 1;
              return pickCount === 2 ? line.replace(/^pick/, 'squash') : line;
            })
            .join('\n');
        }
        return 'squashed message\n';
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.ok(editedFiles.some((name) => name.includes('git-rebase-todo')));

    const log = repo.git('log', '--format=%s').trim().split('\n');
    assert.equal(log.length, 2);
    assert.equal(log[0], 'squashed message');
  });

  it('aborts the rebase when the user cancels the editor', { skip: shSkip, timeout: 60_000 }, async () => {
    repo = createTempRepo({
      commits: [{ 'a.txt': '1\n' }, { 'b.txt': '2\n' }, { 'c.txt': '3\n' }],
    });
    const repoPath = repo.dir;

    await assert.rejects(
      runInteractiveRebase({ repoPath, base: 'HEAD~2', shimsDir, onEdit: async () => undefined }),
      RebaseAbortedError
    );

    assert.equal(repo.git('log', '--format=%s').trim().split('\n').length, 3);
    assert.equal(repo.git('status', '--porcelain').trim(), '');
  });
});
