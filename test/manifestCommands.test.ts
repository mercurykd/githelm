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

  it('routes each githelm view to its own key bindings', () => {
    const views = new Set(
      (pkg.contributes?.keybindings ?? [])
        .map((entry: { when?: string }) => /githelm\.view == '([^']+)'/.exec(entry.when ?? '')?.[1])
        .filter(Boolean)
    );
    for (const view of ['status', 'log', 'branches', 'tags', 'submodules']) {
      assert.ok(views.has(view), `no key bindings for the ${view} view`);
    }
  });
});
