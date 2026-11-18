import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hintEntries, keySegments } from '../src/views/columns';

const KEYS = 'enter open   s stage   u unstage   d diff   D discard   i ignore   r refresh   h help   q close';

describe('keySegments', () => {
  it('splits the hints on the runs of spaces that separate them', () => {
    assert.deepEqual(keySegments('a one   b two'), ['a one', 'b two']);
    assert.deepEqual(keySegments('  single  '), ['single']);
    assert.deepEqual(keySegments(''), []);
  });
});

describe('hintEntries', () => {
  it('packs the hints into three lines, whatever the number of keys', () => {
    // The key column of every screen is three lines tall: nine keys become three
    // hints per line, not five lines of two.
    const entries = hintEntries(KEYS, 'keys');
    assert.equal(entries[0].text, 'keys');
    assert.equal(entries.length, 4, 'header plus three lines');
    assert.equal(entries[3].text.trim().split(/\s{3}/).length, 3, 'the last line holds the rest');
    for (const entry of entries.slice(1)) {
      assert.ok(entry.text.startsWith('  '), `hint lines are indented: ${entry.text}`);
    }
  });

  it('leaves a short hint on one line', () => {
    const entries = hintEntries('d diff   q close', 'keys');
    assert.equal(entries.length, 2);
    assert.equal(entries[1].text.trim(), 'd diff   q close');
  });

  it('takes the number of lines as an argument', () => {
    assert.equal(hintEntries(KEYS, 'keys', 1).length, 2, 'everything on one line');
    assert.equal(hintEntries(KEYS, 'keys', 9).length, 10, 'or one key per line');
  });
});
