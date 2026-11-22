import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommitTemplate, cleanCommitMessage } from '../src/git/commitMessage';
import { t } from '../src/i18n';
import { commitSpans } from '../src/util/span';

describe('buildCommitTemplate', () => {
  it('starts with an empty message area', () => {
    const template = buildCommitTemplate([
      { section: 'staged', xy: 'M ', path: 'src/app.ts' },
      { section: 'staged', xy: 'A ', path: 'src/new.ts' },
    ]);
    assert.ok(template.startsWith('\n\n'), 'cursor must land in an empty message area');
  });

  it('lists staged files as comments', () => {
    const template = buildCommitTemplate([{ section: 'staged', xy: 'M ', path: 'src/app.ts' }]);
    assert.ok(template.includes('# Staged changes (1):'));
    assert.ok(template.includes('#   M  src/app.ts'));
  });

  it('warns when nothing is staged', () => {
    assert.ok(buildCommitTemplate([]).includes('No staged changes'));
  });
});

describe('cleanCommitMessage', () => {
  it('drops comment lines and trims blank edges', () => {
    const raw = '\n\nAdd feature\n\nbody line\n\n# comment\n#\n# Staged changes (1):\n';
    assert.equal(cleanCommitMessage(raw), 'Add feature\n\nbody line');
  });

  it('keeps a body that contains # not at the start', () => {
    assert.equal(cleanCommitMessage('subject\nsee issue #42'), 'subject\nsee issue #42');
  });

  it('returns an empty string for a template with no message', () => {
    const template = buildCommitTemplate([{ section: 'staged', xy: 'M ', path: 'a.ts' }]);
    assert.equal(cleanCommitMessage(template), '');
  });

  it('returns an empty string for blank input', () => {
    assert.equal(cleanCommitMessage('\n\n   \n'), '');
  });
});

/**
 * The hint line is the only place a key is announced, now that there is no help screen:
 * a key the screen answers to but does not print is a key nobody finds.
 */
describe('hint lines', () => {
  it('offers the compare key on branches', () => {
    assert.match(t('branches.keys'), /d compare/);
  });

  it('offers the graph key on every screen that has one', () => {
    const screens: Array<[string, string]> = [
      ['the status screen', t('hints.global')],
      ['the graph', t('log.keys')],
      ['branches', t('branches.keys')],
      ['tags', t('tags.keys')],
      ['submodules', t('submodules.keys')],
    ];
    for (const [name, hints] of screens) {
      assert.ok(hints.includes('g '), `${name} hints the graph key`);
    }
  });

  it('offers the tag key where a commit can be tagged', () => {
    // The hint lines of every screen advertise it, and the tags *screen* is a
    // different one: `t tag` creates, `T tags` opens the list.
    assert.ok(t('hints.global').includes('t tag'), 'the status screen hints the tag key');
    assert.ok(t('log.keys').includes('t tag'), 'the graph hints the tag key');
    assert.ok(t('tags.keys').includes('t create'), 'the tags screen creates with t');
    assert.ok(!t('tags.keys').includes('n create'), 'and no longer with n');
    assert.ok(t('tags.keys').includes('U '), 'and it offers the push of the tag under the cursor');
    assert.ok(t('tags.keys').includes('D '), 'and the delete of the tag on the remote');
  });

  it('advertises the tags screen on every screen that can open it', () => {
    // `T` is the tags screen everywhere except on the conflict screen, where it
    // takes "theirs" — the hint has to stay true there.
    const screens: Array<[string, string]> = [
      ['the status screen', t('hints.global')],
      ['the graph', t('log.keys')],
      ['branches', t('branches.keys')],
      ['tags', t('tags.keys')],
      ['submodules', t('submodules.keys')],
      ['the action log', t('actionLog.keys')],
      ['the diff', t('diff.keys')],
      ['the files of a stash', t('hints.stashFiles')],
    ];
    for (const [name, hints] of screens) {
      assert.ok(hints.includes('T '), `${name} hints the tags screen`);
    }
    const conflict = t('conflict.hints');
    assert.ok(conflict.includes('T theirs'), 'the conflict screen keeps T for its own action');
    assert.equal(conflict.includes('T tags'), false, 'so it does not advertise the tags screen under T');
  });

  it('no longer advertises a help screen', () => {
    // The screens are their own documentation: the hint line lists the keys, so `h`
    // is gone from every one of them along with the screen it opened.
    for (const hints of [
      t('hints.global'),
      t('log.keys'),
      t('branches.keys'),
      t('tags.keys'),
      t('submodules.keys'),
      t('actionLog.keys'),
      t('diff.keys'),
    ]) {
      assert.equal(/(^|\s)h /.test(hints), false, `a hint line still offers h: ${hints}`);
    }
  });
});

describe('commitSpans', () => {
  const text = [
    'commit abc123',
    'Author: A <a@b>',
    'Date: today',
    '',
    '    subject',
    '',
    'diff --git a/x b/x',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
  ].join('\n');

  it('marks the hash and metadata', () => {
    const spans = commitSpans(text);
    assert.ok(spans.some((span) => span.kind === 'hash' && span.line === 0 && span.start === 7));
    assert.ok(spans.some((span) => span.kind === 'meta' && span.line === 1));
  });

  it('marks patch lines', () => {
    const kinds = commitSpans(text).map((span) => span.kind);
    assert.ok(kinds.includes('hunk'));
    assert.ok(kinds.includes('add'));
    assert.ok(kinds.includes('del'));
  });

  it('does not mark empty lines', () => {
    const spans = commitSpans(text);
    assert.ok(!spans.some((span) => span.line === 3 || span.line === 5));
  });
});
