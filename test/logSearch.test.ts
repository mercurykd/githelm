import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { describeFilter, isFilterEmpty, logArgs, readLog } from '../src/git/log';
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
});