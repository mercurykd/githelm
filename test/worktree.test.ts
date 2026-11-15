import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { currentWorktree, addWorktree, isLinkedWorktree, listWorktrees, pruneWorktrees, removeWorktree, samePath } from '../src/git/worktree';
import { createTempRepo } from './helpers/tempRepo';

/** A directory that holds worktrees created by a test, outside the repository. */
function worktreeDir(): { dir: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-wt-'));
  return {
    dir,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('worktrees', () => {
  it('lists the main worktree with its branch', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    try {
      const worktrees = await listWorktrees(repo.dir);
      assert.equal(worktrees.length, 1);
      assert.equal(worktrees[0].branch, 'main');
      assert.equal(worktrees[0].bare, false);
      assert.equal(worktrees[0].locked, false);
      assert.ok(worktrees[0].head.length > 0, 'HEAD sha is reported');
      assert.ok(samePath(worktrees[0].path, repo.dir), 'the path points at the repository');
    } finally {
      repo.dispose();
    }
  });

  it('creates a worktree with a new branch and lists it', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      const target = path.join(scratch.dir, 'feature');
      await addWorktree(repo.dir, target, 'feature-x');

      assert.ok(fs.existsSync(path.join(target, 'a.txt')), 'the branch is checked out');
      assert.ok(fs.readFileSync(path.join(target, '.git'), 'utf8').startsWith('gitdir: '), 'a linked checkout');
      const worktrees = await listWorktrees(repo.dir);
      assert.equal(worktrees.length, 2);
      assert.deepEqual(
        worktrees.map((worktree) => worktree.branch).sort(),
        ['feature-x', 'main']
      );
      assert.equal(repo.git('branch', '--list', 'feature-x').trim().length > 0, true, 'a branch was created');
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });

  it('checks out an existing branch instead of creating one', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      repo.git('branch', 'existing');
      const target = path.join(scratch.dir, 'existing-wt');
      await addWorktree(repo.dir, target, 'existing');

      const worktrees = await listWorktrees(repo.dir);
      assert.ok(worktrees.some((worktree) => worktree.branch === 'existing'));
      assert.equal(repo.git('branch', '--list', 'existing').split('\n').filter(Boolean).length, 1, 'no duplicate branch');
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });

  it('marks the worktree the repository path points at', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      const target = path.join(scratch.dir, 'second');
      await addWorktree(repo.dir, target, 'second');

      const fromMain = await listWorktrees(repo.dir);
      assert.equal(currentWorktree(fromMain, repo.dir)?.branch, 'main');
      assert.equal(currentWorktree(fromMain, target)?.branch, 'second');
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });

  it('removes a worktree and its directory', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      const target = path.join(scratch.dir, 'gone');
      await addWorktree(repo.dir, target, 'gone');
      await removeWorktree(repo.dir, target);

      assert.equal(fs.existsSync(target), false);
      const worktrees = await listWorktrees(repo.dir);
      assert.equal(worktrees.length, 1);
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });

  it('refuses a dirty worktree unless forced', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      const target = path.join(scratch.dir, 'dirty');
      await addWorktree(repo.dir, target, 'dirty');
      fs.writeFileSync(path.join(target, 'dirty.txt'), 'x', 'utf8');

      await assert.rejects(() => removeWorktree(repo.dir, target), /modified or untracked|--force/);
      assert.equal(fs.existsSync(target), true, 'the worktree survives the refusal');

      await removeWorktree(repo.dir, target, { force: true });
      assert.equal(fs.existsSync(target), false);
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });

  it('prunes entries whose directory disappeared', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      const target = path.join(scratch.dir, 'stale');
      await addWorktree(repo.dir, target, 'stale');
      assert.equal((await listWorktrees(repo.dir)).length, 2);

      fs.rmSync(target, { recursive: true, force: true });
      const removed = await pruneWorktrees(repo.dir);

      assert.equal(removed, 1);
      assert.equal((await listWorktrees(repo.dir)).length, 1);
      assert.equal(await pruneWorktrees(repo.dir), 0, 'a second prune is a no-op');
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });

  it('reports detached worktrees without a branch', async () => {    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      const target = path.join(scratch.dir, 'detached');
      repo.git('worktree', 'add', '--detach', target);

      const detached = (await listWorktrees(repo.dir)).find((worktree) => samePath(worktree.path, target));
      assert.ok(detached);
      assert.equal(detached.branch, undefined);
      assert.equal(detached.detached, true);
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });

  it('tells a linked worktree from the main checkout', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    const scratch = worktreeDir();
    try {
      assert.equal(isLinkedWorktree(repo.dir), false, 'the main checkout has a .git directory');

      const target = path.join(scratch.dir, 'linked');
      await addWorktree(repo.dir, target, 'linked');
      assert.equal(isLinkedWorktree(target), true, 'a linked worktree has a .git file');

      assert.equal(isLinkedWorktree(path.join(scratch.dir, 'nowhere')), false, 'a missing folder is not a worktree');
    } finally {
      scratch.dispose();
      repo.dispose();
    }
  });
});
