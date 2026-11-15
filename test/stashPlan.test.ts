import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planStash, stashArgs } from '../src/git/stash';

describe('stashArgs', () => {
  it('is a plain stash of the working tree by default', () => {
    assert.deepEqual(stashArgs({}), ['stash', 'push']);
  });

  it('adds --staged for the index only', () => {
    assert.deepEqual(stashArgs({ staged: true }), ['stash', 'push', '--staged']);
  });

  it('adds --include-untracked for untracked files', () => {
    assert.deepEqual(stashArgs({ includeUntracked: true }), ['stash', 'push', '--include-untracked']);
  });

  it('keeps the flags before the message and the paths last', () => {
    assert.deepEqual(stashArgs({ staged: true, includeUntracked: true, paths: ['a.txt', 'b.txt'] }, ' wip '), [
      'stash',
      'push',
      '--staged',
      '--include-untracked',
      '-m',
      'wip',
      '--',
      'a.txt',
      'b.txt',
    ]);
  });

  it('drops an empty message instead of passing an empty -m', () => {
    assert.deepEqual(stashArgs({}, '   '), ['stash', 'push']);
    assert.deepEqual(stashArgs({}, undefined), ['stash', 'push']);
  });

  it('leaves the paths out when the list is empty', () => {
    assert.deepEqual(stashArgs({ paths: [] }, 'wip'), ['stash', 'push', '-m', 'wip']);
  });
});

describe('planStash', () => {
  it('stashes the whole tree when nothing is selected and no option is picked', () => {
    assert.deepEqual(planStash([]), {});
    assert.deepEqual(planStash([], {}), {});
  });

  it('takes the picked option when nothing is selected', () => {
    assert.deepEqual(planStash([], { staged: true }), { staged: true });
    assert.deepEqual(planStash([], { includeUntracked: true }), { includeUntracked: true });
  });

  it('stashes only the selected files, and ignores the picked options', () => {
    const plan = planStash(
      [
        { path: 'src/app.ts', section: 'unstaged' },
        { path: 'src/second.ts', section: 'staged' },
      ],
      { staged: true, includeUntracked: true }
    );
    assert.deepEqual(plan, { paths: ['src/app.ts', 'src/second.ts'] });
    assert.equal('staged' in plan, false, 'a path list and --staged are two different answers');
  });

  it('adds -u when a selected file is untracked, or the path would not be found', () => {
    const tracked = planStash([{ path: 'a.txt', section: 'unstaged' }]);
    assert.equal('includeUntracked' in tracked, false);
    const withUntracked = planStash([
      { path: 'a.txt', section: 'unstaged' },
      { path: 'notes/todo.md', section: 'untracked' },
    ]);
    assert.deepEqual(withUntracked, { paths: ['a.txt', 'notes/todo.md'], includeUntracked: true });
  });

  it('lists a path once, however many cursors cover it', () => {
    const plan = planStash([
      { path: 'a.txt', section: 'staged' },
      { path: 'a.txt', section: 'unstaged' },
    ]);
    assert.deepEqual(plan, { paths: ['a.txt'] });
  });
});
