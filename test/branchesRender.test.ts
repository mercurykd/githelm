import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BranchEntry } from '../src/git/actions';
import { t } from '../src/i18n';
import { narrowHintColumn } from '../src/views/columns';
import { renderBranches } from '../src/views/branchesRender';

const BRANCHES: BranchEntry[] = [
  { name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 1, subject: 'latest work', isRemote: false },
  { name: 'feature/x', current: false, upstream: '', ahead: 0, behind: 0, subject: 'wip', isRemote: false },
  { name: 'origin/main', current: false, upstream: '', ahead: 0, behind: 0, subject: 'latest work', isRemote: true },
];

function lineIndexOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `line "${needle}" not found`);
  return index + 1;
}

describe('renderBranches', () => {
  it('marks the current branch and shows tracking divergence', () => {
    const rendered = renderBranches('/repo', BRANCHES, false);
    assert.ok(rendered.text.includes('* main'));
    assert.ok(rendered.text.includes('local'));
    assert.ok(rendered.text.includes('→ origin/main  +2 −1'));
    assert.ok(rendered.text.includes('feature/x'));
    assert.ok(rendered.text.includes('(нет upstream)') === false, 'only the current branch reports a missing upstream');
  });

  it('hides remote branches unless asked', () => {
    const hidden = renderBranches('/repo', BRANCHES, false);
    assert.ok(!hidden.text.includes('## remote'));
    assert.equal(hidden.targets.size, 2, 'only local branches are listed');

    const shown = renderBranches('/repo', BRANCHES, true);
    assert.ok(shown.text.includes('## remote: origin (1)'));
    assert.equal(shown.targets.size, 3);
  });

  it('maps entry lines to branch records', () => {
    const rendered = renderBranches('/repo', BRANCHES, true);
    const line = lineIndexOf(rendered.text, '* main');
    assert.equal(rendered.targets.get(line)?.name, 'main');
    assert.equal(rendered.targets.get(line)?.current, true);

    // The remote entry lives after the `## remote` header; the tracking label
    // on the local branch line also mentions "origin/main", so search after it.
    const remoteHeader = lineIndexOf(rendered.text, '## remote: origin');
    const remoteLine = rendered.text
      .split('\n')
      .findIndex((text, index) => index >= remoteHeader && text.includes('origin/main')) + 1;
    assert.ok(remoteLine > 0);
    assert.equal(rendered.targets.get(remoteLine)?.isRemote, true);
  });

  it('shows a subject line under each branch', () => {
    const rendered = renderBranches('/repo', BRANCHES, false);
    assert.ok(rendered.text.includes('    latest work'));
  });

  it('reports counts in the header', () => {
    const rendered = renderBranches('/repo', BRANCHES, true);
    assert.ok(rendered.text.includes('2 local, 1 remote'));
  });

  it('shows the branch git points at even when it has no commit yet', () => {
    // A fresh `git init` has an unborn HEAD: `refs/heads` is empty, but the branch
    // name exists in `.git/HEAD`, so the screen is not empty for no reason.
    const rendered = renderBranches(
      '/repo',
      [{ name: 'master', current: true, upstream: '', ahead: 0, behind: 0, subject: '', isRemote: false, unborn: true }],
      false
    );
    assert.ok(rendered.text.includes('* master'), rendered.text);
    assert.ok(rendered.text.includes(t('branches.unborn')), 'the row explains why it has no commits');
    assert.ok(!rendered.text.includes(t('branches.noUpstream')), 'an unborn branch reports no upstream');
    assert.equal(rendered.targets.size, 1, 'the row is still addressable');
  });

  it('packs its keys into the three lines every screen uses', () => {
    const rendered = renderBranches('/repo', BRANCHES, false);
    const column = narrowHintColumn();
    const hints = rendered.text
      .split('\n')
      .map((line) => (line.length > column ? line.slice(column).trim() : ''))
      .filter((text) => text.length > 0);
    assert.equal(hints.length, 4, 'the header plus three lines of keys');
    assert.equal(hints[0], 'keys');
    assert.ok(hints[3].includes('q close'), `the last line closes the list: ${hints[3]}`);
  });
});
