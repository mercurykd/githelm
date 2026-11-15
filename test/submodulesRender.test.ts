import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Submodule } from '../src/git/submodules';
import { renderSubmodules } from '../src/views/submodulesRender';

const SUBS: Submodule[] = [
  { path: 'libs/clean', sha: '7d1d1b7', state: 'ok', describe: 'v1.2.0' },
  { path: 'libs/ahead', sha: 'abcdef1', state: 'modified' },
  { path: 'libs/missing', sha: '1234567', state: 'uninitialized' },
  { path: 'libs/conflict', sha: 'deadbee', state: 'conflict' },
];

describe('renderSubmodules', () => {
  it('lists every submodule with its marker and commit', () => {
    const rendered = renderSubmodules('/repo', SUBS);
    const lines = rendered.text.split('\n');
    assert.ok(lines[0].includes('submodules'));
    assert.ok(lines[0].includes('/repo'));
    assert.ok(lines.some((line) => line.includes(' libs/clean  7d1d1b7  v1.2.0')));
    assert.ok(lines.some((line) => line.includes('+ libs/ahead  abcdef1')));
    assert.ok(lines.some((line) => line.includes('- libs/missing  1234567  not initialized')));
    assert.ok(lines.some((line) => line.includes('U libs/conflict  deadbee  conflict')));
  });

  it('counts the states in the summary line', () => {
    const rendered = renderSubmodules('/repo', SUBS);
    const summary = rendered.text.split('\n')[1];
    assert.ok(summary.includes('4 submodules'), summary);
    assert.ok(summary.includes('1 up to date'), summary);
    assert.ok(summary.includes('1 at another commit'), summary);
    assert.ok(summary.includes('1 not initialized'), summary);
    assert.ok(summary.includes('1 in conflict'), summary);
  });

  it('explains an unavailable list instead of claiming there are none', () => {
    const rendered = renderSubmodules('/repo', [], '\n\nsh: pipe refused\nsecond line');
    assert.ok(rendered.text.includes('unavailable'), rendered.text);
    assert.ok(rendered.text.includes('reason: sh: pipe refused'));
    assert.ok(!rendered.text.includes('second line'), 'only the first line of the error is shown');
    assert.ok(!rendered.text.includes('no submodules'));
    assert.equal(rendered.targets.size, 0);
  });

  it('keeps a long error on one truncated line', () => {
    const rendered = renderSubmodules('/repo', [], 'x'.repeat(400));
    const line = rendered.text.split('\n').find((candidate) => candidate.includes('reason:'));
    assert.ok(line, rendered.text);
    // The key hints share the line, so the message is what sits before them.
    const [reason] = line!.trimEnd().split(/\s{3,}/);
    assert.ok(reason.length <= 140, reason);
    assert.ok(reason.endsWith('…'), 'the cut is marked');
    assert.ok(!reason.includes('x'.repeat(150)), 'a whole paragraph is not pasted in');
  });

  it('says so when there are none', () => {
    const rendered = renderSubmodules('/repo', []);
    assert.ok(rendered.text.includes('no submodules'));
    assert.equal(rendered.targets.size, 0);
  });

  it('maps each row to its submodule for the cursor commands', () => {
    const rendered = renderSubmodules('/repo', SUBS);
    const lines = rendered.text.split('\n');
    const index = lines.findIndex((line) => line.includes('libs/ahead'));
    assert.deepEqual(rendered.targets.get(index + 1), {
      path: 'libs/ahead',
      sha: 'abcdef1',
      state: 'modified',
    });
  });

  it('shows the keys of this screen next to the entry hints', () => {
    const rendered = renderSubmodules('/repo', SUBS);
    assert.ok(rendered.text.includes('u update'));
    assert.ok(rendered.text.includes('U update from remote'));
    assert.ok(rendered.text.includes('r refresh'));
  });
});
