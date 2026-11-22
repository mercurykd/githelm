import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { targetOf } from '../src/webview/targets';

/**
 * The panel sends the ids of its selected rows and the host works out what the key
 * means. A file row must stay a file row, and a Windows path or a stash ref must
 * come through intact — both contain a colon of their own after the row's kind.
 */
describe('webview targets', () => {
  it('reads the kind of a column row and keeps the rest as the value', () => {
    assert.deepEqual(targetOf(['remote:origin']), { kind: 'remote', value: 'origin' });
    assert.deepEqual(targetOf(['stash:stash@{2}']), { kind: 'stash', value: 'stash@{2}' });
    assert.deepEqual(targetOf(['worktree:D:\\domains\\gitsavyy']), {
      kind: 'worktree',
      value: 'D:\\domains\\gitsavyy',
    });
  });

  it('leaves file rows alone', () => {
    assert.equal(targetOf(['staged:src/a.ts']), undefined);
    assert.equal(targetOf(['unstaged:src/b:c.ts']), undefined);
    assert.equal(targetOf(['untracked:notes.md']), undefined);
    assert.equal(targetOf([]), undefined);
  });

  it('reads the row at the top of the selection, not the column under it', () => {
    assert.deepEqual(targetOf(['staged:a.ts', 'remote:upstream', 'stash:stash@{0}']), undefined);
    assert.deepEqual(targetOf(['remote:upstream', 'stash:stash@{0}']), {
      kind: 'remote',
      value: 'upstream',
    });
  });

  it('lets a column row answer before the repository-wide keys do', () => {
    // `f`, `P` and `U` are both a column key and a repository-wide one. On a remote
    // row the row names the remote, so its branch has to be reached first; the
    // dispatch is checked in the source because it needs a live panel to run.
    const panel = fs.readFileSync(path.join('src', 'webview', 'panel.ts'), 'utf8');
    const row = panel.indexOf('const target = targetOf(ids)');
    const repo = panel.indexOf('REPO_ACTIONS.has(action)');
    assert.ok(row >= 0 && repo >= 0, 'both branches are in the dispatch');
    assert.ok(row < repo, 'the row decides before the repository-wide keys');
  });
});
