import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  cleanArgs,
  discardAllArgs,
  discardFallbackArgs,
  discardPaths,
  discardStagedArgs,
  discardWorktreeArgs,
  DiscardRequest,
} from '../src/git/ops';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

const request = (parts: Partial<DiscardRequest> = {}): DiscardRequest => ({
  staged: [],
  worktree: [],
  reset: [],
  remove: [],
  ...parts,
});

describe('discard args', () => {
  it('moves only the index back to HEAD for a staged row', () => {
    assert.deepEqual(discardStagedArgs(['a.txt']), ['restore', '--source=HEAD', '--staged', '--', 'a.txt']);
  });

  it('moves only the working tree back to the index for an unstaged row', () => {
    assert.deepEqual(discardWorktreeArgs(['a.txt']), ['restore', '--worktree', '--', 'a.txt']);
  });

  it('touches both layers for a conflict', () => {
    assert.deepEqual(discardAllArgs(['a.txt']), [
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      'a.txt',
    ]);
  });

  it('cleans untracked paths, directories included, quietly', () => {
    assert.deepEqual(cleanArgs(['notes.txt', 'tmp/']), ['clean', '-f', '-d', '-q', '--', 'notes.txt', 'tmp/']);
  });

  it('has older-git fallbacks per layer', () => {
    assert.deepEqual(discardFallbackArgs('staged', ['a.txt']), ['reset', '-q', 'HEAD', '--', 'a.txt']);
    assert.deepEqual(discardFallbackArgs('worktree', ['a.txt']), ['checkout', '--', 'a.txt']);
    assert.deepEqual(discardFallbackArgs('all', ['a.txt']), ['checkout', 'HEAD', '--', 'a.txt']);
  });
});

describe('discardPaths layers', () => {
  it('takes a modified file back to its committed content', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('a.txt', 'two\n');

    await discardPaths(repo.dir, request({ worktree: ['a.txt'] }));

    assert.equal(repo.read('a.txt'), 'one\n');
    assert.equal(repo.git('status', '--porcelain'), '');
  });

  it('keeps the working-tree edit when only the staged row is discarded', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('a.txt', 'two\n');
    repo.git('add', 'a.txt');
    repo.write('a.txt', 'three\n');

    await discardPaths(repo.dir, request({ staged: ['a.txt'] }));

    // The index is HEAD again, the working tree keeps what the user typed.
    assert.equal(repo.read('a.txt'), 'three\n');
    assert.equal(repo.git('diff', '--cached', '--name-only'), '');
    assert.equal(repo.git('status', '--porcelain').trim(), 'M a.txt');
  });

  it('keeps the staged version when only the unstaged row is discarded', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('a.txt', 'two\n');
    repo.git('add', 'a.txt');
    repo.write('a.txt', 'three\n');

    await discardPaths(repo.dir, request({ worktree: ['a.txt'] }));

    assert.equal(repo.readIndex('a.txt'), 'two\n');
    assert.equal(repo.read('a.txt'), 'two\n');
    assert.equal(repo.git('status', '--porcelain').trim(), 'M  a.txt');
  });

  it('cleans a file fully when both its rows are discarded at once', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('a.txt', 'two\n');
    repo.git('add', 'a.txt');
    repo.write('a.txt', 'three\n');

    await discardPaths(repo.dir, request({ staged: ['a.txt'], worktree: ['a.txt'] }));

    assert.equal(repo.read('a.txt'), 'one\n');
    assert.equal(repo.git('status', '--porcelain'), '');
  });

  it('restores a file deleted from the working tree', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    fs.rmSync(path.join(repo.dir, 'a.txt'));

    await discardPaths(repo.dir, request({ worktree: ['a.txt'] }));

    assert.equal(repo.read('a.txt'), 'one\n');
    assert.equal(repo.git('status', '--porcelain'), '');
  });

  it('removes a newly added file from the index and the disk', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('new.txt', 'fresh\n');
    repo.git('add', 'new.txt');

    await discardPaths(repo.dir, request({ reset: ['new.txt'], remove: ['new.txt'] }));

    assert.equal(fs.existsSync(path.join(repo.dir, 'new.txt')), false);
    assert.equal(repo.git('status', '--porcelain'), '');
  });

  it('drops an intent-to-add entry with its file', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('new.txt', 'fresh\n');
    repo.git('add', '-N', 'new.txt');

    await discardPaths(repo.dir, request({ reset: ['new.txt'], remove: ['new.txt'] }));

    assert.equal(fs.existsSync(path.join(repo.dir, 'new.txt')), false);
    assert.equal(repo.git('status', '--porcelain'), '');
  });

  it('deletes an untracked file without touching the staged deletion of it', async () => {
    // `git rm --cached` gives `D  a.txt` in the index and `?? a.txt` on disk:
    // one path, two rows, and discarding one must leave the other alone.
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.git('rm', '--cached', '-q', 'a.txt');
    assert.equal(repo.git('status', '--porcelain').trim().split('\n').sort().join('|'), '?? a.txt|D  a.txt');

    await discardPaths(repo.dir, request({ remove: ['a.txt'] }));

    assert.equal(fs.existsSync(path.join(repo.dir, 'a.txt')), false);
    assert.equal(repo.git('status', '--porcelain').trim(), 'D  a.txt');
  });

  it('restores the index without touching the untracked copy of the same file', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.git('rm', '--cached', '-q', 'a.txt');
    repo.write('a.txt', 'local edit\n');

    await discardPaths(repo.dir, request({ staged: ['a.txt'] }));

    // The index has HEAD's blob again, the file on disk is still the local one.
    assert.equal(repo.readIndex('a.txt'), 'one\n');
    assert.equal(repo.read('a.txt'), 'local edit\n');
  });

  it('deletes untracked files and leaves the tracked ones alone', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('keep.txt', 'original\n');
    repo.git('add', 'keep.txt');
    repo.git('commit', '-qm', 'keep');
    repo.write('keep.txt', 'edited\n');
    repo.write('drop.txt', 'noise\n');
    repo.write('tmp/inner.txt', 'noise\n');

    await discardPaths(repo.dir, request({ worktree: ['keep.txt'], remove: ['drop.txt', 'tmp/'] }));

    assert.equal(repo.read('keep.txt'), 'original\n');
    assert.equal(fs.existsSync(path.join(repo.dir, 'drop.txt')), false);
    assert.equal(fs.existsSync(path.join(repo.dir, 'tmp')), false);
    assert.equal(repo.git('status', '--porcelain'), '');
  });

  it('resolves a conflicted file with the committed version', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'base\n' }] });
    repo.git('checkout', '-q', '-b', 'side');
    repo.write('a.txt', 'side\n');
    repo.git('commit', '-qam', 'side');
    repo.git('checkout', '-q', 'main');
    repo.write('a.txt', 'main\n');
    repo.git('commit', '-qam', 'main');
    assert.throws(() => repo!.git('merge', 'side'), /CONFLICT|conflict/);

    await discardPaths(repo.dir, request({ reset: ['a.txt'] }));

    assert.equal(repo.read('a.txt'), 'main\n');
    assert.equal(repo.git('status', '--porcelain'), '');
  });
});
