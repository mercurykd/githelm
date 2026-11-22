import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The blame editor paints a span with the theme colour its kind names. A colour that the
 * manifest does not declare is silently invisible, and neither a type nor a test of the
 * text would catch it, so this reads the two files and compares them.
 *
 * The map is read as source because `highlight.ts` imports `vscode`, which a test cannot.
 */
const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'src', 'views', 'highlight.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const block = /export const COLOR_OF[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
const colors = block === null ? {} : Object.fromEntries([...block[1].matchAll(/(?:'?([a-z-]+)'?):\s*'(githelm\.[a-z-]+)'/g)].map((match) => [match[1], match[2]]));
const declared = new Map<string, { defaults: Record<string, string> }>(
  (pkg.contributes?.colors ?? []).map((entry: { id: string; defaults: Record<string, string> }) => [entry.id, entry])
);

describe('the colours of the blame editor', () => {
  it('paints every span kind with a declared colour', () => {
    assert.ok(Object.keys(colors).length > 0, 'the map was found');
    const missing = Object.values(colors).filter((id) => !declared.has(id));
    assert.deepEqual(missing, []);
  });

  it('gives every colour a default, so it works in a theme that does not set it', () => {
    for (const [kind, id] of Object.entries(colors)) {
      const entry = declared.get(id);
      assert.ok(entry, `${kind} → ${id} is declared`);
      assert.ok(entry.defaults.dark, `${id} has a dark default`);
      assert.ok(entry.defaults.light, `${id} has a light default`);
    }
  });
});
