import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { checkoutBranch, createBranch, listBranches, showCommit } from '../src/git/actions';
import { readLog } from '../src/git/log';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('branch actions', () => {
  it('checks out an existing branch', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': '1\n' }] });
    repo.git('branch', 'feature');

    await checkoutBranch(repo.dir, 'feature');
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
  });

  it('creates a branch at a given commit and switches to it', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': '1\n' }, { 'b.txt': '2\n' }] });
    const firstCommit = repo.git('rev-parse', 'HEAD~1').trim();

    await createBranch(repo.dir, 'from-first', firstCommit);
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'from-first');
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), firstCommit);
  });

  it('surfaces the git error for an unknown branch', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': '1\n' }] });
    await assert.rejects(checkoutBranch(repo.dir, 'does-not-exist'), /does-not-exist/);
  });

  it('lists local branches alphabetically', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': '1\n' }] });
    repo.git('branch', 'zeta');
    repo.git('branch', 'alpha');
    assert.deepEqual(await listBranches(repo.dir), ['alpha', 'main', 'zeta']);
  });
});

describe('commit view', () => {
  it('renders metadata, stat and patch', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' }] });
    const sha = repo.git('rev-parse', 'HEAD').trim();

    const text = await showCommit(repo.dir, sha);
    assert.ok(text.startsWith(`commit ${sha}`));
    assert.ok(text.includes('diff --git a/a.txt b/a.txt'));
    assert.ok(text.includes('+two'));
  });

  it('truncates very large commits', async () => {
    repo = createTempRepo({ commits: [{ 'big.txt': '' }] });
    const content = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
    repo.write('big.txt', `${content}\n`);
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'big change');
    const sha = repo.git('rev-parse', 'HEAD').trim();

    const text = await showCommit(repo.dir, sha, 50);
    assert.ok(text.includes('обрезано'));
  });
});

describe('readLog against a real repository', () => {
  it('shows only the current branch by default and everything with --all', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': '1\n' }] });
    repo.git('checkout', '--quiet', '-b', 'side');
    repo.write('b.txt', '2\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'side commit');
    repo.git('checkout', '--quiet', 'main');

    const current = await readLog(repo.dir);
    assert.equal(current.commits.length, 1);
    assert.ok(current.entries[0].graphPrefix.includes('*'));

    const all = await readLog(repo.dir, { all: true });
    assert.equal(all.commits.length, 2);
    assert.ok(all.commits.some((commit) => commit.subject === 'side commit'));
  });

  it('limits the number of commits', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': '1\n' }, { 'b.txt': '2\n' }, { 'c.txt': '3\n' }] });
    const log = await readLog(repo.dir, { limit: 2 });
    assert.equal(log.commits.length, 2);
  });
});
