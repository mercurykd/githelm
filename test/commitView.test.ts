import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  firstParent,
  readCommitChanges,
  readCommitMeta,
  renderCommitScreen,
  resolveCommit,
  statusKind,
} from '../src/git/commitView';
import type { CommitMeta } from '../src/git/commitView';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

/**
 * A commit is a screen of its own now, the way a stash is: who wrote it, what it says and
 * the files it touched — and `d` on one of those rows is the editor's diff. The layout is
 * pure, so what a reader sees can be asserted without a window; the git readers are
 * asserted against a repository, because a rename and a root commit are git's answers, not
 * ours.
 */

const meta = (extra: Partial<CommitMeta> = {}): CommitMeta => ({
  sha: 'dc3ba5e1a2b3c4d5e6f708192a3b4c5d6e7f8091',
  shortSha: 'dc3ba5e',
  author: 'Test',
  email: 'test@example.com',
  date: '2026-11-21 12:00',
  subject: 'a commit',
  body: '',
  ...extra,
});

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('the commit screen', () => {
  it('opens with the sha and the subject, then who and when', () => {
    const lines = renderCommitScreen(meta(), [], 'файлы', 'd diff').text.split('\n');
    assert.equal(lines[0], 'dc3ba5e  a commit');
    assert.equal(lines[1], 'Author: Test <test@example.com>');
    assert.equal(lines[2], 'Date:   2026-11-21 12:00');
    assert.equal(lines[3], `commit ${meta().sha}`);
  });

  it('paints the sha, the title, the author and the date by role', () => {
    const { spans } = renderCommitScreen(meta(), [], 'файлы', 'd diff');
    const kinds = (line: number): string[] =>
      spans.filter((span) => span.line === line).map((span) => span.kind);
    assert.deepEqual(kinds(0), ['hash', 'title']);
    assert.deepEqual(kinds(1), ['meta', 'author']);
    assert.deepEqual(kinds(2), ['meta', 'date']);
    assert.deepEqual(kinds(3), ['meta', 'hash']);
  });

  it('prints the body under the header, indented, and only when there is one', () => {
    const plain = renderCommitScreen(meta(), [], 'файлы', 'd diff').text.split('\n');
    assert.equal(plain[4], '', 'no body: straight to the files');

    const withBody = renderCommitScreen(meta({ body: 'why\n\nhow' }), [], 'файлы', 'd diff').text.split('\n');
    assert.equal(withBody[4], '');
    assert.equal(withBody[5], '    why');
    assert.equal(withBody[6], '', 'a blank line of the body stays blank');
    assert.equal(withBody[7], '    how');
  });

  it('gives the list a header, a hint line and one row per file', () => {
    const screen = renderCommitScreen(
      meta(),
      [
        { status: 'M', path: 'src/app.ts' },
        { status: 'A', path: 'src/new.ts' },
        { status: 'D', path: 'gone.ts' },
      ],
      'файлы',
      'd diff   q close'
    );
    const lines = screen.text.split('\n');
    const header = lines.indexOf('## файлы (3)');
    assert.ok(header > 0, 'the list is titled and counted');
    assert.equal(lines[header + 1], '  d diff   q close');
    assert.equal(lines[header + 2], '');
    assert.equal(lines[header + 3], '  M src/app.ts');
    assert.equal(lines[header + 4], '  A src/new.ts');
    assert.equal(lines[header + 5], '  D gone.ts');
    // The header is part of the list, not a title over it: a click on it selects every row
    // under it, so the screen has to say which line it is — 1-based, like its rows.
    assert.equal(screen.header, header + 1);
    assert.deepEqual(
      screen.rows.map((row) => row.line),
      [header + 4, header + 5, header + 6]
    );
  });

  it('paints the status letter and the path, and leaves the row readable without them', () => {
    const screen = renderCommitScreen(meta(), [{ status: 'A', path: 'src/new.ts' }], 'файлы', 'd diff');
    const line = screen.text.split('\n').findIndex((text) => text === '  A src/new.ts');
    const kinds = screen.spans.filter((span) => span.line === line);
    assert.deepEqual(
      kinds.map((span) => [span.kind, span.start, span.end]),
      [
        ['file-added', 2, 3],
        ['path', 4, '  A src/new.ts'.length],
      ]
    );
  });

  it('names every row by line, one-based, so a key can find the file', () => {
    const screen = renderCommitScreen(
      meta(),
      [
        { status: 'M', path: 'a.ts' },
        { status: 'M', path: 'b.ts' },
      ],
      'файлы',
      'd diff'
    );
    assert.equal(screen.rows.length, 2);
    for (const row of screen.rows) {
      const line = screen.text.split('\n')[row.line - 1];
      assert.ok(line.endsWith(row.path), `${row.line} is the row of ${row.path}`);
    }
    assert.deepEqual(
      screen.rows.map((row) => row.path),
      ['a.ts', 'b.ts']
    );
  });

  it('colours an addition, a deletion and everything else apart', () => {
    assert.equal(statusKind('A'), 'file-added');
    assert.equal(statusKind('C'), 'file-added');
    assert.equal(statusKind('D'), 'file-deleted');
    assert.equal(statusKind('M'), 'file-modified');
    assert.equal(statusKind('R'), 'file-modified');
    assert.equal(statusKind('T'), 'file-modified');
  });

  it('says how many files it left out, and counts only the shown ones', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ status: 'M', path: `f${index}.ts` }));
    const screen = renderCommitScreen(meta(), many, 'файлы', 'd diff', 2);
    assert.ok(screen.text.includes('## файлы (2)'));
    assert.ok(screen.text.includes('… (ещё 3 файлов)'));
    assert.equal(screen.rows.length, 2);
  });
});

describe('reading a commit', () => {
  it('resolves a sha and a tag to the commit they name, and nothing else', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one' }, { 'a.txt': 'two' }] });
    const head = repo.git('rev-parse', 'HEAD').trim();
    repo.git('tag', 'annotated', '-m', 'a tag');
    repo.git('tag', 'light');
    assert.equal(await resolveCommit(repo.dir, 'HEAD'), head);
    assert.equal(await resolveCommit(repo.dir, head.slice(0, 8)), head);
    assert.equal(await resolveCommit(repo.dir, 'annotated'), head, 'an annotated tag is peeled');
    assert.equal(await resolveCommit(repo.dir, 'light'), head);
    assert.equal(await resolveCommit(repo.dir, 'no-such-ref'), undefined);
  });

  it('finds the first parent, and none for a root commit', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one' }, { 'a.txt': 'two' }] });
    const head = repo.git('rev-parse', 'HEAD').trim();
    const root = repo.git('rev-list', '--max-parents=0', 'HEAD').trim();
    assert.equal(await firstParent(repo.dir, head), root);
    assert.equal(await firstParent(repo.dir, root), undefined);
  });

  it('reads the metadata in one call, body and all', async () => {
    repo = createTempRepo();
    repo.write('a.txt', 'one');
    repo.git('add', '-A');
    repo.git(
      'commit',
      '--quiet',
      '--author=Ann Author <ann@example.com>',
      '-m',
      'the subject',
      '-m',
      'the body'
    );
    const read = await readCommitMeta(repo.dir, 'HEAD');
    assert.equal(read.sha, repo.git('rev-parse', 'HEAD').trim());
    assert.equal(read.shortSha, repo.git('rev-parse', '--short=7', 'HEAD').trim());
    assert.equal(read.author, 'Ann Author');
    assert.equal(read.email, 'ann@example.com');
    assert.equal(read.subject, 'the subject');
    assert.equal(read.body.trim(), 'the body');
    // The date is the user's format, not git's default.
    assert.match(read.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match((await readCommitMeta(repo.dir, 'HEAD', '%Y')).date, /^\d{4}$/);
  });

  it('lists the files against the parent, taking the new path of a rename', async () => {
    // A rename is only a rename when git says so: the file has to stay mostly itself, so
    // the fixture keeps twelve lines and edits one of them.
    const lines = Array.from({ length: 12 }, (_, index) => `const v${index} = ${index};`);
    repo = createTempRepo({ commits: [{ 'old.ts': `${lines.join('\n')}\n` }] });
    repo.git('mv', 'old.ts', 'new.ts');
    const edited = [...lines];
    edited[0] = 'const v0 = 99;';
    repo.write('new.ts', `${edited.join('\n')}\n`);
    repo.write('added.ts', 'x\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'second');
    const changes = await readCommitChanges(repo.dir, 'HEAD');
    assert.deepEqual(
      changes.map((change) => [change.status, change.path]),
      [
        ['A', 'added.ts'],
        ['R', 'new.ts'],
      ]
    );
  });

  it('reads a root commit as the additions it is', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one', 'b/c.txt': 'two' }] });
    const root = repo.git('rev-list', '--max-parents=0', 'HEAD').trim();
    const changes = await readCommitChanges(repo.dir, root);
    assert.deepEqual(
      changes.map((change) => change.status),
      ['A', 'A']
    );
    assert.deepEqual(
      changes.map((change) => change.path).sort(),
      ['a.txt', 'b/c.txt']
    );
  });
});
