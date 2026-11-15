import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDiscard } from '../src/views/discardPlan';
import type { FileTarget } from '../src/views/discardPlan';
import type { StatusSection } from '../src/git/status';

function file(section: StatusSection, path: string, xy = ' M'): FileTarget {
  return { kind: 'file', section, path, entry: { section, xy, path } } as FileTarget;
}

describe('planDiscard', () => {
  it('sends a staged row to the index layer only', () => {
    const plan = planDiscard([file('staged', 'a.txt', 'M ')]);
    assert.deepEqual(plan.staged, ['a.txt']);
    assert.deepEqual(plan.worktree, []);
    assert.deepEqual(plan.reset, []);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.paths, ['a.txt']);
  });

  it('sends an unstaged row to the working-tree layer only', () => {
    const plan = planDiscard([file('unstaged', 'a.txt', ' M')]);
    assert.deepEqual(plan.worktree, ['a.txt']);
    assert.deepEqual(plan.staged, []);
  });

  it('keeps the two rows of one file apart instead of merging them', () => {
    const plan = planDiscard([file('staged', 'a.txt', 'M '), file('unstaged', 'a.txt', ' M')]);
    assert.deepEqual(plan.staged, ['a.txt']);
    assert.deepEqual(plan.worktree, ['a.txt']);
    assert.deepEqual(plan.paths, ['a.txt']);
  });

  it('deletes an untracked row without touching the staged row of the same path', () => {
    // `git rm --cached`: `D  a.txt` in the index and `?? a.txt` on disk.
    const plan = planDiscard([file('untracked', 'a.txt', '??')]);
    assert.deepEqual(plan.remove, ['a.txt']);
    assert.deepEqual(plan.staged, []);
    assert.deepEqual(plan.paths, ['a.txt']);
  });

  it('resets the index for the staged row of that same path', () => {
    const plan = planDiscard([file('staged', 'a.txt', 'D ')]);
    assert.deepEqual(plan.staged, ['a.txt']);
    assert.deepEqual(plan.remove, []);
  });

  it('drops an intent-to-add row together with its index slot', () => {
    const plan = planDiscard([file('unstaged', 'new.txt', ' A')]);
    assert.deepEqual(plan.reset, ['new.txt']);
    assert.deepEqual(plan.remove, ['new.txt']);
    assert.deepEqual(plan.worktree, []);
  });

  it('resolves conflicts to HEAD and remembers them for the prompt', () => {
    const plan = planDiscard([file('conflict', 'a.txt', 'UU')]);
    assert.deepEqual(plan.reset, ['a.txt']);
    assert.deepEqual(plan.conflicts, ['a.txt']);
    assert.deepEqual(plan.remove, []);
  });

  it('deduplicates repeated cursors but keeps the first-seen order', () => {
    const plan = planDiscard([
      file('unstaged', 'b.txt', ' M'),
      file('staged', 'a.txt', 'M '),
      file('unstaged', 'b.txt', ' M'),
      file('untracked', 'c.txt', '??'),
    ]);
    assert.deepEqual(plan.paths, ['a.txt', 'b.txt', 'c.txt']);
    assert.deepEqual(plan.worktree, ['b.txt']);
    assert.deepEqual(plan.staged, ['a.txt']);
    assert.deepEqual(plan.remove, ['c.txt']);
  });
});
