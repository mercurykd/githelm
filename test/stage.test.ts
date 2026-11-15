import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { diffArgs, parseDiff } from '../src/git/diff';
import { git } from '../src/git/exec';
import { buildPatch } from '../src/git/patch';
import { addIntentToAdd, applyPatchToIndex, stageFile, stageFiles, unstageFile, unstageFiles } from '../src/git/stage';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

async function diffOf(repoPath: string, mode: 'staged' | 'unstaged'): Promise<string> {
  const result = await git(repoPath, diffArgs(mode));
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

describe('line-level staging against a real repository', () => {
  it('stages a single added line and leaves the rest in the working tree', async () => {
    repo = createTempRepo({ commits: [{ 'file.txt': 'a\nb\nc\n' }] });
    const repoPath = repo.dir;
    repo.write('file.txt', 'a\nB\nc\nd\n');

    const unstaged = await diffOf(repoPath, 'unstaged');
    const parsed = parseDiff(unstaged);
    const hunk = parsed.files[0].hunks[0];
    const addedIndex = hunk.lines.findIndex((line) => line.text === '+d');
    assert.ok(addedIndex >= 0);

    await applyPatchToIndex(repoPath, buildPatch(parsed, [{ file: 0, hunk: 0, line: addedIndex }]));

    // The index gained only `d`; the `b -> B` edit and the working tree are untouched.
    assert.equal(repo.readIndex('file.txt'), 'a\nb\nc\nd\n');
    assert.equal(repo.read('file.txt'), 'a\nB\nc\nd\n');

    const staged = await diffOf(repoPath, 'staged');
    assert.ok(staged.includes('+d'));
    assert.ok(!staged.includes('+B'));
  });

  it('unstages a staged line by applying the reverse patch', async () => {
    repo = createTempRepo({ commits: [{ 'file.txt': 'a\nb\nc\n' }] });
    const repoPath = repo.dir;
    repo.write('file.txt', 'a\nB\nc\nd\n');

    const unstaged = await diffOf(repoPath, 'unstaged');
    const parsed = parseDiff(unstaged);
    const addedIndex = parsed.files[0].hunks[0].lines.findIndex((line) => line.text === '+d');
    await applyPatchToIndex(repoPath, buildPatch(parsed, [{ file: 0, hunk: 0, line: addedIndex }]));
    assert.equal(repo.readIndex('file.txt'), 'a\nb\nc\nd\n');

    const stagedParsed = parseDiff(await diffOf(repoPath, 'staged'));
    const stagedAdded = stagedParsed.files[0].hunks[0].lines.findIndex((line) => line.text === '+d');
    await applyPatchToIndex(repoPath, buildPatch(stagedParsed, [{ file: 0, hunk: 0, line: stagedAdded }]), {
      reverse: true,
    });

    assert.equal(repo.readIndex('file.txt'), 'a\nb\nc\n');
    assert.equal(repo.read('file.txt'), 'a\nB\nc\nd\n');
  });

  it('stages a new file partially after intent-to-add', async () => {
    repo = createTempRepo({ commits: [{ 'keep.txt': 'x\n' }] });
    const repoPath = repo.dir;
    repo.write('lines.txt', 'one\ntwo\nthree\n');
    await addIntentToAdd(repoPath, 'lines.txt');

    const parsed = parseDiff(await diffOf(repoPath, 'unstaged'));
    const fileIndex = parsed.files.findIndex((candidate) => candidate.path === 'lines.txt');
    assert.ok(fileIndex >= 0);
    const hunk = parsed.files[fileIndex].hunks[0];
    const firstAdded = hunk.lines.findIndex((line) => line.text === '+one');

    await applyPatchToIndex(repoPath, buildPatch(parsed, [{ file: fileIndex, hunk: 0, line: firstAdded }]));
    assert.equal(repo.readIndex('lines.txt'), 'one\n');
    assert.equal(repo.read('lines.txt'), 'one\ntwo\nthree\n');
  });

  it('rejects a patch that does not apply instead of corrupting the index', async () => {
    repo = createTempRepo({ commits: [{ 'file.txt': 'a\nb\nc\n' }] });
    const repoPath = repo.dir;
    repo.write('file.txt', 'z\n');
    const bogus = [
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+q',
      '',
    ].join('\n');
    await assert.rejects(applyPatchToIndex(repoPath, bogus), /apply/);
    assert.equal(repo.readIndex('file.txt'), 'a\nb\nc\n');
  });
});

describe('whole-file staging helpers', () => {
  it('stages and unstages a file', async () => {
    repo = createTempRepo({ commits: [{ 'keep.txt': 'x\n' }] });
    const repoPath = repo.dir;
    repo.write('new.txt', 'hello\n');

    await stageFile(repoPath, 'new.txt');
    assert.equal(repo.readIndex('new.txt'), 'hello\n');

    await unstageFile(repoPath, 'new.txt');
    const staged = await diffOf(repoPath, 'staged');
    assert.ok(!staged.includes('new.txt'));
  });

  it('unstages in a repository without any commits', async () => {
    repo = createTempRepo();
    const repoPath = repo.dir;
    repo.write('first.txt', 'hello\n');

    await stageFile(repoPath, 'first.txt');
    assert.equal(repo.readIndex('first.txt'), 'hello\n');

    await unstageFile(repoPath, 'first.txt');
    assert.throws(() => repo!.readIndex('first.txt'));
  });
});

describe('bulk staging', () => {
  it('stages and unstages several files in one call', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'a\n' }, { 'b.txt': 'b\n' }] });
    const repoPath = repo.dir;
    repo.write('a.txt', 'a2\n');
    repo.write('b.txt', 'b2\n');

    await stageFiles(repoPath, ['a.txt', 'b.txt']);
    assert.equal(repo.readIndex('a.txt'), 'a2\n');
    assert.equal(repo.readIndex('b.txt'), 'b2\n');

    await unstageFiles(repoPath, ['a.txt', 'b.txt']);
    assert.equal(repo.readIndex('a.txt'), 'a\n');
    assert.equal(repo.readIndex('b.txt'), 'b\n');
  });

  it('deduplicates paths and tolerates an empty list', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'a\n' }] });
    const repoPath = repo.dir;
    repo.write('a.txt', 'a2\n');

    await stageFiles(repoPath, ['a.txt', 'a.txt']);
    assert.equal(repo.readIndex('a.txt'), 'a2\n');

    await stageFiles(repoPath, []);
    await unstageFiles(repoPath, []);
  });

  it('stages a whole directory worth of files', async () => {
    repo = createTempRepo({ commits: [{ 'keep.txt': 'k\n' }] });
    const repoPath = repo.dir;
    const paths = Array.from({ length: 12 }, (_, index) => `dir/file-${index}.txt`);
    for (const file of paths) {
      repo.write(file, `${file}\n`);
    }

    await stageFiles(repoPath, paths);
    assert.equal(repo.git('diff', '--cached', '--name-only').trim().split('\n').length, 12);
  });
});

describe('stash quick peek', () => {
  it('lists the files touched by a stash and their diffs', async () => {
    const { createTempRepo } = await import('./helpers/tempRepo.js');
    const { stashFiles, stashFileDiff } = await import('../src/git/stash.js');
    const repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    try {
      repo.write('a.txt', 'two\n');
      repo.write('b.txt', 'new\n');
      repo.git('stash', 'push', '--include-untracked', '-m', 'peek');

      const files = await stashFiles(repo.dir, 'stash@{0}');
      const paths = files.map((file) => file.path).sort();
      assert.deepEqual(paths, ['a.txt', 'b.txt']);

      const diff = await stashFileDiff(repo.dir, 'stash@{0}', 'a.txt');
      assert.ok(diff.includes('diff --git a/a.txt b/a.txt'));
      assert.ok(diff.includes('+two'));
    } finally {
      repo.dispose();
    }
  });
});