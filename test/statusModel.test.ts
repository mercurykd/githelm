import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RepoStatus } from '../src/git/status';
import { buildStatusModel, fileTargetsOf, pathsOf, rowId, rowOrder, sectionsOf } from '../src/webview/model/status';
import { parseHints } from '../src/webview/model/hints';

const STATUS: RepoStatus = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  head: 'abc1234',
  headSubject: 'Fix the thing',
  entries: [
    { section: 'staged', xy: 'M ', path: 'src/app.ts' },
    { section: 'unstaged', xy: ' M', path: 'src/util.ts' },
    { section: 'untracked', xy: '??', path: 'notes.md' },
    { section: 'untracked', xy: '??', path: 'README.md' },
  ],
};

const input = {
  repoPath: '/repo',
  status: STATUS,
  remotes: [{ name: 'origin', url: 'git@example.com:me/repo.git' }],
  remote: { name: 'origin', url: 'git@example.com:me/repo.git' },
  stashes: [{ ref: 'stash@{0}', subject: 'WIP on main' }],
  commits: [
    {
      sha: '9a7e4eb0000000000000000000000000000000000',
      shortSha: '9a7e4eb',
      date: '2026-11-13 16:07',
      author: 'mercury',
      subject: 'fix the thing',
    },
  ],
  worktrees: [],
};

describe('status model', () => {
  it('keeps the three always-on sections in order and sorts rows by path', () => {
    const model = buildStatusModel(input);
    assert.deepEqual(
      model.sections.map((section) => section.kind),
      ['staged', 'unstaged', 'untracked']
    );
    assert.deepEqual(
      model.sections[2].rows.map((row) => row.path),
      ['README.md', 'notes.md'],
      'sorted by path, not by the order git printed'
    );
  });

  it('shows conflicts only when there are some', () => {
    assert.equal(buildStatusModel(input).sections.some((section) => section.kind === 'conflict'), false);
    const withConflict = buildStatusModel({
      ...input,
      status: { ...STATUS, entries: [...STATUS.entries, { section: 'conflict', xy: 'UU', path: 'both.ts' }] },
    });
    assert.equal(withConflict.sections[0].kind, 'conflict', 'and puts them first');
  });

  it('gives every row a stable id and keeps the porcelain code readable', () => {
    const row = buildStatusModel(input).sections[0].rows[0];
    assert.equal(row.id, 'staged:src/app.ts');
    assert.equal(rowId({ section: 'staged', path: 'src/app.ts' }), row.id);
    assert.equal(row.xy, 'M ');
    assert.equal(row.code, 'M');
    // The code is painted by its letter and the path by its section, as in the buffer.
    assert.equal(row.codeRole, 'modified');
    assert.equal(row.pathRole, 'staged');
    const untracked = buildStatusModel(input).sections[2].rows[0];
    assert.equal(untracked.code, '??');
    assert.equal(untracked.codeRole, 'added', 'a `??` code is the green of "added"');
    assert.equal(untracked.pathRole, 'untracked', 'while its path keeps the section colour');
  });

  it('names the branch and the head in the header, and the repository in its title', () => {
    const model = buildStatusModel(input);
    const values = Object.fromEntries(model.facts.map((fact) => [fact.label, fact]));
    assert.equal(model.title, '/repo — status', 'the header says which screen this is');
    assert.deepEqual(
      model.facts.map((fact) => fact.label),
      ['BRANCH:', 'HEAD:'],
      'and the block under it is the branch and the head, nothing else',
    );
    assert.equal(values['BRANCH:'].value, 'main');
    assert.equal(values['BRANCH:'].role, 'branch');
    assert.equal(values['HEAD:'].value, 'abc1234');
    assert.equal(values['HEAD:'].role, 'hash');
    assert.equal(values['HEAD:'].parts?.[0].text, 'Fix the thing');
    assert.equal(values['HEAD:'].parts?.[0].role, 'meta');
  });

  it('marks the head as secondary when there is no commit yet', () => {
    const unborn = buildStatusModel({
      ...input,
      status: { branch: 'master', ahead: 0, behind: 0, entries: [] },
      remotes: [],
    });
    const facts = Object.fromEntries(unborn.facts.map((fact) => [fact.label, fact]));
    assert.equal(facts['HEAD:'].muted, true);
    assert.equal(facts['HEAD:'].value, '(no commits yet)');
  });

  it('shows the divergence of the upstream next to the branch', () => {
    const model = buildStatusModel({ ...input, upstream: { ref: 'origin/main', ahead: 2, behind: 1 } });
    assert.equal(model.facts[0].value, 'main');
    // The tail is split the way the buffer splits it: ref, then the two counters.
    assert.deepEqual(model.facts[0].parts, [
      { text: 'origin/main:', role: 'upstream', gap: 2 },
      { text: '+2', role: 'added', gap: 1 },
      { text: '−1', role: 'deleted', gap: 1 },
    ]);
  });

  it('prints the tracking counts when there is no upstream to compare with', () => {
    const model = buildStatusModel({
      ...input,
      upstream: undefined,
      status: { ...input.status, ahead: 1, behind: 2 },
    });
    assert.deepEqual(model.facts[0].parts, [{ text: '(ahead 1, behind 2)', role: 'meta', gap: 2 }]);
  });

  it('lists remotes, worktrees and stashes in one column, in that order', () => {
    const model = buildStatusModel(input);
    assert.deepEqual(
      model.column.map((block) => block.title),
      ['remotes', 'worktrees', 'stash']
    );
    assert.equal(model.column[0].rows[0].text, 'origin');
    assert.equal(model.column[1].rows.length, 0);
    assert.equal(model.column[2].rows[0].detail, 'WIP on main');
  });

  it('gives every block its own key line, as the text buffer does', () => {
    const model = buildStatusModel(input);
    // The buffer's own key lines, so the panel looks like the buffer; a key this
    // screen cannot run answers with a toast instead of doing nothing.
    assert.deepEqual(model.sections[0].hints.map((hint) => hint.keys), ['s', 'u', 'd', 'D', 'i', 'enter']);
    assert.deepEqual(model.column[0].hints.map((hint) => hint.keys), ['A', 'e', 'x', 'f', 'P', 'U']);
    assert.deepEqual(model.commits.hints.map((hint) => hint.keys), ['enter', 'n', 'c', 'C', 'V', 'f', 'R', 't', 'g']);
    assert.deepEqual(model.hints.map((hint) => hint.keys), ['c', 'm', 'alt+s', 'alt+u', 'R', 'b', 't', 'T', 'S', 'F', 'l', 'r', 'q']);
  });

  it('prints the last commits with short sha, date, author and subject', () => {
    const block = buildStatusModel(input).commits;
    assert.equal(block.title, 'last commits');
    assert.deepEqual(block.rows[0], {
      id: 'commit:9a7e4eb0000000000000000000000000000000000',
      sha: '9a7e4eb',
      date: '2026-11-13 16:07',
      author: 'mercury',
      refs: '',
      subject: 'fix the thing',
    });
    assert.equal(block.authorWidth, 7, 'the author column is measured for the row grids');
  });

  it('lists the local branches beside the commits, with the branches screen’s row', () => {
    const model = buildStatusModel({
      ...input,
      branches: [
        {
          name: 'main',
          current: true,
          upstream: 'origin/main',
          ahead: 2,
          behind: 0,
          subject: 'fix the thing',
          isRemote: false,
        },
        { name: 'topic', current: false, upstream: '', ahead: 0, behind: 0, subject: 'new feature', isRemote: false },
      ],
    });
    assert.equal(model.branches.title, 'branches');
    assert.deepEqual(
      model.branches.rows.map((row) => row.id),
      ['branch:main', 'branch:topic']
    );
    assert.equal(model.branches.rows[0].marker, '*', 'the current branch is marked as on the branches screen');
    assert.equal(model.branches.rows[1].marker, ' ');
    assert.equal(model.branches.rows[0].note, 'fix the thing');
    assert.match(model.branches.rows[0].parts?.[0].text ?? '', /origin\/main/);
    assert.deepEqual(
      model.branches.hints.map((hint) => hint.keys),
      ['enter', 'n', 'm', 'R', 'G'],
      'the block advertises its own reading of the keys'
    );
  });

  it('says there are no local branches instead of drawing an empty block', () => {
    const model = buildStatusModel(input);
    assert.deepEqual(model.branches.rows, []);
    assert.equal(model.branches.empty, 'no local branches');
  });

  it('puts the tags and branches of a commit on its own row', () => {
    // `v0.0.4` on the head commit is how a release is told from a plain commit, so the
    // block carries the refs `git log` reports, in the buffer's own notation.
    const block = buildStatusModel({
      ...input,
      commits: [
        { shortSha: '9a7e4eb', date: '2026-11-13 16:07', author: 'mercury', subject: 'release', refs: ['HEAD -> main', 'tag: v0.0.4'] },
        { shortSha: '1b2c3d4', date: '2026-11-12 09:00', author: 'mercury', subject: 'plain', refs: [] },
      ],
    }).commits;
    assert.equal(block.rows[0].refs, '[HEAD -> main tag: v0.0.4]');
    assert.equal(block.rows[1].refs, '', 'a commit with no ref prints no brackets');
  });

  it('turns rows into the file targets the discard planner expects', () => {
    const model = buildStatusModel(input);
    const targets = fileTargetsOf(model, ['unstaged:src/util.ts', 'staged:src/app.ts']);
    assert.deepEqual(
      targets.map((target) => [target.section, target.path, target.entry.xy]),
      [
        ['staged', 'src/app.ts', 'M '],
        ['unstaged', 'src/util.ts', ' M'],
      ]
    );
    assert.ok(targets.every((target) => target.kind === 'file'));
    assert.deepEqual(fileTargetsOf(model, ['gone']), []);
  });

  it('carries the hint shown when a key needs a selection', () => {
    assert.match(buildStatusModel(input).selectFirst, /Select|выбер|选择/);
    assert.match(buildStatusModel(input).notImplemented, /panel|панели|面板/);
  });

  it('parses the key hints into keys and labels', () => {
    assert.deepEqual(parseHints('c commit   alt+s stage all'), [
      { keys: 'c', label: 'commit' },
      { keys: 'alt+s', label: 'stage all' },
    ]);
    assert.ok(buildStatusModel(input).hints.length > 5, 'the screen carries the global hints');
  });

  it('maps ids back to paths and sections for the actions', () => {
    const model = buildStatusModel(input);
    const ids = ['untracked:notes.md', 'staged:src/app.ts'];
    assert.deepEqual(pathsOf(model, ids), ['src/app.ts', 'notes.md'], 'model order, no duplicates');
    assert.deepEqual([...sectionsOf(model, ids)].sort(), ['staged', 'untracked']);
    assert.deepEqual(rowOrder(model), [
      'staged:src/app.ts',
      'unstaged:src/util.ts',
      'untracked:README.md',
      'untracked:notes.md',
    ]);
    assert.deepEqual(pathsOf(model, ['gone']), []);
  });
});
