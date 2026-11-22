import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chainIndex,
  changedFiles,
  fileChain,
  isStageRef,
  isStashRef,
  parseRevisionUri,
  readPair,
  repoChain,
  resolveCommit,
  stepChain,
} from '../src/git/diffWalk';
import type { SideUri } from '../src/git/diffWalk';
import { clearDiffs, forgetDiff, noteDiff, openedDiff, titleOfLabel } from '../src/views/diffWalkState';
import type { DiffEntry } from '../src/views/diffWalkState';
import { createTempRepo } from './helpers/tempRepo';

const revisionQuery = (path: string, ref: string): string => JSON.stringify({ path, ref });

describe('a git: revision URI read back', () => {
  it('gives the path and the ref the built-in git extension serves', () => {
    assert.deepEqual(parseRevisionUri('git', revisionQuery('C:/repo/a.ts', 'HEAD')), {
      path: 'C:/repo/a.ts',
      ref: 'HEAD',
    });
    assert.deepEqual(parseRevisionUri('git', revisionQuery('/repo/a.ts', '')), {
      path: '/repo/a.ts',
      ref: '',
    });
  });

  it('reads a path with a space and a ref that is a ref expression', () => {
    assert.deepEqual(parseRevisionUri('git', revisionQuery('C:/my repo/a b.ts', '0123abc^{}')), {
      path: 'C:/my repo/a b.ts',
      ref: '0123abc^{}',
    });
  });

  it('refuses anything that is not one', () => {
    const cases: Array<[string, string]> = [
      ['file', revisionQuery('/repo/a.ts', 'HEAD')],
      ['githelm', revisionQuery('/repo/status/x', '')],
      ['git', ''],
      ['git', 'not json'],
      ['git', '[]'],
      ['git', 'null'],
      ['git', '"text"'],
      ['git', JSON.stringify({ ref: 'HEAD' })],
      ['git', JSON.stringify({ path: '', ref: 'HEAD' })],
      ['git', JSON.stringify({ path: '/repo/a.ts' })],
      ['git', JSON.stringify({ path: '/repo/a.ts', ref: 1 })],
    ];
    for (const [scheme, query] of cases) {
      assert.equal(parseRevisionUri(scheme, query), undefined, `${scheme} ${query}`);
    }
  });

  it('tells a conflict stage from a revision', () => {
    assert.equal(isStageRef(':1'), true);
    assert.equal(isStageRef(':3'), true);
    assert.equal(isStageRef('HEAD'), false);
    assert.equal(isStageRef(''), false);
  });

  it('tells a stash from a revision', () => {
    assert.equal(isStashRef('stash@{0}'), true);
    assert.equal(isStashRef('stash@{0}^'), true);
    assert.equal(isStashRef('stash@{12}^2'), true);
    assert.equal(isStashRef('HEAD'), false);
    assert.equal(isStashRef('a1b2c3d'), false);
  });
});

describe('which diffs are a step in a history', () => {
  const git = (path: string, ref: string): SideUri => ({
    scheme: 'git',
    query: revisionQuery(path, ref),
  });
  const file = (path: string): SideUri => ({
    scheme: 'file',
    query: `file:///${path.replace(/^\/+/, '')}`,
  });

  it('reads a commit diff as the revision pair it is', () => {
    assert.deepEqual(readPair(git('C:/repo/a.ts', 'abc123'), git('C:/repo/a.ts', 'def456')), {
      kind: 'revisions',
      path: 'C:/repo/a.ts',
      left: 'abc123',
      right: 'def456',
    });
  });

  it('reads the three status shapes as the working tree', () => {
    const path = 'C:/repo/a.ts';
    // unstaged and untracked: the index against the file on disk
    for (const left of ['', 'HEAD']) {
      assert.deepEqual(readPair(git(path, left), file(path)), { kind: 'worktree', path });
    }
    // staged: HEAD against the index
    assert.deepEqual(readPair(git(path, 'HEAD'), git(path, '')), { kind: 'worktree', path });
  });

  it('leaves a conflict, a stash, two files on disk and two different files alone', () => {
    const path = 'C:/repo/a.ts';
    assert.equal(readPair(git(path, ':1'), file(path)), undefined);
    assert.equal(readPair(git(path, ':2'), git(path, ':3')), undefined);
    // A stash's two sides really are a commit and its first parent, so the refusal has to be
    // by name — otherwise the arrows would walk out of the stash into the stashed-on commit.
    assert.equal(readPair(git(path, 'stash@{0}^'), git(path, 'stash@{0}')), undefined);
    assert.equal(readPair(file(path), file(path)), undefined);
    assert.equal(readPair(git(path, 'HEAD'), git('C:/repo/b.ts', 'HEAD')), undefined);
    assert.equal(readPair({ scheme: 'githelm', query: '' }, git(path, 'HEAD')), undefined);
  });
});

describe('a walk along a chain', () => {
  const chain = ['c4', 'c3', 'c2', 'c1'];

  it('reads the chain newest first', () => {
    assert.equal(chainIndex(chain, 'c3'), 1);
    assert.equal(chainIndex(chain, 'nope'), -1);
  });

  it('steps back to the older commit and forward to the newer one', () => {
    assert.equal(stepChain(chain, 'c3', 'older'), 'c2');
    assert.equal(stepChain(chain, 'c3', 'newer'), 'c4');
  });

  it('has nothing beyond either end', () => {
    assert.equal(stepChain(chain, 'c1', 'older'), undefined);
    assert.equal(stepChain(chain, 'c4', 'newer'), undefined);
  });

  it('has nothing for a commit the chain does not hold', () => {
    assert.equal(stepChain(chain, 'elsewhere', 'older'), undefined);
    assert.equal(stepChain(chain, 'elsewhere', 'newer'), undefined);
  });
});

describe('the commit chains a diff walks', () => {
  it('follows the commits that touched the file, not the whole repository', async () => {
    const repo = createTempRepo();
    try {
      repo.write('a.txt', 'one');
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'one');
      const first = repo.git('rev-parse', 'HEAD').trim();

      repo.write('a.txt', 'two');
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'two');
      const second = repo.git('rev-parse', 'HEAD').trim();

      // A commit that does not touch a.txt: the file's own chain has to skip it.
      repo.write('b.txt', 'other');
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'other file');
      const other = repo.git('rev-parse', 'HEAD').trim();

      repo.write('a.txt', 'three');
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'three');
      const third = repo.git('rev-parse', 'HEAD').trim();

      assert.deepEqual(await fileChain(repo.dir, 'a.txt'), [third, second, first]);
      assert.deepEqual(await repoChain(repo.dir, 'HEAD'), [third, other, second, first]);

      // The point of the file's own chain: `←` from the newest change of the file lands on
      // the previous change of that file, not on a commit that never touched it.
      const chain = await fileChain(repo.dir, 'a.txt');
      assert.equal(stepChain(chain, third, 'older'), second);
      assert.equal(stepChain(chain, second, 'older'), first);
    } finally {
      repo.dispose();
    }
  });

  it('has an empty chain for a file no commit touched', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    try {
      assert.deepEqual(await fileChain(repo.dir, 'never.txt'), []);
    } finally {
      repo.dispose();
    }
  });

  it('follows first parents only, so a merged branch is not the history it walks', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'base' }] });
    try {
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.git('checkout', '--quiet', '-b', 'side');
      repo.write('side.txt', 'side');
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'side');
      repo.git('checkout', '--quiet', 'main');
      repo.write('main.txt', 'main');
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'main');
      const main = repo.git('rev-parse', 'HEAD').trim();
      repo.git('merge', '--quiet', '--no-ff', '-m', 'merge', 'side');
      const merge = repo.git('rev-parse', 'HEAD').trim();

      assert.deepEqual(await repoChain(repo.dir, 'HEAD'), [merge, main, base]);
    } finally {
      repo.dispose();
    }
  });

  it('resolves a revision to its commit and nothing else', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one' }] });
    try {
      const head = repo.git('rev-parse', 'HEAD').trim();
      assert.equal(await resolveCommit(repo.dir, 'HEAD'), head);
      assert.equal(await resolveCommit(repo.dir, 'HEAD^'), undefined, 'the root has no parent');
      assert.equal(await resolveCommit(repo.dir, 'HEAD:a.txt'), undefined, 'a blob is not a commit');
      assert.equal(await resolveCommit(repo.dir, 'no-such-ref'), undefined);
    } finally {
      repo.dispose();
    }
  });

  it('lists the files a step has to show', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one', 'b.txt': 'b' }] });
    try {
      const base = repo.git('rev-parse', 'HEAD').trim();
      repo.write('a.txt', 'two');
      repo.write('c.txt', 'new');
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'change');
      const next = repo.git('rev-parse', 'HEAD').trim();
      assert.deepEqual((await changedFiles(repo.dir, base, next)).sort(), ['a.txt', 'c.txt']);

      // A rename is two paths: the deletion and the addition, each with an empty side.
      repo.git('mv', 'b.txt', 'renamed.txt');
      repo.git('commit', '--quiet', '-m', 'rename');
      const renamed = repo.git('rev-parse', 'HEAD').trim();
      assert.deepEqual((await changedFiles(repo.dir, next, renamed)).sort(), ['b.txt', 'renamed.txt']);
    } finally {
      repo.dispose();
    }
  });
});

describe('a diff a tab is matched to', () => {
  const entry = (title: string): DiffEntry => ({ title, left: {}, right: {} } as unknown as DiffEntry);

  it('drops the "(N files)" suffix VS Code appends to a multi-diff label', () => {
    // The input names a multi-diff `"{0} ({1} files)"` from the title it was opened with,
    // and the words are localised — the shape is what can be matched, not the text.
    assert.equal(titleOfLabel('0123abcd — 3 (3 files)'), '0123abcd — 3');
    assert.equal(titleOfLabel('0123abcd — 3 (1 file)'), '0123abcd — 3');
    assert.equal(titleOfLabel('0123abcd — 3'), '0123abcd — 3');
    // A title that ends in a parenthetical of its own is left alone: the suffix always
    // starts with the file count, and a diff's own title does not.
    assert.equal(titleOfLabel('src/a.ts (staged) ↔ src/a.ts (HEAD)'), 'src/a.ts (staged) ↔ src/a.ts (HEAD)');
  });

  it('finds what a multi-diff opener recorded, by the label the tab reports', () => {
    clearDiffs();
    noteDiff('0123abcd — 2', [entry('a'), entry('b')]);
    const found = openedDiff('0123abcd — 2 (2 files)');
    assert.equal(found?.label, '0123abcd — 2');
    assert.equal(found?.entries.length, 2);
    // The undecorated title still resolves, which is what a single-file diff passes in.
    assert.equal(openedDiff('0123abcd — 2')?.label, '0123abcd — 2');
    assert.equal(openedDiff('0123abcd — 9 (2 files)'), undefined);
  });

  it('keeps the rule a step walked under, past the count of files it opened', () => {
    // A walk that started on a list of files records 'repo' with the one file it may have
    // landed on; without that a single-entry record would read as a file walk and `←` would
    // silently become that file's history.
    clearDiffs();
    noteDiff('0123abcd — 1', [entry('a')], undefined, 'repo');
    assert.equal(openedDiff('0123abcd — 1')?.kind, 'repo');
    assert.equal(openedDiff('0123abcd — 1')?.entries.length, 1);
    // A screen that opened a diff without walking it records no rule, so the count decides.
    noteDiff('1234abcd — 1', [entry('a')]);
    assert.equal(openedDiff('1234abcd — 1')?.kind, undefined);
  });

  it('forgets a record through the decorated label as well as the exact one', () => {
    clearDiffs();
    noteDiff('0123abcd — 2', [entry('a')]);
    forgetDiff('0123abcd — 2 (1 file)');
    assert.equal(openedDiff('0123abcd — 2'), undefined);
  });
});
