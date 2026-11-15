import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { diffArgs, diffSlug, diffPosition, hunkAt, parseDiff } from '../src/git/diff';
import { git } from '../src/git/exec';
import { buildPatch, selectionForHunk, selectionToLines } from '../src/git/patch';
import { applyPatchToIndex } from '../src/git/stage';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

/**
 * Regression: the parser used to recognise a hunk header only while no hunk was
 * open, so every hunk after the first was swallowed as context. Staging then
 * produced a patch with wrong context and `git apply` rejected it.
 */
const TWO_HUNKS = [
  'diff --git a/file.txt b/file.txt',
  'index 1111111..2222222 100644',
  '--- a/file.txt',
  '+++ b/file.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '@@ -20,3 +20,3 @@',
  ' t',
  '-u',
  '+U',
  ' v',
  '',
].join('\n');

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('multi-hunk parsing', () => {
  it('keeps every hunk of a file separate', () => {
    const parsed = parseDiff(TWO_HUNKS);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].hunks.length, 2, 'second @@ must open a new hunk');

    const [first, second] = parsed.files[0].hunks;
    assert.equal(first.oldStart, 1);
    assert.equal(second.oldStart, 20);
    assert.deepEqual(
      second.lines.map((line) => line.kind),
      ['context', 'del', 'add', 'context']
    );
    assert.equal(second.lines[0].text, ' t');
    assert.equal(second.lines[3].text, ' v');
  });

  it('does not treat a hunk header as a body line', () => {
    const parsed = parseDiff(TWO_HUNKS);
    const body = parsed.files[0].hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
    assert.ok(!body.some((text) => text.startsWith('@@')), 'no body line may start with @@');
  });

  it('maps document lines to lines in the new file', () => {
    const parsed = parseDiff(TWO_HUNKS);
    const lines = TWO_HUNKS.split('\n');

    const header = lines.findIndex((line) => line.startsWith('@@ -20')) + 1;
    assert.deepEqual(diffPosition(parsed, header)?.line, 20);

    const contextBefore = lines.findIndex((line) => line === ' t') + 1;
    assert.deepEqual(diffPosition(parsed, contextBefore)?.line, 20);

    const added = lines.findIndex((line) => line === '+U') + 1;
    assert.deepEqual(diffPosition(parsed, added)?.line, 21, 'removal does not advance the new-side counter');

    const fileHeader = lines.findIndex((line) => line.startsWith('diff --git')) + 1;
    assert.deepEqual(diffPosition(parsed, fileHeader)?.line, 1);
  });

  it('returns undefined outside any file', () => {
    assert.equal(diffPosition(parseDiff(TWO_HUNKS), 99), undefined);
  });
});

describe('hunk under cursor', () => {
  it('finds the hunk containing a body line', () => {
    const parsed = parseDiff(TWO_HUNKS);
    const lines = TWO_HUNKS.split('\n');

    const firstBody = lines.findIndex((line) => line === ' a') + 1;
    assert.deepEqual(hunkAt(parsed, firstBody), { file: 0, hunk: 0 });

    const secondBody = lines.findIndex((line) => line === ' t') + 1;
    assert.deepEqual(hunkAt(parsed, secondBody), { file: 0, hunk: 1 });
  });

  it('finds the hunk when the cursor sits on its header', () => {
    const parsed = parseDiff(TWO_HUNKS);
    const header = TWO_HUNKS.split('\n').findIndex((line) => line.startsWith('@@ -20')) + 1;
    assert.deepEqual(hunkAt(parsed, header), { file: 0, hunk: 1 });
  });

  it('returns undefined outside hunks', () => {
    const parsed = parseDiff(TWO_HUNKS);
    assert.equal(hunkAt(parsed, 1), undefined, 'file header is not a hunk');
    assert.equal(hunkAt(parsed, 99), undefined);
  });

  it('selects every add/del line of that hunk only', () => {
    const parsed = parseDiff(TWO_HUNKS);
    const selection = selectionForHunk(parsed, 0, 1);
    assert.deepEqual(
      selection.map((item) => parsed.files[0].hunks[1].lines[item.line].text),
      ['-u', '+U']
    );
    assert.ok(selection.every((item) => item.hunk === 1));
  });
});

describe('staging from the second hunk of a real file', () => {
  it('maps a selection in the second hunk to that hunk only', async () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
    repo = createTempRepo({ commits: [{ 'file.txt': `${content}\n` }] });
    const changed = content.replace('line 3\n', 'line 3 CHANGED\n').replace('line 25', 'line 25 CHANGED');
    repo.write('file.txt', `${changed}\n`);

    const diff = await git(repo.dir, diffArgs('unstaged'));
    assert.equal(diff.code, 0, diff.stderr);
    const parsed = parseDiff(diff.stdout);
    assert.equal(parsed.files[0].hunks.length, 2);

    // The whole second hunk, as a user would select it.
    const hunk = parsed.files[0].hunks[1];
    const from = hunk.docLine + 1;
    const to = hunk.docLine + hunk.lines.length;
    const selection = selectionToLines(parsed, from, to);

    assert.equal(selection.length, 2, 'one removal and one addition');
    assert.ok(selection.every((item) => item.hunk === 1), 'selection must not leak into the first hunk');
    assert.deepEqual(
      selection.map((item) => hunk.lines[item.line].text),
      ['-line 25', '+line 25 CHANGED']
    );
  });

  it('stages the selected hunk and leaves the other one alone', async () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
    repo = createTempRepo({ commits: [{ 'file.txt': `${content}\n` }] });
    const repoPath = repo.dir;
    const changed = content.replace('line 3\n', 'line 3 CHANGED\n').replace('line 25', 'line 25 CHANGED');
    repo.write('file.txt', `${changed}\n`);

    const diff = await git(repoPath, diffArgs('unstaged'));
    const parsed = parseDiff(diff.stdout);
    const hunk = parsed.files[0].hunks[1];
    const selection = selectionToLines(parsed, hunk.docLine + 1, hunk.docLine + hunk.lines.length);

    const patch = buildPatch(parsed, selection);
    assert.ok(patch.includes('@@ -22,7 +22,7 @@'), `unexpected hunk header in patch:\n${patch}`);
    assert.ok(patch.includes('-line 25'));
    assert.ok(patch.includes('+line 25 CHANGED'));
    assert.ok(!patch.includes('line 3 CHANGED'), 'first hunk must not be included');

    await applyPatchToIndex(repoPath, patch);

    const index = repo.readIndex('file.txt');
    assert.ok(index.includes('line 25 CHANGED'), 'second hunk is staged');
    assert.ok(index.includes('line 3\n'), 'first hunk stays unstaged');
    assert.ok(repo.read('file.txt').includes('line 3 CHANGED'));
  });

  it('stages only the addition when only the + line is selected', async () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    repo = createTempRepo({ commits: [{ 'file.txt': `${content}\n` }] });
    const repoPath = repo.dir;
    repo.write('file.txt', `${content.replace('line 5', 'line 5 EXTRA')}\n`);

    const diff = await git(repoPath, diffArgs('unstaged'));
    const parsed = parseDiff(diff.stdout);
    const hunk = parsed.files[0].hunks[0];
    const lineIndex = hunk.lines.findIndex((line) => line.text === '+line 5 EXTRA');

    await applyPatchToIndex(repoPath, buildPatch(parsed, [{ file: 0, hunk: 0, line: lineIndex }]));

    // Selecting just the addition stages it without the removal, so the index
    // keeps the old line and gains the new one — the documented line-level rule.
    assert.equal(repo.readIndex('file.txt').split('\n')[4], 'line 5');
    assert.equal(repo.readIndex('file.txt').split('\n')[5], 'line 5 EXTRA');
  });
});
describe('diffArgs', () => {
  it('keeps the working tree scope when no paths are given', () => {
    assert.deepEqual(diffArgs('unstaged'), ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=log', '-U3']);
    assert.deepEqual(diffArgs('staged'), ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=log', '-U3']);
  });

  it('scopes the diff to the given paths after a separator', () => {
    assert.deepEqual(diffArgs('unstaged', ['src/app.ts', 'src/second.ts']), [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--submodule=log',
      '-U3',
      '--',
      'src/app.ts',
      'src/second.ts',
    ]);
    assert.deepEqual(diffArgs('staged', ['src/app.ts']), [
      'diff',
      '--cached',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--submodule=log',
      '-U3',
      '--',
      'src/app.ts',
    ]);
  });

  it('treats a path that looks like an option as a path', () => {
    assert.deepEqual(diffArgs('unstaged', ['-U3']).slice(-2), ['--', '-U3']);
  });
});
describe('diffSlug', () => {
  it('names a single-file buffer after the file', () => {
    assert.equal(diffSlug(['src/app.ts']), 'src_app.ts');
    assert.equal(diffSlug([]), '');
  });

  it('makes a file set unique and bounded', () => {
    const two = diffSlug(['src/app.ts', 'src/second.ts']);
    assert.match(two, /^src_app\.ts\+1-[a-z0-9]{1,4}$/);
    const three = diffSlug(['src/app.ts', 'src/second.ts', 'README.md']);
    assert.match(three, /^README\.md\+2-[a-z0-9]{1,4}$/, 'the prefix is the alphabetically first path');
    assert.notEqual(two, three, 'the same first path with another set differs');
    assert.equal(diffSlug(['src/second.ts', 'src/app.ts']), two, 'order does not change identity');
  });
});
