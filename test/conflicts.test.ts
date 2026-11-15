import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { markResolved, parseConflictRegions, readConflict, takeSide, unmergedPaths } from '../src/git/conflicts';
import { createLineSplitter, parseProgressLine } from '../src/git/progress';
import { selectionForBlock } from '../src/git/patch';
import { parseDiff } from '../src/git/diff';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

const CONFLICT = [
  'line before',
  '<<<<<<< HEAD',
  'ours 1',
  'ours 2',
  '=======',
  'theirs 1',
  '>>>>>>> origin/dev',
  'line after',
  '',
].join('\n');

describe('parseConflictRegions', () => {
  it('splits ours and theirs', () => {
    const regions = parseConflictRegions(CONFLICT);
    assert.equal(regions.length, 1);
    assert.deepEqual(regions[0].ours, ['ours 1', 'ours 2']);
    assert.deepEqual(regions[0].theirs, ['theirs 1']);
    assert.equal(regions[0].startLine, 2);
  });

  it('keeps the base section of a diff3 conflict', () => {
    const diff3 = ['<<<<<<< HEAD', 'ours', '||||||| base', 'base line', '=======', 'theirs', '>>>>>>> x', ''].join('\n');
    const [region] = parseConflictRegions(diff3);
    assert.deepEqual(region.base, ['base line']);
  });

  it('handles several regions and no markers', () => {
    assert.equal(parseConflictRegions(`${CONFLICT}${CONFLICT}`).length, 2);
    assert.deepEqual(parseConflictRegions('clean file\n'), []);
  });
});

describe('conflict operations', () => {
  function makeConflictedRepo(): TempRepo {
    const created = createTempRepo({ commits: [{ 'file.txt': 'base\n' }] });
    created.git('checkout', '--quiet', '-b', 'side');
    created.write('file.txt', 'theirs\n');
    created.git('add', '-A');
    created.git('commit', '--quiet', '-m', 'side');
    created.git('checkout', '--quiet', 'main');
    created.write('file.txt', 'ours\n');
    created.git('add', '-A');
    created.git('commit', '--quiet', '-m', 'main');
    try {
      created.git('merge', 'side');
    } catch {
      /* conflict expected */
    }
    return created;
  }

  it('lists conflicted files and reads the markers', async () => {
    repo = makeConflictedRepo();
    assert.deepEqual(await unmergedPaths(repo.dir), ['file.txt']);
    const regions = await readConflict(repo.dir, 'file.txt');
    assert.equal(regions.length, 1);
  });

  it('takes ours and marks the file resolved', async () => {
    repo = makeConflictedRepo();
    await takeSide(repo.dir, 'file.txt', 'ours');
    assert.equal(repo.read('file.txt'), 'ours\n');
    await markResolved(repo.dir, 'file.txt');
    assert.deepEqual(await unmergedPaths(repo.dir), []);
  });

  it('takes theirs', async () => {
    repo = makeConflictedRepo();
    await takeSide(repo.dir, 'file.txt', 'theirs');
    assert.equal(repo.read('file.txt'), 'theirs\n');
  });
});

describe('progress parsing', () => {
  it('reads percentages from git progress lines', () => {
    assert.deepEqual(parseProgressLine('Receiving objects:  45% (141/312), 1.2 MiB | 800 KiB/s'), {
      text: 'Receiving objects',
      percent: 45,
    });
    assert.equal(parseProgressLine('Resolving deltas: 100% (312/312), done.')?.percent, 100);
  });

  it('ignores noise and keeps useful text', () => {
    assert.equal(parseProgressLine('remote: Counting objects: 100% (3/3)'), undefined);
    assert.equal(parseProgressLine('From github.com:user/repo'), undefined);
    assert.equal(parseProgressLine('Updating references...')?.text, 'Updating references...');
  });

  it('splits chunks on carriage returns', () => {
    const lines: string[] = [];
    const feed = createLineSplitter((line) => lines.push(line));
    feed('Receiving objects:  10%\rReceiving objects:  20%\r');
    feed('Receiving objects:  30%\n');
    assert.deepEqual(lines, [
      'Receiving objects:  10%',
      'Receiving objects:  20%',
      'Receiving objects:  30%',
    ]);
  });
});

describe('change block selection', () => {
  const DIFF = [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1,9 +1,9 @@',
    ' context one',
    ' context two',
    ' context three',
    '-old 12',
    '+new 12',
    ' context four',
    '-old 14',
    '+new 14',
    ' context five',
    '',
  ].join('\n');

  it('selects only the run under the cursor', () => {
    const parsed = parseDiff(DIFF);
    const lines = parsed.files[0].hunks[0].lines;
    const firstAdd = lines.findIndex((line) => line.text === '+new 12');
    const secondAdd = lines.findIndex((line) => line.text === '+new 14');

    const block = selectionForBlock(parsed, 0, 0, firstAdd);
    assert.deepEqual(
      block.map((item) => lines[item.line].text),
      ['-old 12', '+new 12']
    );

    const other = selectionForBlock(parsed, 0, 0, secondAdd);
    assert.deepEqual(
      other.map((item) => lines[item.line].text),
      ['-old 14', '+new 14']
    );
  });

  it('returns nothing on a context line', () => {
    const parsed = parseDiff(DIFF);
    assert.deepEqual(selectionForBlock(parsed, 0, 0, 0), []);
  });
});
