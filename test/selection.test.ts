import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeId, click, clear, drag, rangeIds, retain, rowDomId, selectAll } from '../src/webview/selection';

/**
 * The selection is the webview's replacement for the text caret: what "the files
 * this action applies to" means once the screen is not a text buffer.
 */
const ORDER = ['staged:a.ts', 'staged:b.ts', 'untracked:c.ts', 'untracked:d.ts'];

describe('status list selection', () => {
  it('a plain click selects one row and makes it the anchor', () => {
    assert.deepEqual(click({ ids: [] }, ORDER, 'untracked:c.ts'), {
      ids: ['untracked:c.ts'],
      anchor: 'untracked:c.ts',
    });
  });

  it('a plain click on another row replaces the selection', () => {
    const state = click({ ids: ['staged:a.ts'], anchor: 'staged:a.ts' }, ORDER, 'untracked:d.ts');
    assert.deepEqual(state.ids, ['untracked:d.ts']);
  });

  it('Ctrl+Click toggles one row', () => {
    let state = click({ ids: [] }, ORDER, 'staged:a.ts');
    state = click(state, ORDER, 'untracked:d.ts', { ctrl: true });
    assert.deepEqual(state.ids, ['staged:a.ts', 'untracked:d.ts']);
    state = click(state, ORDER, 'staged:a.ts', { ctrl: true });
    assert.deepEqual(state.ids, ['untracked:d.ts']);
  });

  it('Shift+Click takes the range and crosses section borders in both directions', () => {
    let state = click({ ids: [] }, ORDER, 'staged:b.ts');
    state = click(state, ORDER, 'untracked:c.ts', { shift: true });
    assert.deepEqual(state.ids, ['staged:b.ts', 'untracked:c.ts']);
    assert.equal(state.anchor, 'staged:b.ts', 'the anchor stays where the plain click was');

    state = click(state, ORDER, 'staged:a.ts', { shift: true });
    assert.deepEqual(state.ids, ['staged:a.ts', 'staged:b.ts']);
  });

  it('Ctrl+Shift+Click adds the range to what is already selected', () => {
    let state = click({ ids: [] }, ORDER, 'staged:a.ts');
    state = click(state, ORDER, 'untracked:d.ts', { ctrl: true });
    state = click(state, ORDER, 'staged:b.ts', { shift: true, ctrl: true });
    // Everything from the anchor to the clicked row, plus what was selected before.
    assert.deepEqual([...state.ids].sort(), ['staged:a.ts', 'staged:b.ts', 'untracked:c.ts', 'untracked:d.ts']);
    assert.equal(state.anchor, 'untracked:d.ts');
  });

  it('a drag sweeps a range and replaces the selection', () => {
    assert.deepEqual(drag(ORDER, 'staged:a.ts', 'untracked:c.ts'), {
      ids: ['staged:a.ts', 'staged:b.ts', 'untracked:c.ts'],
      anchor: 'staged:a.ts',
    });
  });

  it('Select All takes every row, Clear drops them', () => {
    assert.deepEqual(selectAll(ORDER).ids, ORDER);
    assert.deepEqual(clear(), { ids: [] });
  });

  it('retain forgets rows that left the screen', () => {
    const state = retain({ ids: ['staged:a.ts', 'untracked:d.ts'], anchor: 'untracked:d.ts' }, ORDER.slice(0, 2));
    assert.deepEqual(state, { ids: ['staged:a.ts'], anchor: 'staged:a.ts' });
  });

  it('the active row is the anchor, so the caret is the last row clicked', () => {
    assert.equal(activeId({ ids: ['untracked:c.ts'], anchor: 'untracked:c.ts' }), 'untracked:c.ts');
    // A Shift range keeps the anchor at the end the reader started from.
    const range = click({ ids: [], anchor: 'staged:b.ts' }, ORDER, 'untracked:d.ts', { shift: true });
    assert.equal(activeId(range), 'staged:b.ts');
    // Nothing selected: no row is active, so no `aria-activedescendant` either.
    assert.equal(activeId(clear()), undefined);
  });

  it('gives every row an id the DOM will accept', () => {
    // Row ids are names, not HTML ids: `line:3` and `src/a.ts` both have to survive.
    assert.equal(rowDomId('line:3'), 'row-line_3');
    assert.equal(rowDomId('staged:src/a.ts'), 'row-staged_src_a_ts');
    assert.match(rowDomId('line:12'), /^row-[A-Za-z0-9_-]+$/);
    // Distinct rows never collide, which is what `aria-activedescendant` needs.
    assert.notEqual(rowDomId('line:1'), rowDomId('line:11'));
  });

  it('ignores ids that are not in the list', () => {
    const state = { ids: ['staged:a.ts'], anchor: 'staged:a.ts' };
    assert.deepEqual(click(state, ORDER, 'gone', {}), state);
    assert.deepEqual(rangeIds(ORDER, 'staged:a.ts', 'gone'), []);
  });
});
