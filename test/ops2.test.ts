import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  abortPendingOperation,
  deleteRemoteBranch,
  fetchArgs,
  fetchRemote,
  mergeRef,
  pendingOperation,
  pullArgs,
  pushArgs,
  renameRemote,
  resetArgs,
  resetTo,
  revertCommit,
} from '../src/git/ops';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('argument builders', () => {
  it('builds push arguments', () => {
    assert.deepEqual(pushArgs('origin', 'main'), ['push', 'origin', 'main']);
    assert.deepEqual(pushArgs('origin', 'main', { force: true }), ['push', '--force-with-lease', 'origin', 'main']);
    assert.deepEqual(pushArgs('origin', undefined, { tags: true, setUpstream: true }), [
      'push',
      '--tags',
      '--set-upstream',
      'origin',
    ]);
  });

  it('sends a plain --force when the hard force is the one that was picked', () => {
    assert.deepEqual(pushArgs('origin', 'main', { forceHard: true }), ['push', '--force', 'origin', 'main']);
    // `--force` already disables the lease checks, so both flags never travel together.
    assert.deepEqual(pushArgs('origin', 'main', { force: true, forceHard: true, tags: true }), [
      'push',
      '--force',
      '--tags',
      'origin',
      'main',
    ]);
  });

  it('builds fetch arguments', () => {
    assert.deepEqual(fetchArgs(undefined), ['fetch']);
    assert.deepEqual(fetchArgs('origin', { prune: true, tags: true }), ['fetch', '--prune', '--tags', 'origin']);
  });

  it('builds pull arguments', () => {
    assert.deepEqual(pullArgs(undefined), ['pull']);
    assert.deepEqual(pullArgs('origin', { rebase: true }), ['pull', '--rebase', 'origin']);
    assert.deepEqual(pullArgs('origin', { ffOnly: true }), ['pull', '--ff-only', 'origin']);
  });

  it('builds reset arguments for every mode', () => {
    assert.deepEqual(resetArgs('soft', 'HEAD~1'), ['reset', '--soft', 'HEAD~1']);
    assert.deepEqual(resetArgs('mixed', 'HEAD~1'), ['reset', '--mixed', 'HEAD~1']);
    assert.deepEqual(resetArgs('hard', 'HEAD~1'), ['reset', '--hard', 'HEAD~1']);
  });
});

describe('reset', () => {
  it('moves HEAD and keeps the working tree for soft, discards it for hard', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'b.txt': 'two\n' }] });
    const repoPath = repo.dir;
    const first = repo.git('rev-parse', 'HEAD~1').trim();

    repo.write('b.txt', 'changed\n');
    await resetTo(repoPath, 'soft', first);
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), first);
    assert.equal(repo.read('b.txt'), 'changed\n', 'soft keeps working tree');

    repo.git('reset', '--hard', 'HEAD');
    await resetTo(repoPath, 'hard', first);
    assert.equal(repo.git('status', '--porcelain').trim(), '');
  });
});

describe('merge', () => {
  it('detects an in-progress merge and aborts it', async () => {
    repo = createTempRepo({ commits: [{ 'file.txt': 'base\n' }] });
    const repoPath = repo.dir;
    repo.git('checkout', '--quiet', '-b', 'side');
    repo.write('file.txt', 'side\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'side');
    repo.git('checkout', '--quiet', 'main');
    repo.write('file.txt', 'main\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'main');

    assert.equal(await pendingOperation(repoPath), undefined);
    await assert.rejects(mergeRef(repoPath, 'side'), /конфликт|merge/i);
    assert.equal(await pendingOperation(repoPath), 'merge');

    assert.equal(await abortPendingOperation(repoPath), 'merge');
    assert.equal(await pendingOperation(repoPath), undefined);
    assert.equal(repo.read('file.txt'), 'main\n');
  });

  it('fast-forwards when there is no divergence', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    repo.git('checkout', '--quiet', '-b', 'side');
    repo.write('b.txt', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'side');
    const sideSha = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '--quiet', 'main');

    await mergeRef(repoPath, 'side');
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), sideSha);
  });
});

describe('revert', () => {
  it('adds a commit that undoes the chosen one', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' }] });
    const repoPath = repo.dir;
    const target = repo.git('rev-parse', 'HEAD').trim();

    await revertCommit(repoPath, target);

    assert.equal(repo.read('a.txt'), 'one\n', 'the change of the reverted commit is gone');
    assert.match(repo.git('log', '-1', '--format=%s').trim(), /^Revert/);
    assert.equal(repo.git('rev-list', '--count', 'HEAD').trim(), '3', 'the revert is a new commit');
    assert.equal(await pendingOperation(repoPath), undefined, 'a clean revert leaves nothing pending');
  });

  it('leaves a conflicted revert pending, and aborts it back to HEAD', async () => {
    repo = createTempRepo({
      commits: [{ 'file.txt': 'base\n' }, { 'file.txt': 'side\n' }, { 'file.txt': 'later\n' }],
    });
    const repoPath = repo.dir;
    const head = repo.git('rev-parse', 'HEAD').trim();
    const created = repo.git('rev-parse', 'HEAD~2').trim();

    await assert.rejects(revertCommit(repoPath, created));
    assert.equal(await pendingOperation(repoPath), 'revert');

    assert.equal(await abortPendingOperation(repoPath), 'revert');
    assert.equal(await pendingOperation(repoPath), undefined);
    assert.equal(repo.git('rev-parse', 'HEAD').trim(), head, 'HEAD is where it was before the revert');
    assert.equal(repo.read('file.txt'), 'later\n');
  });

  it('reverts a merge commit only with an explicit mainline', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    const repoPath = repo.dir;
    repo.git('checkout', '--quiet', '-b', 'side');
    repo.write('b.txt', 'two\n');
    repo.git('add', '-A');
    repo.git('commit', '--quiet', '-m', 'side');
    repo.git('checkout', '--quiet', 'main');
    repo.git('merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
    const mergeSha = repo.git('rev-parse', 'HEAD').trim();

    await assert.rejects(revertCommit(repoPath, mergeSha), /mainline|-m/, 'git refuses a merge without -m');

    await revertCommit(repoPath, mergeSha, 1);
    assert.match(repo.git('log', '-1', '--format=%s').trim(), /^Revert/);
    assert.equal(repo.git('rev-list', '--count', 'HEAD').trim(), '4', 'merge + its revert');
  });
});

describe('remote helpers', () => {
  it('renames a remote', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    repo.git('remote', 'add', 'origin', 'https://example.com/a.git');
    await renameRemote(repo.dir, 'origin', 'upstream');
    assert.equal(repo.git('remote').trim(), 'upstream');
  });

  // fetch/push shell out to the transport; kept behind a guard so the suite
  // still runs where the sandbox forbids `sh`.
  it('is callable without a configured remote', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    await assert.rejects(fetchRemote(repo.dir, 'origin'));
    await assert.rejects(deleteRemoteBranch(repo.dir, 'origin', 'main'));
  });
});
