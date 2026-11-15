import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommitTemplate, cleanCommitMessage } from '../src/git/commitMessage';
import { t } from '../src/i18n';
import { commitSpans } from '../src/util/span';
import { helpKeys, helpText } from '../src/views/helpText';

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

describe('helpText', () => {
  it('lists the status keys including commit and help', () => {
    const { entries } = helpKeys('status');
    const keys = entries.map((entry) => entry.key);
    for (const key of ['s', 'u', 'c', 'm', 'g', 'z', 'x', 'e', 't', 'h', 'q']) {
      assert.ok(keys.includes(key), `missing key ${key}`);
    }
  });

  it('pairs both worktree opening keys in the status help', () => {
    const { entries } = helpKeys('status');
    const keys = entries.map((entry) => entry.key);
    assert.ok(keys.includes('Shift+Enter'), 'new window');
    assert.ok(keys.includes('Alt+Enter'), 'this window');
    assert.ok(
      keys.indexOf('Alt+Enter') === keys.indexOf('Shift+Enter') + 1,
      'the two opening keys sit next to each other'
    );
  });

  it('gives every screen its own title', () => {
    assert.ok(helpText('log').includes('help: history'));
    assert.ok(helpText('status').includes('help: status'));
    assert.ok(helpText('diff-staged').includes('diff (staged)'));
  });

  it('lists c for checkout on branches, the key the hint line shows', () => {
    const keys = helpKeys('branches').entries.map((entry) => entry.key);
    assert.ok(keys.includes('c'), 'the c key is listed');
    assert.ok(!keys.includes('Enter'), 'the same command under two keys is listed once');
  });

  it('offers the graph key on every githelm screen', () => {
    for (const view of ['status', 'log', 'branches', 'tags', 'submodules']) {
      const keys = helpKeys(view).entries.map((entry) => entry.key);
      assert.ok(keys.includes('g'), `${view} lists g`);
    }
  });

  it('offers the tag key where a commit can be tagged', () => {
    for (const view of ['status', 'log', 'tags']) {
      const keys = helpKeys(view).entries.map((entry) => entry.key);
      assert.ok(keys.includes('t'), `${view} lists t`);
    }
    // The hint lines of every screen advertise both keys, and the tags *screen*
    // is a different one: `t tag` creates, `T tags` opens the list.
    assert.ok(t('hints.global').includes('t tag'), 'the status screen hints the tag key');
    assert.ok(t('log.keys').includes('t tag'), 'the graph hints the tag key');
    assert.ok(t('tags.keys').includes('t create'), 'the tags screen creates with t');
    assert.ok(!t('tags.keys').includes('n create'), 'and no longer with n');
    assert.ok(t('tags.keys').includes('U '), 'and it offers the push of the tag under the cursor');
    assert.ok(t('tags.keys').includes('D '), 'and the delete of the tag on the remote');
    assert.ok(helpKeys('tags').entries.some((entry) => entry.key === 'U'), 'the help of that screen lists it');
    assert.ok(helpKeys('tags').entries.some((entry) => entry.key === 'D'), 'and the remote delete as well');
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

  it('falls back to the status keys for an unknown screen', () => {
    assert.ok(helpText('nonsense').includes('help: status'));
  });

  it('mentions how to close the help buffer', () => {
    assert.ok(helpText('log').includes('closes this help'));
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
