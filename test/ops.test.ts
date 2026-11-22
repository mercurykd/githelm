import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  cherryPick,
  deleteBranch,
  listBranchEntries,
  renameBranch,
  setUpstream,
} from '../src/git/actions';
import { fileBlame, fileLog, repoRelativePath } from '../src/git/fileHistory';
import { addRemote, listRemotes, readUpstream, removeRemote, setRemoteUrl } from '../src/git/remotes';
import { applyStash, dropStash, listStashes, popStash, pushStash } from '../src/git/stash';
import { createTag, deleteTag, listTags, moveTag } from '../src/git/tags';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

/**
 * Wires up tracking without `git push`: pushing shells out to `sh`, which some
 * environments refuse to run. The refs and config it writes are exactly what
 * push -u would leave behind.
 */
async function linkUpstream(target: TempRepo, branch = 'main', remote = 'origin'): Promise<void> {
  await addRemote(target.dir, remote, 'https://example.com/repo.git');
  target.git('update-ref', `refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`);
  target.git('config', `branch.${branch}.remote`, remote);
  target.git('config', `branch.${branch}.merge`, `refs/heads/${branch}`);
}

describe('stash', () => {
  it('stashes tracked changes, and untracked ones only when asked', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    repo.write('a.txt', 'two\n');
    repo.write('untracked.txt', 'new\n');

    // The plain stash is the default of `z`: it leaves untracked files alone.
    await pushStash(repoPath, 'work in progress');
    assert.equal(repo.read('a.txt'), 'one\n');
    assert.ok(fs.existsSync(path.join(repoPath, 'untracked.txt')), 'a plain stash leaves untracked files');

    const stashes = await listStashes(repoPath);
    assert.equal(stashes.length, 1);
    assert.equal(stashes[0].ref, 'stash@{0}');
    assert.ok(stashes[0].subject.includes('work in progress'));

    await applyStash(repoPath, stashes[0].ref);
    assert.equal(repo.read('a.txt'), 'two\n');
    assert.equal(repo.read('untracked.txt'), 'new\n');
    assert.equal((await listStashes(repoPath)).length, 1, 'apply keeps the stash');

    await dropStash(repoPath, stashes[0].ref);
    assert.equal((await listStashes(repoPath)).length, 0);

    // `-u` is what takes the untracked file away with the stash.
    await pushStash(repoPath, 'with untracked', { includeUntracked: true });
    assert.equal(repo.read('a.txt'), 'one\n');
    assert.ok(!fs.existsSync(path.join(repoPath, 'untracked.txt')), '-u stashes the untracked file too');
  });

  it('stashes only the paths it is given', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n', 'b.txt': 'one\n' }] });
    const repoPath = repo.dir;
    repo.write('a.txt', 'two\n');
    repo.write('b.txt', 'two\n');

    await pushStash(repoPath, 'only a', { paths: ['a.txt'] });
    assert.equal(repo.read('a.txt'), 'one\n', 'the named file is stashed');
    assert.equal(repo.read('b.txt'), 'two\n', 'the other file is left alone');
  });

  it('stashes the index alone with --staged', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n', 'b.txt': 'one\n' }] });
    const repoPath = repo.dir;
    repo.write('a.txt', 'two\n');
    repo.write('b.txt', 'two\n');
    repo.git('add', 'b.txt');

    await pushStash(repoPath, 'index only', { staged: true });
    assert.equal(repo.read('a.txt'), 'two\n', 'an unstaged change stays in the working tree');
    assert.equal(repo.read('b.txt'), 'one\n', 'the staged change is stashed');
  });

  it('pops a stash and removes it from the list', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    repo.write('a.txt', 'two\n');

    await pushStash(repoPath, 'pop me');
    assert.equal((await listStashes(repoPath)).length, 1);

    await popStash(repoPath, 'stash@{0}');
    assert.equal(repo.read('a.txt'), 'two\n');
    assert.equal((await listStashes(repoPath)).length, 0);
  });
});

describe('tags', () => {
  it('creates, lists, moves and deletes', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await createTag(repoPath, 'v1.0.0');
    repo.write('a.txt', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'second');

    const tags = await listTags(repoPath);
    assert.deepEqual(tags.map((tag) => tag.name), ['v1.0.0']);
    assert.equal(tags[0].sha, repo.git('rev-parse', '--short', 'HEAD~1').trim());

    await moveTag(repoPath, 'v1.0.0');
    const moved = await listTags(repoPath);
    assert.equal(moved[0].sha, repo.git('rev-parse', '--short', 'HEAD').trim());

    await deleteTag(repoPath, 'v1.0.0');
    assert.deepEqual(await listTags(repoPath), []);
  });
});

describe('remotes', () => {
  it('adds, edits and removes a remote', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await addRemote(repoPath, 'origin', 'https://example.com/a.git');
    assert.deepEqual(await listRemotes(repoPath), [{ name: 'origin', url: 'https://example.com/a.git' }]);

    await setRemoteUrl(repoPath, 'origin', 'https://example.com/b.git');
    assert.equal((await listRemotes(repoPath))[0].url, 'https://example.com/b.git');

    await removeRemote(repoPath, 'origin');
    assert.deepEqual(await listRemotes(repoPath), []);
  });

  it('reports upstream divergence', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await linkUpstream(repo);

    const initial = await readUpstream(repoPath);
    assert.ok(initial);
    assert.equal(initial.ref, 'origin/main');
    assert.equal(initial.ahead, 0);
    assert.equal(initial.behind, 0);

    repo.write('a.txt', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'local only');

    const ahead = await readUpstream(repoPath);
    assert.equal(ahead?.ahead, 1);
    assert.equal(ahead?.behind, 0);
  });

  it('returns undefined without an upstream', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    assert.equal(await readUpstream(repo.dir), undefined);
  });
});

describe('branches', () => {
  it('lists local branches with tracking info', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await linkUpstream(repo);
    repo.git('branch', 'feature/x');

    const entries = await listBranchEntries(repoPath, false);
    const main = entries.find((entry) => entry.name === 'main');
    assert.ok(main?.current);
    assert.equal(main?.upstream, 'origin/main');
    assert.ok(entries.some((entry) => entry.name === 'feature/x'));

    const withRemote = await listBranchEntries(repoPath, true);
    assert.ok(withRemote.some((entry) => entry.isRemote && entry.name === 'origin/main'));
  });

  it('shows ahead of upstream', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await linkUpstream(repo);
    repo.write('a.txt', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'ahead');

    const main = (await listBranchEntries(repoPath, false)).find((entry) => entry.name === 'main');
    assert.equal(main?.ahead, 1);
    assert.equal(main?.behind, 0);
  });

  it('renames, sets upstream and deletes a branch', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    await linkUpstream(repo);

    repo.git('branch', 'old-name');
    await renameBranch(repoPath, 'old-name', 'new-name');
    await setUpstream(repoPath, 'new-name', 'origin/main');

    const renamed = (await listBranchEntries(repoPath, false)).find((entry) => entry.name === 'new-name');
    assert.ok(renamed);
    assert.equal(renamed.upstream, 'origin/main');

    await deleteBranch(repoPath, 'new-name');
    assert.ok(!(await listBranchEntries(repoPath, false)).some((entry) => entry.name === 'new-name'));
  });
});

describe('cherry-pick', () => {
  it('applies a commit from another branch', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    repo.git('checkout', '--quiet', '-b', 'side');
    repo.write('b.txt', 'from side\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'side change');
    const sideSha = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '--quiet', 'main');

    await cherryPick(repoPath, sideSha);
    assert.equal(repo.read('b.txt'), 'from side\n');
    assert.equal(repo.git('log', '-1', '--format=%s').trim(), 'side change');
  });
});

describe('file history', () => {
  it('builds a repository-relative path', () => {
    const root = path.join('C:', 'work', 'repo');
    assert.equal(repoRelativePath(root, path.join(root, 'sub', 'file.ts')), 'sub/file.ts');
  });

  it('renders file log and blame', async () => {
    repo = createTempRepo({ commits: [{ 'src/app.ts': 'one\n' }, { 'src/app.ts': 'two\n' }] });
    const repoPath = repo.dir;

    const log = (await fileLog(repoPath, 'src/app.ts')).text;
    assert.ok(log.includes('История файла: src/app.ts'));
    assert.ok(log.includes('2 коммитов'));

    // A blame is the file itself: its code, and a gutter of metadata beside it.
    const blame = await fileBlame(repoPath, 'src/app.ts');
    assert.equal(blame.text, 'two', 'the document is the file, not a rendering of it');
    assert.equal(blame.lines.length, 1);
    assert.ok(blame.lines[0].gutter.includes('Test'), 'the gutter carries the author');
    assert.equal(blame.lines[0].message, 'commit', 'and the message of the commit');
  });

  it('reads the messages of a blame from the repository, subject and body', async () => {
    repo = createTempRepo({ commits: [{ 'src/app.ts': 'one\n' }] });
    const repoPath = repo.dir;
    // The second line is committed with a message that has a body: the column has room for
    // the subject only, so the body is what the hover is for.
    repo.write('src/app.ts', 'one\ntwo\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'subject line for the second commit', '-m', 'and a body');

    const view = await fileBlame(repoPath, 'src/app.ts');
    assert.equal(view.text, 'one\ntwo', 'the code is the file, line for line');
    const [first, second] = view.lines;
    assert.equal(first.message, 'commit', 'the one-word message of the fixture commit');
    assert.equal(
      second.message,
      'subject line for the second commit\n\nand a body',
      'the whole message, body and all'
    );
    // The gutter has room for the subject only; the body is what the hover is for.
    assert.ok(first.gutter.includes('commit'), 'the subject is in the gutter');
    assert.ok(second.gutter.includes('subject line for'), 'and so is the one of the second commit');
    assert.ok(!second.gutter.includes('body'), 'the body is not: it belongs to the hover');
  });

  it('uses the same author column as the history graph', async () => {
    repo = createTempRepo({ commits: [{ 'src/app.ts': 'one\n' }] });
    const repoPath = repo.dir;
    repo.write('src/app.ts', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '--author=Ann Author <ann@example.com>', '-m', 'second');

    const lines = (await fileLog(repoPath, 'src/app.ts')).text.split('\n');
    const longAuthor = lines.find((line) => line.includes('second'));
    const shortAuthor = lines.find((line) => line.includes('commit'));
    assert.ok(longAuthor, 'row of the long author is present');
    assert.ok(shortAuthor, 'row of the short author is present');

    assert.equal(
      longAuthor.indexOf('second'),
      shortAuthor.indexOf('commit'),
      'subjects share one column'
    );
    assert.ok(longAuthor.includes('Ann Author  second'), 'two columns after the longest author');
    assert.ok(shortAuthor.includes(`${'Test'.padEnd(12)}commit`), 'short author padded to the column, not to 20');
    assert.ok(longAuthor.includes('(HEAD -> main)'), 'refs are wrapped once');
    assert.ok(!longAuthor.includes('( ('), 'no doubled parentheses from %d');
  });
});
