import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Span } from '../src/util/span';
import { buildDocModel, lineNumbersOf, lineSegments, roleOfSpan } from '../src/webview/model/doc';
import { DOC_NEEDS_LINE, resolveDocKey } from '../src/webview/keys';
import { filesOf } from '../src/views/fileList';

/**
 * The sub-screens draw the buffer's own text, so these tests check the one thing that
 * can break that promise: a line whose painted pieces do not add up to the characters
 * the buffer printed. Everything else — the patch, the commit, the blame — arrives as
 * text and spans from the buffer's renderer.
 */
const span = (line: number, start: number, end: number, kind: Span['kind']): Span => ({ line, start, end, kind });

describe('lineSegments', () => {
  it('concatenates to the line it paints', () => {
    const text = '@@ -1,3 +1,4 @@ fn main()';
    const segments = lineSegments(text, [span(0, 0, 15, 'hunk'), span(0, 16, 25, 'path')], 0);
    assert.equal(segments.map((segment) => segment.text).join(''), text);
    assert.deepEqual(
      segments.map((segment) => segment.role),
      ['hunk', 'plain', 'path']
    );
  });

  it('leaves the gaps plain and colours nothing twice', () => {
    const segments = lineSegments('+added', [span(0, 0, 1, 'add'), span(0, 0, 6, 'meta')], 0);
    assert.equal(segments.map((segment) => segment.text).join(''), '+added');
    // The first span that claims a character keeps it; the rest of the line stays meta.
    assert.deepEqual(
      segments.map((segment) => segment.role),
      ['added', 'meta']
    );
  });

  it('clamps spans that run past the end of the line', () => {
    const segments = lineSegments('short', [span(0, 0, 400, 'del')], 0);
    assert.deepEqual(segments, [{ text: 'short', role: 'deleted' }]);
  });

  it('ignores spans of other lines', () => {
    const segments = lineSegments('abc', [span(1, 0, 3, 'add')], 0);
    assert.deepEqual(segments, [{ text: 'abc', role: 'plain' }]);
  });

  it('keeps every buffer span kind paintable', () => {
    // The panel's palette is the buffer's: a kind without a role would draw a gap.
    for (const kind of ['meta', 'hash', 'date', 'author', 'refs', 'graph', 'hunk', 'add', 'del', 'path', 'rule', 'help', 'title'] as const) {
      assert.equal(typeof roleOfSpan(kind), 'string', kind);
    }
  });
});

describe('buildDocModel', () => {
  const text = ['## files (1)', '  M src/a.ts', '  A src/b.ts', ''].join('\n');

  it('turns every line into a row, ids in reading order', () => {
    const model = buildDocModel({
      screen: 'commit',
      title: 'src/a.ts',
      text,
      spans: [span(1, 2, 3, 'file-modified'), span(1, 4, 13, 'path')],
      selectFirst: 'select',
      emptyText: 'empty',
    });
    assert.equal(model.kind, 'doc');
    assert.deepEqual(
      model.lines.map((line) => line.id),
      ['line:0', 'line:1', 'line:2']
    );
    assert.equal(model.lines[1].text, '  M src/a.ts');
    assert.deepEqual(model.lines[1].segments, [
      { text: '  ', role: 'plain' },
      { text: 'M', role: 'modified' },
      { text: ' ', role: 'plain' },
      { text: 'src/a.ts', role: 'path' },
    ]);
  });

  it('drops the trailing newline the hint line leaves behind', () => {
    const model = buildDocModel({
      screen: 'commit',
      title: 'a',
      text: 'one\n',
      spans: [],
      selectFirst: 'select',
      emptyText: 'empty',
    });
    assert.deepEqual(
      model.lines.map((line) => line.text),
      ['one']
    );
  });

  it('keeps an empty document as no rows, not as one empty row', () => {
    const model = buildDocModel({
      screen: 'commit',
      title: 'a',
      text: '',
      spans: [],
      selectFirst: 'select',
      emptyText: 'nothing to diff',
    });
    assert.equal(model.lines.length, 1);
    assert.equal(model.lines[0].text, '');
    assert.equal(model.emptyText, 'nothing to diff');
  });
});

describe('a document file list', () => {
  const text = ['## files (2)', '  M src/a.ts', '  A src/b.ts', ''].join('\n');
  const model = (groups?: { header: number; lines: readonly number[] }[]) =>
    buildDocModel({
      screen: 'commit',
      title: 'src/a.ts',
      text,
      spans: [],
      groups,
      selectFirst: 'select',
      emptyText: 'empty',
    });

  it('marks the header that stands for the rows under it', () => {
    // The panel cannot tell a header from any other line of text, so the model names it:
    // a click on `line:0` selects `line:1` and `line:2`, and one `d` is both files.
    assert.deepEqual(model([{ header: 0, lines: [1, 2] }]).groups, [
      { header: 'line:0', ids: ['line:1', 'line:2'] },
    ]);
  });

  it('cannot mistake a header for a row of another document', () => {
    assert.deepEqual(model().groups, []);
    // A list with no rows under it is not a group: there would be nothing to select.
    assert.deepEqual(model([{ header: 0, lines: [] }]).groups, []);
  });
});

describe('filesOf', () => {
  const list = {
    header: 2,
    lines: [4, 5, 6],
    targets: new Map([
      [4, 'src/a.ts'],
      [5, 'src/b.ts'],
      [6, 'src/c.ts'],
    ]),
  };

  it('reads the rows of a selection as the files they name', () => {
    assert.deepEqual(filesOf(list, [5]), ['src/b.ts']);
    assert.deepEqual(filesOf(list, [4, 6]), ['src/a.ts', 'src/c.ts']);
  });

  it('reads the header as the whole list', () => {
    // `## files (3)` under the cursor, or clicked in the panel, means all three.
    assert.deepEqual(filesOf(list, [2]), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual(filesOf(list, [1, 2, 3]), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('skips the lines that name no file instead of failing the key', () => {
    // A drag from the commit's metadata to the last file: the metadata is not an error.
    assert.deepEqual(filesOf(list, [0, 1, 2, 3, 6]), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual(filesOf(list, [0, 1]), []);
  });

  it('names a file once, in the order of the list', () => {
    assert.deepEqual(filesOf(list, [6, 4, 4]), ['src/a.ts', 'src/c.ts']);
  });

  it('answers nothing for a document that is not a file list', () => {
    assert.deepEqual(filesOf(undefined, [1, 2]), []);
  });
});

describe('lineNumbersOf', () => {
  it('turns selected rows into sorted, unique lines', () => {
    assert.deepEqual(lineNumbersOf(['line:3', 'line:1', 'line:3']), [1, 3]);
  });

  it('drops ids that are not rows of a document', () => {
    assert.deepEqual(lineNumbersOf(['file:0:src/a.ts', '', 'line:x']), []);
  });
});

describe('doc keymap', () => {
  it('binds the keys of a commit file list, and only those', () => {
    assert.equal(resolveDocKey('commit', { code: 'KeyD' }), 'fileDiff');
    // `t` is the same files as tabs of their own, as the commit left them — a commit is a
    // state as well as a change.
    assert.equal(resolveDocKey('commit', { code: 'KeyT' }), 'filesAtRef');
    assert.equal(resolveDocKey('commit', { code: 'KeyR' }), 'refresh');
    assert.equal(resolveDocKey('commit', { code: 'KeyQ' }), 'close');
    // The patch keys belonged to a screen that no longer exists: d is the editor's diff.
    assert.equal(resolveDocKey('commit', { code: 'KeyS' }), undefined);
    assert.equal(resolveDocKey('commit', { code: 'Enter' }), undefined);
  });

  it('treats a file opened at a commit as needing the row it is on', () => {
    assert.ok(DOC_NEEDS_LINE.commit.includes('filesAtRef'));
    assert.ok(DOC_NEEDS_LINE.stash.includes('fileDiff'));
  });

  it('binds the conflict sides to the shift chords of the manifest', () => {
    assert.equal(resolveDocKey('conflict', { code: 'KeyO' }), 'ours');
    assert.equal(resolveDocKey('conflict', { code: 'KeyT', shiftKey: true }), 'theirs');
    assert.equal(resolveDocKey('conflict', { code: 'KeyB', shiftKey: true }), 'base');
    assert.equal(resolveDocKey('conflict', { code: 'KeyS' }), 'resolve');
    // `t` alone is the tags opener every panel has, not the other side of the conflict.
    assert.equal(resolveDocKey('conflict', { code: 'KeyT' }), undefined);
  });
});
