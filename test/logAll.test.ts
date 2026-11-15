import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { logArgs, readLog } from '../src/git/log';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('--all does not mean "every ref"', () => {
  it('asks for branches, tags and remotes instead of --all', () => {
    const args = logArgs({ all: true });
    assert.ok(!args.includes('--all'), 'stash lives in refs/stash, --all would include it');
    assert.ok(args.includes('--branches'));
    assert.ok(args.includes('--tags'));
    assert.ok(args.includes('--remotes'));
  });

  it('keeps stash commits out of the history buffer', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('a.txt', 'dirty\n');
    repo.git('stash', 'push', '-m', 'wip checkpoint');

    // Sanity check: the stash really is visible through the plain --all.
    const viaAll = repo.git('log', '--all', '--format=%s');
    assert.ok(viaAll.includes('wip checkpoint'), 'git itself shows the stash with --all');

    const log = await readLog(repo.dir, { all: true });
    const subjects = log.commits.map((commit) => commit.subject);
    assert.equal(subjects.length, 1);
    assert.ok(!subjects.some((subject) => subject.includes('wip checkpoint')), 'stash is filtered out');
  });

  it('still shows commits from other branches', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.git('checkout', '--quiet', '-b', 'side');
    repo.write('b.txt', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'side work');
    repo.git('checkout', '--quiet', 'main');

    const log = await readLog(repo.dir, { all: true });
    assert.ok(log.commits.some((commit) => commit.subject === 'side work'));
  });
});

describe('includeAllRefs', () => {
  it('adds --all only when explicitly requested', () => {
    assert.ok(logArgs({ includeAllRefs: true }).includes('--all'));
    assert.ok(!logArgs({}).includes('--all'));
  });
});