import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chordOf, DOC_KEYS, DOC_NEEDS_LINE, resolveDocKey, resolveKey, resolveScreenKey, resolveStatusKey, SCREEN_NEEDS_ROW } from '../src/webview/keys';

/**
 * A key press is matched by its physical key (`event.code`), because `event.key` is
 * whatever the layout produces: on a Russian layout the `s` key reports `ы`, and
 * every letter binding in the panel quietly stopped matching.
 */
describe('webview keymap', () => {
  it('matches the physical key, not the character the layout produces', () => {
    assert.deepEqual(resolveKey({ code: 'KeyS', key: 'ы' }), { kind: 'action', action: 'stage' });
    assert.deepEqual(resolveKey({ code: 'KeyU', key: 'г' }), { kind: 'action', action: 'unstage' });
    assert.deepEqual(resolveKey({ code: 'KeyD', key: 'в' }), { kind: 'action', action: 'diff' });
    assert.deepEqual(resolveKey({ code: 'KeyQ', key: 'й' }), { kind: 'action', action: 'close' });
  });

  it('gives Latin and Cyrillic layouts the same command', () => {
    const pairs: Array<[string, string, string]> = [
      ['KeyS', 's', 'ы'],
      ['KeyT', 't', 'е'],
      ['KeyZ', 'z', 'я'],
      ['KeyC', 'c', 'с'],
      ['KeyR', 'r', 'к'],
      ['KeyI', 'i', 'ш'],
    ];
    for (const [code, latin, cyrillic] of pairs) {
      assert.deepEqual(resolveKey({ code, key: latin }), resolveKey({ code, key: cyrillic }), code);
    }
  });

  it('uses Shift for the bigger variant, as the buffer does', () => {
    assert.deepEqual(resolveKey({ code: 'KeyT', shiftKey: true }), {
      kind: 'opener',
      command: 'githelm.tags.open',
    });
    assert.deepEqual(resolveKey({ code: 'KeyD', shiftKey: true }), { kind: 'action', action: 'discard' });
    assert.deepEqual(resolveKey({ code: 'KeyS', shiftKey: true }), {
      kind: 'opener',
      command: 'githelm.submodules.open',
    });
    assert.deepEqual(resolveKey({ code: 'KeyT' }), { kind: 'action', action: 'tag' });
  });

  it('handles Alt and Ctrl combinations first', () => {
    assert.deepEqual(resolveKey({ code: 'KeyS', altKey: true }), { kind: 'action', action: 'stageAll' });
    assert.deepEqual(resolveKey({ code: 'KeyU', altKey: true }), { kind: 'action', action: 'unstageAll' });
    assert.deepEqual(resolveKey({ code: 'KeyA', ctrlKey: true }), { kind: 'selectAll' });
    assert.deepEqual(resolveKey({ code: 'KeyC', metaKey: true }), { kind: 'copy' });
    assert.deepEqual(resolveKey({ code: 'KeyC', ctrlKey: true }), { kind: 'copy' });
    assert.equal(resolveKey({ code: 'KeyX', ctrlKey: true }), undefined);
  });

  it('routes the screen openers and leaves unknown keys to VS Code', () => {
    assert.deepEqual(resolveKey({ code: 'KeyG' }), { kind: 'opener', command: 'githelm.log.open' });
    assert.equal(resolveKey({ code: 'KeyK' }), undefined);
    assert.equal(resolveKey({ code: 'F5' }), undefined);
  });

  it('gives the branches screen the graph of the row under the cursor', () => {
    // `g` opens the graph of everything from every screen; on a screen of branches the
    // bigger variant of the same key is the graph of one branch, and the history screen's
    // branch filter is what reads it.
    assert.equal(resolveScreenKey('branches', { code: 'KeyG', shiftKey: true }), 'graph');
    assert.equal(resolveScreenKey('branches', { code: 'KeyG' }), undefined, 'plain `g` stays the opener');
    assert.equal(resolveScreenKey('log', { code: 'KeyG', shiftKey: true }), undefined);
    assert.equal(resolveScreenKey('tags', { code: 'KeyG', shiftKey: true }), undefined);
    assert.equal(resolveScreenKey('submodules', { code: 'KeyG', shiftKey: true }), undefined);
    assert.ok(SCREEN_NEEDS_ROW.branches.includes('graph'), 'the key needs a branch to name');
    assert.equal(SCREEN_NEEDS_ROW.log.includes('graph'), false, 'the graph screen has no row to open');
  });

  it('takes the repository keys that need no row under the cursor', () => {
    assert.deepEqual(resolveKey({ code: 'KeyM' }), { kind: 'action', action: 'amend' });
    assert.deepEqual(resolveKey({ code: 'KeyF' }), { kind: 'action', action: 'fetch' });
    assert.deepEqual(resolveKey({ code: 'KeyP', shiftKey: true }), { kind: 'action', action: 'pull' });
    assert.deepEqual(resolveKey({ code: 'KeyU', shiftKey: true }), { kind: 'action', action: 'push' });
    assert.deepEqual(resolveKey({ code: 'KeyR', shiftKey: true }), { kind: 'action', action: 'reset' });
    assert.deepEqual(resolveKey({ code: 'KeyM', shiftKey: true }), { kind: 'action', action: 'abort' });
    assert.deepEqual(resolveKey({ code: 'KeyF', shiftKey: true }), { kind: 'action', action: 'pulls' });
    assert.deepEqual(resolveKey({ code: 'KeyA', shiftKey: true }), { kind: 'action', action: 'remoteAdd' });
    assert.deepEqual(resolveKey({ code: 'KeyW', shiftKey: true }), { kind: 'action', action: 'worktreePrune' });
    // The unshifted keys keep their old meaning: `r` refreshes, `u` unstages.
    assert.deepEqual(resolveKey({ code: 'KeyR' }), { kind: 'action', action: 'refresh' });
    assert.deepEqual(resolveKey({ code: 'KeyU' }), { kind: 'action', action: 'unstage' });
  });

  it('gives the right-hand column the keys the buffer gives it', () => {
    // The panel sends the row along with the key, so the host picks the block.
    assert.deepEqual(resolveKey({ code: 'KeyA' }), { kind: 'action', action: 'stashApply' });
    assert.deepEqual(resolveKey({ code: 'KeyP' }), { kind: 'action', action: 'stashPop' });
    assert.deepEqual(resolveKey({ code: 'KeyX' }), { kind: 'action', action: 'delete' });
    assert.deepEqual(resolveKey({ code: 'KeyE' }), { kind: 'action', action: 'edit' });
    assert.deepEqual(resolveKey({ code: 'KeyN' }), { kind: 'action', action: 'worktreeAdd' });
    assert.deepEqual(resolveKey({ code: 'Enter', shiftKey: true }), {
      kind: 'action',
      action: 'worktreeWindow',
    });
    assert.deepEqual(resolveKey({ code: 'Enter', altKey: true }), {
      kind: 'action',
      action: 'worktreeHere',
    });
    // `Enter` alone still opens, and Alt+Shift+Enter is nobody's key.
    assert.deepEqual(resolveKey({ code: 'Enter' }), { kind: 'open' });
    assert.equal(resolveKey({ code: 'Enter', altKey: true, shiftKey: true }), undefined);
  });

  it('gives a branch row on the status screen the branches screen’s keys', () => {
    // The row under the selection decides, as it does for the column: `c` checks out a
    // branch and commits a file, `m` merges a branch and amends a file, `n` creates a
    // branch from the selected one and adds a worktree anywhere else.
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'Enter' }), { kind: 'action', action: 'checkout' });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'NumpadEnter' }), { kind: 'action', action: 'checkout' });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'KeyC' }), { kind: 'action', action: 'checkout' });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'KeyN' }), { kind: 'action', action: 'create' });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'KeyM' }), { kind: 'action', action: 'merge' });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'KeyR', shiftKey: true }), {
      kind: 'action',
      action: 'reset',
    });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'KeyG', shiftKey: true }), {
      kind: 'action',
      action: 'graph',
    });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'KeyG' }), {
      kind: 'opener',
      command: 'githelm.log.open',
    }, 'plain `g` still opens the whole history');
    // Outside a branch row the status keys keep their meaning.
    assert.deepEqual(resolveStatusKey('staged:src/app.ts', { code: 'KeyC' }), { kind: 'action', action: 'commit' });
    assert.deepEqual(resolveStatusKey(undefined, { code: 'KeyM' }), { kind: 'action', action: 'amend' });
    assert.deepEqual(resolveStatusKey('worktree:D:/repo', { code: 'KeyN' }), {
      kind: 'action',
      action: 'worktreeAdd',
    });
    // A bigger variant that is not a branch key stays the status screen's: `Shift+Enter`
    // is a worktree window and `Shift+M` aborts a merge, exactly as outside the block.
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'Enter', shiftKey: true }), {
      kind: 'action',
      action: 'worktreeWindow',
    });
    assert.deepEqual(resolveStatusKey('branch:main', { code: 'KeyM', shiftKey: true }), {
      kind: 'action',
      action: 'abort',
    });
  });

  it('gives a commit row on the status screen the history screen’s keys', () => {
    const id = 'commit:9a7e4eb0000000000000000000000000000000000';
    assert.deepEqual(resolveStatusKey(id, { code: 'Enter' }), { kind: 'action', action: 'show' });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyN' }), { kind: 'action', action: 'create' });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyC' }), { kind: 'action', action: 'checkout' });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyC', shiftKey: true }), {
      kind: 'action',
      action: 'cherryPick',
    });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyV', shiftKey: true }), {
      kind: 'action',
      action: 'revert',
    });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyF' }), { kind: 'action', action: 'fixup' });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyR', shiftKey: true }), {
      kind: 'action',
      action: 'reset',
    });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyT' }), { kind: 'action', action: 'tag' });
    // The status screen's own keys keep their meaning on a commit row.
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyR' }), { kind: 'action', action: 'refresh' });
    assert.deepEqual(resolveStatusKey(id, { code: 'KeyG' }), {
      kind: 'opener',
      command: 'githelm.log.open',
    });
    // And the commit keys do not leak to a file row.
    assert.deepEqual(resolveStatusKey('staged:src/app.ts', { code: 'KeyF' }), {
      kind: 'action',
      action: 'fetch',
    });
  });

  it('handles the navigation keys by code too', () => {
    assert.deepEqual(resolveKey({ code: 'Enter' }), { kind: 'open' });
    assert.deepEqual(resolveKey({ code: 'Escape' }), { kind: 'clear' });
    assert.deepEqual(resolveKey({ code: 'ArrowDown', shiftKey: true }), {
      kind: 'move',
      direction: 'down',
      extend: true,
    });
    assert.deepEqual(resolveKey({ code: 'ArrowUp' }), { kind: 'move', direction: 'up', extend: false });
  });

  it('gives the git init screen Enter, and nothing else that acts', () => {
    // The screen of a folder without a repository has one row: `Enter` runs `git init`,
    // `r` re-reads it and `q` closes it, as every panel's `r` and `q` do.
    assert.equal(resolveDocKey('init', { code: 'Enter' }), 'open');
    assert.equal(resolveDocKey('init', { code: 'NumpadEnter' }), 'open', 'the keypad is Enter too');
    assert.equal(resolveDocKey('init', { code: 'KeyR' }), 'refresh');
    assert.equal(resolveDocKey('init', { code: 'KeyQ' }), 'close');
    assert.equal(resolveDocKey('init', { code: 'KeyD' }), undefined, 'no diff: there is no file');
    // Nothing to select: `Enter` must initialise the folder on the row-less screen, not
    // answer "select a row first" on a screen that has one row.
    assert.deepEqual(DOC_NEEDS_LINE.init, []);
    assert.deepEqual(Object.keys(DOC_KEYS.init).sort(), ['Enter', 'KeyQ', 'KeyR']);
  });

  it('reads the numeric keypad as the keys above it', () => {
    // The DOM names the keypad's Enter `NumpadEnter`. VS Code folds it into `enter` for
    // the buffers; the panel used to match the DOM name alone, so the keypad's Enter was
    // silent there while it worked in a text screen.
    assert.deepEqual(resolveKey({ code: 'NumpadEnter' }), { kind: 'open' });
    assert.deepEqual(resolveKey({ code: 'NumpadEnter', altKey: true }), {
      kind: 'action',
      action: 'worktreeHere',
    });
    assert.deepEqual(resolveKey({ code: 'NumpadEnter', shiftKey: true }), {
      kind: 'action',
      action: 'worktreeWindow',
    });
    // The keypad's `/` is the history screen's filter key, and a screen key is read
    // through the same folding: the chord is the one the table uses.
    assert.equal(chordOf({ code: 'NumpadDivide' }), chordOf({ code: 'Slash' }));
    assert.equal(chordOf({ code: 'NumpadEnter' }), 'Enter');
    assert.equal(resolveScreenKey('branches', { code: 'NumpadEnter' }), 'checkout');
    assert.equal(resolveScreenKey('log', { code: 'NumpadDivide' }), 'filters');
  });
});
