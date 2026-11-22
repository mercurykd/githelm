import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Submodule } from '../src/git/submodules';
import { buildSubmodulesModel } from '../src/webview/model/submodules';

/**
 * The panel's submodules screen has to say exactly what the text buffer says about a
 * submodule — same marker, same columns, same notes — so these tests read the rows the
 * way the client renders them: a marker, a path, then the commit and the note.
 */
const SUBS: Submodule[] = [
  { path: 'libs/clean', sha: '7d1d1b7', state: 'ok', describe: 'v1.2.0' },
  { path: 'libs/ahead', sha: 'abcdef1', state: 'modified' },
  { path: 'libs/missing', sha: '1234567', state: 'uninitialized' },
  { path: 'libs/conflict', sha: 'deadbee', state: 'conflict' },
];

describe('buildSubmodulesModel', () => {
  it('lists every submodule with the buffer markers and notes', () => {
    const model = buildSubmodulesModel('/repo', SUBS);
    const rows = model.blocks[0].rows;
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => [row.marker, row.text]),
      [
        [' ', 'libs/clean'],
        ['+', 'libs/ahead'],
        ['-', 'libs/missing'],
        ['U', 'libs/conflict'],
      ]
    );
    assert.equal(rows[0].parts?.[0].text, '7d1d1b7');
    assert.equal(rows[0].parts?.[1].text, 'v1.2.0', 'a describe is the note when git has one');
    assert.equal(rows[1].parts?.[1], undefined, 'a modified submodule has nothing to add');
    assert.equal(rows[2].parts?.[1].text, 'not initialized');
    assert.equal(rows[3].parts?.[1].text, 'conflict');
  });

  it('paints the marker with the colour of its state, not of the whole row', () => {
    const model = buildSubmodulesModel('/repo', SUBS);
    const [clean, ahead, missing, conflict] = model.blocks[0].rows;
    assert.equal(clean.markerRole, 'added');
    assert.equal(ahead.markerRole, 'branch');
    assert.equal(missing.markerRole, 'deleted');
    assert.equal(conflict.markerRole, 'deleted');
    // The path itself stays readable, as the buffer leaves it in the editor foreground.
    for (const row of model.blocks[0].rows) {
      assert.equal(row.role, 'plain');
    }
  });

  it('counts the states in the summary', () => {
    const model = buildSubmodulesModel('/repo', SUBS);
    const summary = model.facts[0].value;
    assert.ok(summary.includes('4 submodules'), summary);
    assert.ok(summary.includes('1 up to date'), summary);
    assert.ok(summary.includes('1 at another commit'), summary);
    assert.ok(summary.includes('1 not initialized'), summary);
    assert.ok(summary.includes('1 in conflict'), summary);
  });

  it('explains an unavailable list instead of claiming there are none', () => {
    const model = buildSubmodulesModel('/repo', [], '\n\nsh: pipe refused\nsecond line');
    assert.ok(model.facts[0].value.includes('unavailable'), model.facts[0].value);
    assert.ok(model.facts[1].value.includes('reason: sh: pipe refused'), model.facts[1].value);
    assert.ok(!model.facts.some((fact) => fact.value.includes('second line')), 'only one sentence');
    assert.equal(model.blocks[0].rows.length, 0);
    assert.ok(model.blocks[0].empty?.includes('cannot list them'), model.blocks[0].empty);
  });

  it('says so when there are none', () => {
    const model = buildSubmodulesModel('/repo', []);
    assert.ok(model.facts[0].value.includes('no submodules'), model.facts[0].value);
    assert.equal(model.blocks[0].rows.length, 0);
  });

  it('is a list screen, with the buffer’s key line', () => {
    const model = buildSubmodulesModel('/repo', SUBS);
    assert.equal(model.kind, 'submodules');
    assert.ok(model.title.includes('/repo'));
    const keys = model.hints.map((hint) => hint.keys).join(' ');
    for (const key of ['enter', 'u', 'U', 'g', 'T', 'r', 'q']) {
      assert.ok(keys.split(/\s+/).includes(key), key);
    }
    assert.ok(!/^h\s/.test(keys), 'no help key');
    assert.ok(model.selectFirst.length > 0);
  });
});
