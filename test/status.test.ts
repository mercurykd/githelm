import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStatus } from '../src/git/status';

const NUL = '\0';

describe('parseStatus', () => {
  it('reads branch header, ahead/behind and a clean tree', () => {
    const raw = `## main...origin/main [ahead 2, behind 1]${NUL}`;
    const status = parseStatus(raw);
    assert.equal(status.branch, 'main');
    assert.equal(status.ahead, 2);
    assert.equal(status.behind, 1);
    assert.deepEqual(status.entries, []);
  });

  it('handles an unborn branch', () => {
    const status = parseStatus(`## No commits yet on main${NUL}`);
    assert.equal(status.branch, 'main');
    assert.deepEqual(status.entries, []);
  });

  it('handles a detached HEAD', () => {
    const status = parseStatus(`## HEAD (no branch)${NUL}`);
    assert.equal(status.branch, '(detached)');
  });

  it('splits staged and unstaged changes of the same file', () => {
    const raw = [`## main${NUL}`, `MM src/app.ts${NUL}`].join('');
    const status = parseStatus(raw);
    assert.deepEqual(status.entries, [
      { section: 'staged', xy: 'M ', path: 'src/app.ts' },
      { section: 'unstaged', xy: ' M', path: 'src/app.ts' },
    ]);
  });

  it('classifies untracked files', () => {
    const status = parseStatus(`## main${NUL}?? README.md${NUL}`);
    assert.deepEqual(status.entries, [{ section: 'untracked', xy: '??', path: 'README.md' }]);
  });

  it('reads renames with the original path from the next record', () => {
    const raw = `## main${NUL}R  new/name.ts${NUL}old/name.ts${NUL} M other.ts${NUL}`;
    const status = parseStatus(raw);
    assert.deepEqual(status.entries[0], {
      section: 'staged',
      xy: 'R ',
      path: 'new/name.ts',
      origPath: 'old/name.ts',
    });
    assert.deepEqual(status.entries[1], { section: 'unstaged', xy: ' M', path: 'other.ts' });
  });

  it('classifies merges with conflicts', () => {
    const status = parseStatus(`## main${NUL}UU both.ts${NUL}AA added-both.ts${NUL}`);
    assert.deepEqual(
      status.entries.map((entry) => entry.section),
      ['conflict', 'conflict']
    );
  });

  it('keeps paths with spaces intact', () => {
    const status = parseStatus(`## main${NUL} M dir with space/file name.ts${NUL}`);
    assert.equal(status.entries[0].path, 'dir with space/file name.ts');
  });
});
