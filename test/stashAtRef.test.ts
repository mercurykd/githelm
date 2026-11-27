import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { stashRefsForFiles } from '../src/git/stash';
import { createTempRepo } from './helpers/tempRepo';

/**
 * `t` on a stash's file list has to know where each file's content lives: a tracked file
 * is in the stash commit, a file stashed with `-u` in the stash's third parent, and a
 * file the stash deleted nowhere. One `ls-tree` per tree answers all of them at once.
 */
describe('stashRefsForFiles', () => {
  it('finds tracked, untracked and deleted files at their own revisions', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'base\n', 'gone.txt': 'gone\n' }] });
    try {
      repo.write('a.txt', 'changed\n');
      fs.rmSync(path.join(repo.dir, 'gone.txt'));
      repo.write('u.txt', 'untracked\n');
      repo.git('stash', 'push', '--include-untracked', '-m', 'probe');

      const refs = await stashRefsForFiles(repo.dir, 'stash@{0}', ['a.txt', 'u.txt', 'gone.txt', 'missing.txt']);
      assert.equal(refs.get('a.txt'), 'stash@{0}', 'a tracked change lives in the stash commit');
      assert.equal(refs.get('u.txt'), 'stash@{0}^3', 'an untracked file lives in the third parent');
      assert.equal(refs.has('gone.txt'), false, 'a deleted file has no content at the stash');
      assert.equal(refs.has('missing.txt'), false, 'a name the stash never had is left out');
    } finally {
      repo.dispose();
    }
  });
});
