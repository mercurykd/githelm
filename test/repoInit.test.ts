import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readStatus } from '../src/git/status';
import { findRepoRoot, initRepository } from '../src/git/repo';
import { readLog } from '../src/git/log';

describe('initRepository', () => {
  it('creates a repository in a plain folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-init-'));
    try {
      assert.equal(await findRepoRoot(dir), undefined);
      const root = await initRepository(dir);
      assert.equal(fs.realpathSync(root), fs.realpathSync(dir));
      assert.ok(fs.existsSync(path.join(dir, '.git')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders the status of a freshly initialised repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-init-'));
    try {
      await initRepository(dir);
      // `git status` says "No commits yet on main" and `git log` exits 128;
      // both screens still have to open, which means no exception here.
      const status = await readStatus(dir);
      // The branch name depends on `init.defaultBranch` of the machine, so only
      // assert that the header parsed and there is no HEAD yet.
      assert.ok(status.branch, 'branch is reported by "No commits yet on <branch>"');
      assert.deepEqual(status.entries, []);
      assert.equal(status.head, undefined);
      const parsed = await readLog(dir);
      assert.deepEqual(parsed.commits, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
