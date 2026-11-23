import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { describeFilter, isFilterEmpty, logArgs, readLog, revisionExists } from '../src/git/log';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

function commit(repo: TempRepo, file: string, content: string, message: string): void {
  repo.write(file, content);
  repo.git('add', '-A');
  repo.git('commit', '--quiet', '-m', message);
}

describe('describeFilter', () => {
  it('renders every supported filter', () => {
    assert.equal(
      describeFilter({ grep: 'fix', author: 'ann', pickaxe: 'needle', since: '2024-01-01' }),
      '--grep="fix" --author="ann" -S "needle" --since=2024-01-01'
    );
    assert.equal(describeFilter({ pickaxeRegex: 'foo.*bar' }), '-G "foo.*bar"');
  });

  it('names the branch as a branch, not as a git flag', () => {
    assert.equal(describeFilter({ branch: 'origin/main' }), 'branch origin/main');
    assert.equal(isFilterEmpty({ branch: 'main' }), false);
  });

  it('treats an empty filter as no filter', () => {
    assert.equal(isFilterEmpty(undefined), true);
    assert.equal(isFilterEmpty({}), true);
    assert.equal(isFilterEmpty({ grep: 'x' }), false);
  });
});

describe('readLog with a filter', () => {
  it('searches commit messages with --grep', async () => {
    repo = createTempRepo();
    commit(repo, 'a.txt', 'one\n', 'add feature');
    commit(repo, 'b.txt', 'two\n', 'fix typo');

    const filtered = await readLog(repo.dir, { filter: { grep: 'feature' } });
    assert.equal(filtered.commits.length, 1);
    assert.equal(filtered.commits[0].subject, 'add feature');

    const all = await readLog(repo.dir);
    assert.equal(all.commits.length, 2);
  });

  it('searches by author', async () => {
    repo = createTempRepo();
    commit(repo, 'a.txt', 'one\n', 'normal commit');
    repo.write('b.txt', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '--author=Other Person <other@example.com>', '-m', 'guest commit');

    const mine = await readLog(repo.dir, { filter: { author: 'Other' } });
    assert.equal(mine.commits.length, 1);
    assert.equal(mine.commits[0].subject, 'guest commit');
  });

  it('finds the commit that introduced a string with -S', async () => {
    repo = createTempRepo();
    commit(repo, 'a.txt', 'alpha\n', 'first');
    commit(repo, 'a.txt', 'alpha\nneedle\n', 'add needle');
    commit(repo, 'a.txt', 'alpha\nneedle\nmore\n', 'add more');

    const found = await readLog(repo.dir, { filter: { pickaxe: 'needle' } });
    assert.equal(found.commits.length, 1);
    assert.equal(found.commits[0].subject, 'add needle');
  });

  it('matches diffs with -G regex', async () => {
    repo = createTempRepo();
    commit(repo, 'a.txt', 'alpha\n', 'first');
    commit(repo, 'a.txt', 'alpha\nvalue = 42\n', 'set value');

    const found = await readLog(repo.dir, { filter: { pickaxeRegex: 'value = [0-9]+' } });
    assert.equal(found.commits.length, 1);
    assert.equal(found.commits[0].subject, 'set value');
  });

  it('combines a filter with --all', async () => {
    repo = createTempRepo();
    commit(repo, 'a.txt', 'one\n', 'main work');
    repo.git('checkout', '--quiet', '-b', 'side');
    commit(repo, 'b.txt', 'two\n', 'side work');
    repo.git('checkout', '--quiet', 'main');

    const filtered = await readLog(repo.dir, { all: true, filter: { grep: 'side' } });
    assert.equal(filtered.commits.length, 1);
    assert.equal(filtered.commits[0].subject, 'side work');
  });

  it('walks one branch instead of every branch, the way `git log <branch>` does', async () => {
    repo = createTempRepo();
    commit(repo, 'a.txt', 'one\n', 'main work');
    repo.git('checkout', '--quiet', '-b', 'side');
    commit(repo, 'b.txt', 'two\n', 'side work');
    repo.git('checkout', '--quiet', 'main');
    commit(repo, 'c.txt', 'three\n', 'more main work');

    // `a` is on, so `--all` would be the union of every branch; the filter has to win.
    const side = await readLog(repo.dir, { all: true, filter: { branch: 'side' } });
    assert.deepEqual(
      side.commits.map((commit) => commit.subject),
      ['side work', 'main work'],
      'the branch and the history it was cut from'
    );
    const main = await readLog(repo.dir, { all: true, filter: { branch: 'main' } });
    assert.deepEqual(
      main.commits.map((commit) => commit.subject),
      ['more main work', 'main work'],
      'and no commit only the other branch has'
    );
    // A branch that does not exist is a fatal error from git, not an empty page.
    await assert.rejects(readLog(repo.dir, { filter: { branch: 'nope' } }), /git log failed/);
  });

  it('tells a branch name that resolves from one that does not', async () => {
    repo = createTempRepo();
    commit(repo, 'a.txt', 'one\n', 'main work');
    repo.git('branch', 'side');

    assert.equal(await revisionExists(repo.dir, 'main'), true);
    assert.equal(await revisionExists(repo.dir, 'side'), true);
    assert.equal(await revisionExists(repo.dir, 'HEAD'), true, 'a revision is a branch here too');
    assert.equal(await revisionExists(repo.dir, 'nope'), false);
    assert.equal(await revisionExists(repo.dir, '  '), false);
    assert.equal(await revisionExists(repo.dir, '--all'), false, 'an option is not a revision');
  });
});

describe('logArgs', () => {
  it('passes the date format (default is a full timestamp)', () => {
    assert.ok(logArgs({}).includes('--date=format:%Y-%m-%d %H:%M'));
    assert.ok(logArgs({ dateFormat: '%d.%m.%Y' }).includes('--date=format:%d.%m.%Y'));
  });

  it('adds sort flags only when asked', () => {
    assert.ok(!logArgs({}).some((arg) => arg.includes('order')));
    assert.ok(logArgs({ sort: 'date' }).includes('--date-order'));
    assert.ok(logArgs({ sort: 'author-date' }).includes('--author-date-order'));
  });

  it('passes the path filter after --', () => {
    const args = logArgs({ filter: { path: 'src/app.ts' } });
    assert.deepEqual(args.slice(-2), ['--', 'src/app.ts']);
  });

  it('combines a filter with all branches and a limit', () => {
    const args = logArgs({ all: true, limit: 5, filter: { grep: 'fix' } });
    assert.ok(args.includes('--branches'));
    assert.ok(!args.includes('--all'));
    assert.equal(args[args.indexOf('-n') + 1], '5');
    assert.ok(args.includes('--grep=fix'));
  });

  it('passes a branch filter as a revision, with no union in front of it', () => {
    const args = logArgs({ all: true, filter: { branch: 'origin/main' } });
    assert.equal(args[args.length - 1], 'origin/main', 'a revision comes after the options');
    assert.ok(!args.includes('--branches'), 'the union would put every branch back');
    assert.ok(!args.includes('--all'));
    assert.ok(!args.includes('--tags'));

    // The settings can ask for every ref; one branch is still one branch.
    const refs = logArgs({ includeAllRefs: true, filter: { branch: 'main' } });
    assert.ok(!refs.includes('--all'));
    assert.equal(refs[refs.length - 1], 'main');
  });

  it('keeps the revision before the `--` that starts the paths', () => {
    const args = logArgs({ filter: { branch: 'main', path: 'src/app.ts' } });
    assert.deepEqual(args.slice(-3), ['main', '--', 'src/app.ts']);
  });

  it('leaves a revision that looks like an option off the line', () => {
    // Typed into a filter input, `--all` would be read by git as the flag, not the name.
    assert.deepEqual(logArgs({ filter: { branch: '--all' } }), logArgs({}), 'the line is the unfiltered one');
  });

  it('lets a range be the walk when both are asked for', () => {
    const args = logArgs({ range: 'main..side', leftRight: true, filter: { branch: 'main' } });
    assert.ok(args.includes('main..side'));
    assert.ok(!args.includes('main'), 'the branch does not tip the range');
  });
});