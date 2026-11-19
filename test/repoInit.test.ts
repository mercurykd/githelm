import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readStatus } from '../src/git/status';
import { findRepoRoot, initRepository, normalizePath } from '../src/git/repo';
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

describe('path spelling', () => {
  it('gives Windows fsPaths and git toplevels one form', () => {
    // The status buffer keys its document by this string. VS Code hands over
    // `D:\x` and git prints `D:/x`; while they differ, a refresh updates a URI
    // nobody has open and the editor keeps the text of the first render.
    assert.equal(normalizePath('D:\\domains\\githelm'), 'D:/domains/githelm');
    assert.equal(normalizePath('D:/domains/githelm'), 'D:/domains/githelm');
    assert.equal(
      encodeURIComponent(normalizePath('D:\\domains\\githelm')),
      encodeURIComponent(normalizePath('D:/domains/githelm')),
      'the URI query is built from the normalized path'
    );
  });

  it('keeps roots whole and only drops the trailing slash', () => {
    assert.equal(normalizePath('D:\\'), 'D:/');
    assert.equal(normalizePath('C:/'), 'C:/');
    assert.equal(normalizePath('/home/me/repo/'), '/home/me/repo');
    assert.equal(normalizePath('/'), '/');
  });
});
