import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { amendCommit, createFixupCommit, hasStagedChanges, headMessage, parentOf } from '../src/git/rewrite';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

// `git commit` needs an identity; the library code inherits process.env.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('hasStagedChanges', () => {
  it('is false on a clean repository', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    assert.equal(await hasStagedChanges(repo.dir), false);
  });

  it('is true after staging a modification', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('a.txt', 'two\n');
    repo.git('add', 'a.txt');
    assert.equal(await hasStagedChanges(repo.dir), true);
  });

  it('is false when changes exist but are not staged', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.write('a.txt', 'two\n');
    assert.equal(await hasStagedChanges(repo.dir), false);
  });
});

describe('headMessage', () => {
  it('returns the full message, not just the subject', async () => {
    repo = createTempRepo();
    repo.write('a.txt', 'one\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'subject line', '-m', 'body line');

    const message = await headMessage(repo.dir);
    assert.ok(message?.startsWith('subject line'));
    assert.ok(message?.includes('body line'));
    assert.ok(!message?.endsWith('\n\n'));
  });

  it('returns undefined in an empty repository', async () => {
    repo = createTempRepo();
    assert.equal(await headMessage(repo.dir), undefined);
  });
});

describe('createFixupCommit', () => {
  it('creates a fixup commit targeting the requested commit', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'b.txt': 'two\n' }] });
    const target = repo.git('rev-parse', 'HEAD~1').trim();
    const targetSubject = repo.git('log', '-1', '--format=%s', target).trim();

    repo.write('a.txt', 'one changed\n');
    repo.git('add', 'a.txt');

    const fixupSha = await createFixupCommit(repo.dir, target);
    assert.equal(fixupSha, repo.git('rev-parse', 'HEAD').trim());
    assert.equal(repo.git('log', '-1', '--format=%s').trim(), `fixup! ${targetSubject}`);
    assert.equal(repo.git('rev-parse', 'HEAD~1').trim(), repo.git('rev-parse', 'HEAD~1').trim());
  });

  it('fails when nothing is staged', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const head = repo.git('rev-parse', 'HEAD').trim();
    await assert.rejects(createFixupCommit(repo.dir, head), /зафиксировать|no changes|nothing to commit/i);
  });
});

describe('parentOf', () => {
  it('returns the parent commit', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'b.txt': 'two\n' }] });
    const head = repo.git('rev-parse', 'HEAD').trim();
    assert.equal(await parentOf(repo.dir, head), repo.git('rev-parse', 'HEAD~1').trim());
  });

  it('rejects the root commit', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const root = repo.git('rev-list', '--max-parents=0', 'HEAD').trim();
    await assert.rejects(parentOf(repo.dir, root), /корневого коммита/);
  });
});

describe('amendCommit', () => {
  it('rewrites the message and keeps staged content', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const oldSha = repo.git('rev-parse', 'HEAD').trim();

    repo.write('a.txt', 'one plus\n');
    repo.git('add', 'a.txt');
    await amendCommit(repo.dir, 'amended subject\n\namended body');

    assert.notEqual(repo.git('rev-parse', 'HEAD').trim(), oldSha);
    assert.equal(repo.git('log', '-1', '--format=%s').trim(), 'amended subject');
    assert.equal(repo.readIndex('a.txt'), 'one plus\n');
    assert.equal(repo.git('status', '--porcelain').trim(), '');
  });
});
