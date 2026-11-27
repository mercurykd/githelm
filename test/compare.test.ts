import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  choiceMode,
  choiceShowsDiff,
  choiceSwaps,
  compareChoices,
  compareChanges,
  compareFiles,
  compareRange,
  headSha,
  mergeBase,
  planCompare,
  refTip,
} from '../src/git/compare';
import { logArgs, parseLog } from '../src/git/log';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('compareRange', () => {
  it('builds two-dot and three-dot ranges', () => {
    assert.equal(compareRange('aaa', 'bbb', 'two'), 'aaa..bbb');
    assert.equal(compareRange('aaa', 'bbb', 'three'), 'aaa...bbb');
  });

  it('swaps sides by swapping arguments', () => {
    assert.equal(compareRange('bbb', 'aaa', 'two'), 'bbb..aaa');
  });
});

describe('logArgs with a range', () => {
  it('passes the range instead of --all', () => {
    const args = logArgs({ range: 'a..b' });
    assert.ok(args.includes('a..b'));
    assert.ok(!args.includes('--all'));
  });

  it('adds --left-right for three-dot ranges', () => {
    assert.ok(logArgs({ range: 'a...b', leftRight: true }).includes('--left-right'));
    assert.ok(!logArgs({ range: 'a...b' }).includes('--left-right'));
  });
});

describe('parseLog left/right markers', () => {
  it('detects < and > markers before the graph', () => {
    const SEP = '\x1f';
    const line = (prefix: string, sha: string) => `${prefix}${SEP}${sha}${SEP}${sha.slice(0, 7)}${SEP}${SEP}A${SEP}2026-01-01 10:00${SEP}s${SEP}`;
    const parsed = parseLog([line('< * ', 'a'.repeat(40)), line('> * ', 'b'.repeat(40)), ''].join('\n'));

    assert.equal(parsed.commits[0].side, '<');
    assert.equal(parsed.commits[1].side, '>');
  });

  it('leaves side undefined without markers', () => {
    const SEP = '\x1f';
    const line = `* ${SEP}${'c'.repeat(40)}${SEP}ccccccc${SEP}${SEP}A${SEP}2026-01-01 10:00${SEP}s${SEP}`;
    assert.equal(parseLog(line).commits[0].side, undefined);
  });
});

describe('headSha', () => {
  it('returns the current HEAD', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    assert.equal(await headSha(repo.dir), repo.git('rev-parse', 'HEAD').trim());
  });
});

describe('compareChoices', () => {
  it('offers the six choices in the buffer’s order, each with a label', () => {
    const choices = compareChoices();
    assert.deepEqual(
      choices.map((choice) => choice.value),
      ['diff-two', 'diff-three', 'diff-swapped', 'log-two', 'log-three', 'log-swapped']
    );
    for (const choice of choices) {
      assert.ok(choice.label.trim().length > 0, `${choice.value} is worded`);
    }
  });

  it('reads the choice into the view, the mode and the sides', () => {
    assert.equal(choiceShowsDiff('diff-three'), true);
    assert.equal(choiceShowsDiff('log-three'), false);
    assert.equal(choiceMode('log-three'), 'three');
    assert.equal(choiceMode('diff-two'), 'two');
    assert.equal(choiceSwaps('diff-swapped'), true);
    assert.equal(choiceSwaps('log-swapped'), true);
    assert.equal(choiceSwaps('log-two'), false);
  });

  it('word the diff and the log of a range differently, as the buffer does', () => {
    const [diff, , , log] = compareChoices();
    assert.match(diff.label, /diff/);
    assert.match(log.label, /log/);
  });
});

describe('compareFiles', () => {
  it('lists the paths that differ across the range', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n', 'b.txt': 'new\n' }] });
    const head = await headSha(repo.dir);
    const parent = repo.git('rev-parse', 'HEAD~1').trim();
    assert.deepEqual((await compareFiles(repo.dir, compareRange(parent, head, 'two'))).sort(), ['a.txt', 'b.txt']);
  });

  it('lists nothing when the range changes no file', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const head = await headSha(repo.dir);
    assert.deepEqual(await compareFiles(repo.dir, compareRange(head, head, 'two')), []);
    assert.deepEqual(await compareFiles(repo.dir, compareRange(head, head, 'three')), []);
  });

  it('keeps a path with a space in it one entry', async () => {
    repo = createTempRepo({ commits: [{ 'a b.txt': 'one\n' }, { 'a b.txt': 'two\n' }] });
    const head = await headSha(repo.dir);
    const parent = repo.git('rev-parse', 'HEAD~1').trim();
    assert.deepEqual(await compareFiles(repo.dir, compareRange(parent, head, 'two')), ['a b.txt']);
  });
});

describe('compareChanges', () => {
  it('carries the status letter and the new path a rename lands on', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n', 'b.txt': 'new\n' }] });
    const head = await headSha(repo.dir);
    const parent = repo.git('rev-parse', 'HEAD~1').trim();
    const changes = await compareChanges(repo.dir, compareRange(parent, head, 'two'));
    assert.deepEqual(
      changes.map((change) => [change.status, change.path]).sort(),
      [
        ['A', 'b.txt'],
        ['M', 'a.txt'],
      ]
    );
    assert.deepEqual(await compareChanges(repo.dir, compareRange(head, head, 'two')), []);
  });
});

describe('mergeBase', () => {
  it('finds the commit a three-dot range starts at', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' }] });
    const head = await headSha(repo.dir);
    const parent = repo.git('rev-parse', 'HEAD~1').trim();
    assert.equal(await mergeBase(repo.dir, parent, head), parent);
  });

  it('returns undefined for a commit that is not there', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const head = await headSha(repo.dir);
    assert.equal(await mergeBase(repo.dir, '0'.repeat(40), head), undefined);
    assert.equal(await mergeBase(repo.dir, '--upload-pack=calc', head), undefined);
  });
});

describe('planCompare', () => {
  /** Two diverging lines: `main` has one file, `side` adds another on top of a shared base. */
  const diverged = (): TempRepo => {
    const made = createTempRepo({ commits: [{ 'a.txt': 'base\n' }] });
    made.git('checkout', '--quiet', '-b', 'side');
    made.write('b.txt', 'side\n');
    made.git('add', '-A');
    made.git('commit', '--quiet', '-m', 'side');
    made.git('checkout', '--quiet', 'main');
    return made;
  };

  it('names the range the reader picked and swaps it when the choice swaps', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' }] });
    const head = await headSha(repo.dir);
    const parent = repo.git('rev-parse', 'HEAD~1').trim();
    const two = await planCompare(repo.dir, 'diff-two', parent, head, 'aaa', 'bbb');
    assert.equal(two.label, 'aaa..bbb');
    assert.equal(two.range, `${parent}..${head}`);
    assert.equal(two.from, parent);
    assert.equal(two.to, head);
    assert.equal(two.diffLeft, parent, 'a two-dot diff starts at the left side itself');
    assert.equal(two.diffRight, head);
    const three = await planCompare(repo.dir, 'log-three', parent, head, 'aaa', 'bbb');
    assert.equal(three.label, 'aaa...bbb');
    assert.equal(three.range, `${parent}...${head}`);
    assert.equal(three.mode, 'three');
    assert.equal(three.diffLeft, parent, 'the merge base of a linear range is its first commit');
    // A swapped choice swaps *everything*, including which side of the diff is which.
    const swapped = await planCompare(repo.dir, 'diff-swapped', parent, head, 'aaa', 'bbb');
    assert.equal(swapped.label, 'bbb..aaa');
    assert.equal(swapped.range, `${head}..${parent}`);
    assert.equal(swapped.diffLeft, head);
    assert.equal(swapped.diffRight, parent);
  });

  it('diffs a three-dot range from the merge base, not from the branch point', async () => {
    repo = diverged();
    const head = await headSha(repo.dir);
    const side = repo.git('rev-parse', 'side').trim();
    const base = repo.git('rev-parse', 'main').trim();
    const plan = await planCompare(repo.dir, 'diff-three', side, head, 'side', 'main');
    assert.equal(plan.range, `${side}...${head}`);
    assert.equal(plan.diffLeft, base, 'the left side of `A...B` is what the two have in common');
    assert.equal(plan.diffRight, head);
  });
});

describe('refTip', () => {
  it('reads the commit a branch names, and follows one that moved', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const first = await headSha(repo.dir);
    assert.equal(await refTip(repo.dir, 'main'), first);
    repo.git('commit', '--quiet', '--allow-empty', '-m', 'second');
    assert.equal(await refTip(repo.dir, 'main'), await headSha(repo.dir), 'a tip is read when it is asked for');
  });

  it('answers nothing for a ref that is not there, or that looks like an option', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    assert.equal(await refTip(repo.dir, 'no-such-branch'), undefined);
    assert.equal(await refTip(repo.dir, '--upload-pack=calc'), undefined);
    assert.equal(await refTip(repo.dir, ''), undefined);
  });
});

