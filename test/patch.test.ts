import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDiff, ParsedDiff } from '../src/git/diff';
import { buildPatch, LineSelection, PatchBuildError, selectionToLines } from '../src/git/patch';

const SIMPLE_DIFF = [
  'diff --git a/file.txt b/file.txt',
  'index 1111111..2222222 100644',
  '--- a/file.txt',
  '+++ b/file.txt',
  '@@ -1,3 +1,4 @@ section header',
  ' a',
  '-b',
  '+B',
  ' c',
  '+d',
  '',
].join('\n');

function bodyIndexOf(diff: ParsedDiff, text: string): LineSelection {
  const hunk = diff.files[0].hunks[0];
  const line = hunk.lines.findIndex((candidate) => candidate.text === text);
  if (line < 0) {
    throw new Error(`line ${text} not found`);
  }
  return { file: 0, hunk: 0, line };
}

describe('parseDiff', () => {
  it('parses files, hunks, paths and body lines', () => {
    const parsed = parseDiff(SIMPLE_DIFF);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].path, 'file.txt');
    assert.equal(parsed.files[0].oldPath, 'file.txt');

    const hunk = parsed.files[0].hunks[0];
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.oldLines, 3);
    assert.equal(hunk.newLines, 4);
    assert.deepEqual(
      hunk.lines.map((line) => line.kind),
      ['context', 'del', 'add', 'context', 'add']
    );
    assert.equal(hunk.docLine, 5);
  });

  it('handles several files and keeps header lines apart', () => {
    const text = `${SIMPLE_DIFF}diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n`;
    const parsed = parseDiff(text);
    assert.equal(parsed.files.length, 2);
    assert.equal(parsed.files[1].path, 'new.txt');
    assert.ok(parsed.files[1].headerLines.includes('new file mode 100644'));
    assert.equal(parsed.files[1].hunks[0].oldLines, 0);
  });
});

describe('selectionToLines', () => {
  it('selects only add/del lines inside the document range', () => {
    const parsed = parseDiff(SIMPLE_DIFF);
    // docLine 5 is the @@ header, so body lines live on 6..10
    const all = selectionToLines(parsed, 6, 10);
    assert.equal(all.length, 3);

    const onlyAddition = selectionToLines(parsed, 10, 10);
    assert.deepEqual(onlyAddition, [{ file: 0, hunk: 0, line: 4 }]);

    const contextOnly = selectionToLines(parsed, 6, 6);
    assert.deepEqual(contextOnly, []);
  });

  it('normalises a reversed selection', () => {
    const parsed = parseDiff(SIMPLE_DIFF);
    assert.deepEqual(selectionToLines(parsed, 10, 8), selectionToLines(parsed, 8, 10));
  });
});

describe('buildPatch', () => {
  it('keeps context and stages a single added line', () => {
    const parsed = parseDiff(SIMPLE_DIFF);
    const patch = buildPatch(parsed, [bodyIndexOf(parsed, '+d')]);
    assert.equal(
      patch,
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,3 +1,4 @@ section header',
        ' a',
        ' b',
        ' c',
        '+d',
        '',
      ].join('\n')
    );
  });

  it('turns an unselected removal into context so the line survives', () => {
    const parsed = parseDiff(SIMPLE_DIFF);
    const patch = buildPatch(parsed, [bodyIndexOf(parsed, '+B')]);
    const body = patch.split('\n').slice(4).join('\n');
    assert.equal(body, ['@@ -1,3 +1,4 @@ section header', ' a', ' b', '+B', ' c', ''].join('\n'));
  });

  it('stages a removal together with its replacement', () => {
    const parsed = parseDiff(SIMPLE_DIFF);
    const patch = buildPatch(parsed, [bodyIndexOf(parsed, '-b'), bodyIndexOf(parsed, '+B')]);
    assert.equal(patch.split('\n')[4], '@@ -1,3 +1,3 @@ section header');
    assert.ok(patch.includes('-b'));
    assert.ok(patch.includes('+B'));
    assert.ok(!patch.includes('+d'));
  });

  it('returns an empty patch when nothing selectable is selected', () => {
    const parsed = parseDiff(SIMPLE_DIFF);
    assert.equal(buildPatch(parsed, []), '');
  });

  it('refuses partial selection in hunks without a trailing newline', () => {
    const text = [
      'diff --git a/eof.txt b/eof.txt',
      '--- a/eof.txt',
      '+++ b/eof.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+B',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const parsed = parseDiff(text);
    assert.throws(() => buildPatch(parsed, [bodyIndexOf(parsed, '-b')]), PatchBuildError);
  });

  it('keeps end-of-file markers when the whole hunk is selected', () => {
    const text = [
      'diff --git a/eof.txt b/eof.txt',
      '--- a/eof.txt',
      '+++ b/eof.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+B',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const parsed = parseDiff(text);
    const patch = buildPatch(parsed, [bodyIndexOf(parsed, '-b'), bodyIndexOf(parsed, '+B')]);
    assert.ok(patch.includes('\\ No newline at end of file'));
  });
});
