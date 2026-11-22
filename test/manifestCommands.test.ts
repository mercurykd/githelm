import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * A command listed in package.json without a handler shows up as "command not
 * found" at runtime, and a handler without a manifest entry can never be
 * invoked. Neither is a type error, so this reads the two sources and compares.
 */
const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

const declared: string[] = (pkg.contributes?.commands ?? []).map((entry: { command: string }) => entry.command);
const registered = new Set([...source.matchAll(/register\('([^']+)'/g)].map((match) => match[1]));

describe('manifest and command handlers', () => {
  it('registers a handler for every declared command', () => {
    const missing = declared.filter((id) => !registered.has(id));
    assert.deepEqual(missing, []);
  });

  it('declares every registered command', () => {
    const undeclared = [...registered].filter((id) => !declared.includes(id));
    assert.deepEqual(undeclared, []);
  });

  it('binds keys only to declared commands', () => {
    const unknown = (pkg.contributes?.keybindings ?? [])
      .map((entry: { command: string }) => entry.command)
      .filter((id: string) => !declared.includes(id));
    assert.deepEqual(unknown, []);
  });

  it('lists only declared commands in the palette menu', () => {
    const unknown = (pkg.contributes?.menus?.commandPalette ?? [])
      .map((entry: { command: string }) => entry.command)
      .filter((id: string) => !declared.includes(id));
    assert.deepEqual(unknown, []);
  });

  it('keeps the palette down to the way in, the file menu and the language', () => {
    const hidden = new Set(
      (pkg.contributes?.menus?.commandPalette ?? [])
        .filter((entry: { when?: string }) => entry.when === 'false')
        .map((entry: { command: string }) => entry.command)
    );
    // Screens are reached with keys and a cursor, so only these three stay searchable.
    const visible = declared.filter((id) => !hidden.has(id)).sort();
    assert.deepEqual(visible, ['githelm.file.actions', 'githelm.language', 'githelm.status.open']);
  });

  it('opens a commit’s files as they were at that commit with t', () => {
    // `d` shows what the commit changed; `t` shows the same files as the commit left them,
    // read out of the object database instead of the working tree. Both are panel keys
    // now, so the key is the panel's — and the action it posts is what must exist.
    assert.ok(registered.has('githelm.commit.filesAtRef'));
    assert.match(source, /action === 'filesAtRef'/);
    assert.match(source, /await openFilesAtRef\(state\.repoPath, files, state\.sha\)/);
  });

  it('keeps the whole UI in panels: no key is bound to a text screen', () => {
    // The keys of a screen live inside its webview, so the manifest carries only the
    // three keys that mean something outside one: the way in and the two diff arrows.
    const keys = (pkg.contributes?.keybindings ?? []).map((entry: { key: string }) => entry.key);
    assert.deepEqual(keys.sort(), ['alt+[', 'alt+]', 'alt+g']);
    const views = (pkg.contributes?.keybindings ?? []).filter((entry: { when?: string }) =>
      /githelm\.view/.test(entry.when ?? '')
    );
    assert.deepEqual(views, [], 'a `githelm.view` binding belongs to a screen that no longer exists');
    const buffers = (pkg.contributes?.commands ?? []).filter(
      (entry: { command: string }) => entry.command.startsWith('githelm.webview.') || entry.command === 'githelm.ui.toggle'
    );
    assert.deepEqual(buffers, [], 'the UI switch is gone: there is nothing to switch to');
  });
});
