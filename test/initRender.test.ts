import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isInitRow, renderInit } from '../src/views/initRender';

/**
 * The screen a folder without a repository gets, as a panel draws it: the buffer's own
 * `renderUninitialized()` text, and the one row that runs `git init`.
 */
describe('the git init screen as a panel', () => {
  it('draws the buffer’s text, character for character', () => {
    const rendered = renderInit('D:/work/plain');
    assert.ok(rendered.text.includes('REPO: D:/work/plain'));
    assert.ok(rendered.text.includes('## init (1)'));
    assert.ok(rendered.text.includes('git init'));
    assert.ok(rendered.text.endsWith('\n'), 'a document ends with a newline');
  });

  it('gives the panel the spans of the buffer, so the colours match', () => {
    // The panel paints `spans`, so an empty list would paint the screen plain while the
    // buffer draws the folder in one colour and the action in another.
    const rendered = renderInit('D:/work/plain');
    const lines = rendered.text.split('\n');
    assert.ok(rendered.spans.length > 0);
    // The action row is painted as a branch, the section header as a section.
    const actionRow = lines.findIndex((line) => line.includes('git init  —'));
    assert.ok(rendered.spans.some((span) => span.line === actionRow && span.kind === 'branch'));
    const headerRow = lines.findIndex((line) => line.startsWith('## init'));
    assert.ok(rendered.spans.some((span) => span.line === headerRow && span.kind === 'section'));
    for (const span of rendered.spans) {
      assert.ok(span.end > span.start && span.end <= lines[span.line].length, `span on line ${span.line}`);
    }
  });

  it('finds the action row and no other', () => {
    const folder = 'D:/work/plain';
    const lines = renderInit(folder).text.split('\n');
    const actionRow = lines.findIndex((line) => line.includes('git init  —')) + 1;
    assert.equal(isInitRow(folder, actionRow), true);
    for (const [index, line] of lines.entries()) {
      if (index + 1 === actionRow) {
        continue;
      }
      // The empty line the renderer ends with is not a row of the screen either.
      assert.equal(isInitRow(folder, index + 1), false, `line ${index + 1}: ${line}`);
    }
  });

  it('names the folder it was given, not a normalized one', () => {
    // The screen is a document keyed by the folder: two spellings are two documents, and
    // the row is found by the spelling the document was painted with.
    const rendered = renderInit('D:\\work\\plain');
    assert.ok(rendered.text.includes('D:\\work\\plain'));
    const row = rendered.text.split('\n').findIndex((line) => line.includes('git init  —')) + 1;
    assert.equal(isInitRow('D:\\work\\plain', row), true);
  });
});
