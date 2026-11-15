import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createTag, deleteTag, listTags, tagCreateArgs } from '../src/git/tags';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('tagCreateArgs', () => {
  it('makes a lightweight tag on HEAD when nothing else is said', () => {
    assert.deepEqual(tagCreateArgs('v1.0.0'), ['tag', 'v1.0.0']);
  });

  it('puts the ref of the commit last, so the tag lands on it', () => {
    assert.deepEqual(tagCreateArgs('v1.0.0', undefined, 'abc1234'), ['tag', 'v1.0.0', 'abc1234']);
  });

  it('makes an annotated tag when there is a message', () => {
    assert.deepEqual(tagCreateArgs('v1.0.0', 'release'), ['tag', '-a', 'v1.0.0', '-m', 'release']);
    assert.deepEqual(tagCreateArgs('v1.0.0', ' release ', 'abc1234'), [
      'tag',
      '-a',
      'v1.0.0',
      '-m',
      'release',
      'abc1234',
    ]);
  });

  it('treats a blank message as no message at all', () => {
    assert.deepEqual(tagCreateArgs('v1.0.0', '   '), ['tag', 'v1.0.0']);
  });
});

describe('createTag on a chosen commit', () => {
  it('tags the commit it is given, not HEAD', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' }] });
    const repoPath = repo.dir;
    const first = repo.git('rev-parse', 'HEAD~1').trim();
    const head = repo.git('rev-parse', 'HEAD').trim();
    assert.notEqual(first, head);

    await createTag(repoPath, 'v0.1.0', undefined, first);

    const entries = await listTags(repoPath);
    const tag = entries.find((entry) => entry.name === 'v0.1.0');
    assert.ok(tag, 'the tag is on the tags screen');
    assert.equal(repo.git('rev-parse', 'v0.1.0^{commit}').trim(), first, 'the tag points at the first commit');
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), head, 'and HEAD did not move');
  });

  it('accepts an abbreviated sha, which is what the graph row shows', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' }] });
    const repoPath = repo.dir;
    const first = repo.git('rev-parse', 'HEAD~1').trim();
    await createTag(repoPath, 'v0.1.0', undefined, first.slice(0, 7));
    assert.equal(repo.git('rev-parse', 'v0.1.0^{commit}').trim(), first);
  });

  it('refuses a name git does not accept, with git’s own message', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await assert.rejects(() => createTag(repoPath, 'bad name', undefined, 'HEAD'), /not a valid tag name|fatal/i);
  });

  it('deletes the tag it made, so the key pair is complete', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await createTag(repoPath, 'v0.1.0', undefined, 'HEAD');
    assert.equal((await listTags(repoPath)).length, 1);
    await deleteTag(repoPath, 'v0.1.0');
    assert.equal((await listTags(repoPath)).length, 0);
  });
});
