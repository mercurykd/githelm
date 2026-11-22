import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The diff walk is host code — it imports `vscode`, so no test can run it. What can be
 * proved is that the wiring exists and points the right way: the commands, the icons and
 * the gate in the manifest, the tab bookkeeping, and the one rule the whole feature rests
 * on (a step is a new diff tab, because an open diff cannot change its sides).
 */
const root = path.join(__dirname, '..', '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  contributes: {
    commands: Array<{ command: string; icon?: string; enablement?: string }>;
    keybindings: Array<{ command: string; key: string; when?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
  };
};

const host = read('src/views/diffWalk.ts');
const registry = read('src/views/diffWalkState.ts');
const panel = read('src/webview/panel.ts');
const extension = read('src/extension.ts');

const commandOf = (id: string): { command: string; icon?: string; enablement?: string } => {
  const entry = pkg.contributes.commands.find((candidate) => candidate.command === id);
  assert.ok(entry, `${id} is not declared`);
  return entry;
};

describe('the two arrows of the diff editor', () => {
  it('declares both commands with an arrow icon and a greying rule', () => {
    assert.equal(commandOf('githelm.diff.walkPrev').icon, '$(arrow-left)');
    assert.equal(commandOf('githelm.diff.walkPrev').enablement, 'githelm.diffPrev');
    assert.equal(commandOf('githelm.diff.walkNext').icon, '$(arrow-right)');
    assert.equal(commandOf('githelm.diff.walkNext').enablement, 'githelm.diffNext');
  });

  it('puts them in the toolbar of a diff, next to the change arrows', () => {
    // `editor/title` with `group: navigation` is the toolbar that holds Previous/Next
    // Change. The gate is this extension's own key and nothing else: `isInDiffEditor` is
    // set inside the diff *pane*'s scope, `inMultiDiffEditor` inside the multi-diff's, and
    // which of those a title toolbar resolves against is VS Code's business — depending on
    // it is what hid the icons on every multi-diff. An extension's `setContext` key is
    // global, so every scope sees it, and `sync()` keeps it true only while the active tab
    // really is a walkable diff.
    for (const id of ['githelm.diff.walkPrev', 'githelm.diff.walkNext']) {
      const entry = (pkg.contributes.menus['editor/title'] ?? []).find((item) => item.command === id);
      assert.ok(entry, `${id} is not in editor/title`);
      assert.equal(entry.when, 'githelm.diffWalk');
      assert.match(entry.group ?? '', /^navigation/);
    }
  });

  it('and in the diff’s context menu, on the same rule', () => {
    for (const id of ['githelm.diff.walkPrev', 'githelm.diff.walkNext']) {
      const entry = (pkg.contributes.menus['editor/context'] ?? []).find((item) => item.command === id);
      assert.ok(entry, `${id} is not in editor/context`);
      assert.equal(entry.when, 'githelm.diffWalk');
    }
  });

  it('binds afresh keys, not the ones the editor already uses', () => {
    // alt+left / alt+right are Go Back / Go Forward on Windows, so they cannot be taken.
    const bindings = pkg.contributes.keybindings.filter((entry) => entry.command.startsWith('githelm.diff.walk'));
    assert.deepEqual(
      bindings.map((entry) => [entry.command, entry.key]),
      [
        ['githelm.diff.walkPrev', 'alt+['],
        ['githelm.diff.walkNext', 'alt+]'],
      ]
    );
    for (const entry of bindings) {
      // The focus is in an editor, so the shortcut is claimed there and nowhere else; the
      // walk itself is the same key the icons are gated on.
      assert.equal(entry.when, 'editorTextFocus && githelm.diffWalk');
    }
  });

  it('keeps both of them out of the command palette', () => {
    const hidden = new Set(
      (pkg.contributes.menus.commandPalette ?? [])
        .filter((entry) => entry.when === 'false')
        .map((entry) => entry.command)
    );
    assert.ok(hidden.has('githelm.diff.walkPrev'));
    assert.ok(hidden.has('githelm.diff.walkNext'));
  });

  it('publishes the three context keys the icons are gated on', () => {
    for (const key of ['githelm.diffWalk', 'githelm.diffPrev', 'githelm.diffNext']) {
      assert.match(host, new RegExp(`'${key.replace('.', '\\.')}'`), `${key} is not set`);
    }
    assert.match(host, /executeCommand\('setContext'/);
  });

  it('reads the diff before it moves it', () => {
    assert.match(host, /TabInputTextDiff/);
    assert.match(host, /readPair\(/);
    // A diff is only walkable when its two sides are a commit and its first parent:
    // anything else (a compare range, a stash, two files on disk) is refused there.
    assert.match(host, /!== parent/);
    assert.match(host, /firstParent\(/);
  });

  it('walks the file chain for one file and the repository chain for a list', () => {
    assert.match(host, /fileChain\(/);
    assert.match(host, /repoChain\(/);
    assert.match(host, /changedFiles\(/);
    // One entry means one file, so the walk is that file's history — including the single
    // status diff, whose position is the working tree but whose chain is still the file's.
    // A rule a step wrote wins over the count: a walk that started on a list stays on the
    // commits even when the commit it lands on changed one file.
    assert.match(host, /record\.kind \?\? \(record\.entries\.length > 1 \? 'repo' : plan\.kind\)/);
    assert.match(host, /noteDiff\(opened\.label, opened\.entries, walk\.worktree, walk\.kind\)/);
    // A multi-diff read off its input, with no record of ours, makes the same call on the
    // number of files it shows.
    assert.match(host, /const kind: WalkKind = sides\.length > 1 \? 'repo' : plan\.kind/);
  });

  it('replaces the tab instead of mutating it, because it cannot mutate it', () => {
    assert.match(host, /tabGroups\.close\(tab/);
    assert.match(host, /openRevisionDiffs\(|openDiffEntries\(/);
  });

  it('identifies a multi-diff by its input, and by its label only as a fallback', () => {
    // The pairs of a multi-diff's input are the real answer: they are reported per file, so
    // no title has to be guessed. The property carrying them was renamed between builds —
    // the installed one says `textDiffs`, newer ones `diffEditors` — and both are read.
    assert.match(host, /holder\.diffEditors \?\? holder\.textDiffs/);
    assert.match(host, /side\.original/);
    assert.match(host, /side\.modified/);
    // The registry is the fallback, and it is keyed by the *title* handed to
    // `vscode.changes` — which is not the tab label: VS Code names a multi-diff
    // `"<title> (N files)"`, localised. Without dropping that suffix the lookup finds
    // nothing and no diff is ever walkable, which is the bug this guards.
    assert.match(registry, /titleOfLabel/);
    assert.match(registry, /replace\(\/\\s\*\\\(\\d\+\[\^\(\)\]\*\\\)\\s\*\$\/, ''\)/);
    assert.match(registry, /opened\.get\(label\) \?\? opened\.get\(titleOfLabel\(label\)\)/);
    assert.match(host, /openedDiff\(tab\.label\)/);
    assert.match(panel, /noteDiff\(/);
    // Every opener returns the record, so a caller can keep it for the step.
    assert.match(panel, /Promise<OpenedDiff \| undefined>/);
    // A label is not unique across kinds, and a step closes the tab it replaced: a screen
    // that happens to share a multi-diff's label must not be taken for one.
    assert.match(host, /const canHoldDiff = \(input: unknown\): boolean =>/);
    assert.match(host, /input instanceof vscode\.TabInputWebview/);
    assert.match(host, /input instanceof vscode\.TabInputText\b/);
  });

  it('is registered and kept in step with the tab the reader is in', () => {
    assert.match(extension, /register\('githelm\.diff\.walkPrev'/);
    assert.match(extension, /register\('githelm\.diff\.walkNext'/);
    assert.match(extension, /diffWalk\.run\('older'\)/);
    assert.match(extension, /diffWalk\.run\('newer'\)/);
    assert.match(extension, /tabGroups\.onDidChangeTabs\(\(\) => void diffWalk\.sync\(\)\)/);
    // The icons are gated on a global key, so it must follow the active *group* too: a
    // click into another group changes which tab is active without firing a tab event.
    assert.match(extension, /tabGroups\.onDidChangeTabGroups\(\(\) => void diffWalk\.sync\(\)\)/);
    assert.match(extension, /void diffWalk\.sync\(\);/);
  });
});
