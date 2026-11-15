import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';

/**
 * The buffers are painted with `ThemeColor`s: the ids live in `highlight.ts`,
 * the defaults in the manifest. Nothing in TypeScript ties the two lists
 * together, so a renamed id would silently paint with the default foreground.
 */
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  contributes: { colors: { id: string; description: string; defaults: Record<string, string> }[] };
};
const highlighter = fs.readFileSync('src/views/highlight.ts', 'utf8');
const declared = manifest.contributes.colors;
const declaredIds = new Set(declared.map((color) => color.id));

/** Every `'githelm.x'` string literal inside the COLORS map. */
const usedIds = new Set([...highlighter.matchAll(/'(githelm\.[a-z-]+)'/g)].map((match) => match[1]));

/** Dark-theme channels of one id, so two colours can be compared as numbers. */
const channels = (id: string): number[] => {
  const value = declared.find((color) => color.id === id)!.defaults.dark;
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
};
const brightness = (id: string): number => channels(id).reduce((sum, channel) => sum + channel, 0);
const distance = (a: string, b: string): number => {
  const [x, y] = [channels(a), channels(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

describe('theme colours', () => {
  it('declares every colour the highlighter asks for', () => {
    for (const id of usedIds) {
      assert.ok(declaredIds.has(id), `${id} is used by highlight.ts but not declared in package.json`);
    }
  });

  it('uses every declared colour, so no id is dead weight', () => {
    for (const id of declaredIds) {
      assert.ok(usedIds.has(id), `${id} is declared in package.json but never used`);
    }
  });

  it('gives every colour a value for each theme kind', () => {
    for (const color of declared) {
      for (const kind of ['dark', 'light', 'highContrast', 'highContrastLight']) {
        const value = color.defaults[kind];
        assert.match(value ?? '', /^#[0-9a-f]{6}$/, `${color.id}.${kind}: ${value}`);
      }
    }
  });

  it('describes every colour', () => {
    for (const color of declared) {
      assert.ok(color.description.trim().length > 0, `${color.id} has no description`);
    }
  });

  it('keeps the palette warm: no blue channel dominates', () => {
    // A tea-toned palette lives in the amber/rose/olive range, so for every
    // colour the red channel is at least as strong as the blue one.
    for (const color of declared) {
      const value = color.defaults.dark;
      const red = parseInt(value.slice(1, 3), 16);
      const blue = parseInt(value.slice(5, 7), 16);
      assert.ok(red >= blue, `${color.id} (${value}) is a cool colour, not a warm one`);
    }
  });

  it('keeps titles louder than hints and hints louder than the hairline', () => {
    // The hierarchy is the point: a title must read as a title, a hint must
    // read as a comment, and the rule under it must not compete with either.
    for (const title of ['githelm.section', 'githelm.staged', 'githelm.unstaged', 'githelm.untracked', 'githelm.remotes', 'githelm.worktrees']) {
      assert.ok(brightness(title) > brightness('githelm.help'), `${title} is not louder than the hints`);
    }
    assert.ok(brightness('githelm.help') > brightness('githelm.rule'), 'the hairline is louder than the hints');
    assert.ok(brightness('githelm.path') > brightness('githelm.meta'), 'file paths must outshine the metadata that follows them');
    // A row colour has to be told apart from ordinary metadata, whether it does
    // that by being brighter (matcha, honey) or by being a different colour.
    for (const row of ['githelm.staged', 'githelm.unstaged', 'githelm.untracked']) {
      assert.ok(distance(row, 'githelm.meta') > 30, `${row} is too close to ordinary metadata to read as a section`);
    }
  });

  it('separates the branch-to-remote mapping from the URL beside it', () => {
    // A remotes row is `origin  <url>   origin/main: +2 −1`: the mapping has to
    // read as its own fact, not as the tail of the URL or of a commit's refs.
    assert.ok(distance('githelm.upstream', 'githelm.meta') > 30, 'the mapping looks like the URL');
    assert.ok(distance('githelm.upstream', 'githelm.refs') > 30, 'the mapping looks like a commit ref');
  });

  it('gives the three file sections three different colours', () => {
    // staged, unstaged and untracked sit one under another, so their rows have
    // to be told apart without reading the labels.
    const hue = (id: string): string => declared.find((color) => color.id === id)!.defaults.dark;
    const titles = ['githelm.staged', 'githelm.unstaged', 'githelm.untracked'].map(hue);
    assert.equal(new Set(titles).size, 3, 'the three sections share a colour');
    for (const title of titles) {
      assert.notEqual(title, hue('githelm.section'), `${title} is the same as the neutral section colour`);
    }
  });

  it('paints the two column headings with one colour', () => {
    // `remotes` and `worktrees` stand one under the other in the same column of
    // the status buffer, so their headings have to read as one block.
    const remotes = declared.find((color) => color.id === 'githelm.remotes')!.defaults;
    const worktrees = declared.find((color) => color.id === 'githelm.worktrees')!.defaults;
    assert.deepEqual(worktrees, remotes, 'the worktrees heading is the remotes colour');
  });
});
