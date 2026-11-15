import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  allActions,
  clearActions,
  formatAction,
  isMutating,
  recentActions,
  recordAction,
  shortLabel,
  subscribe,
} from '../src/git/actionLog';

import type { ActionRecord } from '../src/git/actionLog';

const record = (args: string[], code = 0, ms = 10): ActionRecord => ({ at: Date.now(), args, code, ms });

describe('action log', () => {
  beforeEach(() => clearActions());

  it('keeps order and returns the newest first', () => {
    recordAction(record(['status']));
    recordAction(record(['fetch', 'origin']));
    recordAction(record(['push', 'origin', 'main']));

    assert.equal(allActions().length, 3);
    assert.deepEqual(
      recentActions(2).map((entry) => entry.args[0]),
      ['push', 'fetch']
    );
  });

  it('caps the buffer', () => {
    for (let index = 0; index < 320; index++) {
      recordAction(record(['rev-parse', String(index)]));
    }
    assert.equal(allActions().length, 300);
    assert.equal(allActions()[299].args[1], '319');
  });

  it('notifies subscribers', () => {
    const seen: string[] = [];
    const unsubscribe = subscribe((entry) => seen.push(entry.args[0]));
    recordAction(record(['commit']));
    unsubscribe();
    recordAction(record(['merge']));
    assert.deepEqual(seen, ['commit']);
  });

  it('separates read-only plumbing from mutating commands', () => {
    assert.equal(isMutating(['status']), false);
    assert.equal(isMutating(['diff', '--cached']), false);
    assert.equal(isMutating(['stash', 'list']), false);
    assert.equal(isMutating(['tag', '-l']), false);
    assert.equal(isMutating(['remote', '-v']), false);
    assert.equal(isMutating(['fetch', 'origin']), true);
    assert.equal(isMutating(['push']), true);
    assert.equal(isMutating(['stash', 'push']), true);
  });

  it('formats a line with exit code, duration and error', () => {
    assert.equal(formatAction(record(['fetch', 'origin'], 0, 120)), 'git fetch origin  → 0 (120 ms)');
    const failed = formatAction({ ...record(['push'], 1, 5), error: 'rejected\nmore' });
    assert.ok(failed.includes('→ 1'));
    assert.ok(failed.includes('✗ rejected'));
    assert.ok(!failed.includes('more'));
  });

  it('truncates long lines', () => {
    const text = formatAction(record(Array.from({ length: 60 }, (_, index) => `arg${index}`)), 40);
    assert.ok(text.length <= 40);
    assert.ok(text.endsWith('…'));
    assert.ok(shortLabel(record(['fetch', 'a-very-long-remote-name']), 12).endsWith('…'));
  });
});
