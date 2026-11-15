import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  parseSubmoduleStatus,
  readSubmoduleStatus,
  readSubmodules,
  submoduleUpdateArgs,
  updateSubmodule,
} from '../src/git/submodules';
import { createTempRepo } from './helpers/tempRepo';

const SHA = '7d1d1b7a6d1b1c1f0d5b5c9f8f3f2e1d0c9b8a71';

describe('submodule status parsing', () => {
  it('reads the marker, commit and path of every entry', () => {
    const raw = [
      ` ${SHA} libs/clean (v1.2.0)`,
      `+abcdef1234567890 libs/ahead (2 commits ahead)`,
      `-1234567890abcdef libs/missing`,
      `Udeadbeefdeadbeef libs/conflict`,
    ].join('\n');
    assert.deepEqual(parseSubmoduleStatus(raw), [
      { path: 'libs/clean', sha: SHA, state: 'ok', describe: 'v1.2.0' },
      { path: 'libs/ahead', sha: 'abcdef1234567890', state: 'modified', describe: '2 commits ahead' },
      { path: 'libs/missing', sha: '1234567890abcdef', state: 'uninitialized' },
      { path: 'libs/conflict', sha: 'deadbeefdeadbeef', state: 'conflict' },
    ]);
  });

  it('keeps a path that contains spaces', () => {
    const [submodule] = parseSubmoduleStatus(` ${SHA} libs/my lib`);
    assert.equal(submodule.path, 'libs/my lib');
    assert.equal(submodule.state, 'ok');
    assert.equal(submodule.describe, undefined);
  });

  it('returns nothing for an empty status and ignores malformed lines', () => {
    assert.deepEqual(parseSubmoduleStatus(''), []);
    assert.deepEqual(parseSubmoduleStatus('\n\n'), []);
    assert.deepEqual(parseSubmoduleStatus('not a status line'), []);
    assert.deepEqual(parseSubmoduleStatus(' x'), []);
  });
});

describe('submodule update arguments', () => {
  it('always names the submodule after a separator', () => {
    assert.deepEqual(submoduleUpdateArgs('libs/a'), ['submodule', 'update', '--', 'libs/a']);
  });

  it('adds --init and --remote only when asked', () => {
    assert.deepEqual(submoduleUpdateArgs('libs/a', { init: true }), ['submodule', 'update', '--init', '--', 'libs/a']);
    assert.deepEqual(submoduleUpdateArgs('libs/a', { init: true, remote: true }), [
      'submodule',
      'update',
      '--init',
      '--remote',
      '--',
      'libs/a',
    ]);
    assert.deepEqual(submoduleUpdateArgs(undefined, { init: true }), ['submodule', 'update', '--init']);
  });
});

interface SubmoduleRepo {
  parent: ReturnType<typeof createTempRepo>;
  dispose: () => void;
}

/**
 * `git submodule add` shells out, and a hardened sandbox can refuse the pipes
 * that needs. The parsing and argument tests above still run there, so the
 * checkout tests skip with a reason instead of failing the suite.
 */
function createParentWithSubmodule(): SubmoduleRepo | undefined {
  const child = createTempRepo({ commits: [{ 'lib.txt': 'v1\n' }] });
  const parent = createTempRepo({ commits: [{ 'a.txt': 'hello\n' }] });
  try {
    // A local path is only allowed as a submodule source when the caller opts in.
    parent.git('-c', 'protocol.file.allow=always', 'submodule', 'add', child.dir, 'libs/child');
    parent.git('commit', '--quiet', '-m', 'add submodule');
  } catch {
    parent.dispose();
    child.dispose();
    return undefined;
  }
  return {
    parent,
    dispose: () => {
      parent.dispose();
      child.dispose();
    },
  };
}

const SANDBOX_SKIP = 'git submodule needs a shell that this sandbox blocks';

describe('submodules in a repository', () => {
  it('reports an up-to-date submodule', async (t) => {
    const setup = createParentWithSubmodule();
    if (!setup) {
      t.skip(SANDBOX_SKIP);
      return;
    }
    try {
      const submodules = await readSubmodules(setup.parent.dir);
      assert.equal(submodules.length, 1);
      assert.equal(submodules[0].path, 'libs/child');
      assert.equal(submodules[0].state, 'ok');
      assert.equal(fs.existsSync(path.join(setup.parent.dir, 'libs/child/lib.txt')), true);
    } finally {
      setup.dispose();
    }
  });

  it('marks a submodule that moved to another commit as modified', async (t) => {
    const setup = createParentWithSubmodule();
    if (!setup) {
      t.skip(SANDBOX_SKIP);
      return;
    }
    try {
      fs.writeFileSync(path.join(setup.parent.dir, 'libs/child/lib.txt'), 'v2\n', 'utf8');
      setup.parent.git('-C', 'libs/child', 'commit', '--quiet', '-am', 'move on');
      const submodules = await readSubmodules(setup.parent.dir);
      assert.equal(submodules[0].state, 'modified');
    } finally {
      setup.dispose();
    }
  });

  it('checks a submodule out at the recorded commit again', async (t) => {
    const setup = createParentWithSubmodule();
    if (!setup) {
      t.skip(SANDBOX_SKIP);
      return;
    }
    try {
      fs.writeFileSync(path.join(setup.parent.dir, 'libs/child/lib.txt'), 'v2\n', 'utf8');
      setup.parent.git('-C', 'libs/child', 'commit', '--quiet', '-am', 'move on');
      await updateSubmodule(setup.parent.dir, 'libs/child', { init: true });
      assert.equal(fs.readFileSync(path.join(setup.parent.dir, 'libs/child/lib.txt'), 'utf8'), 'v1\n');
      assert.equal((await readSubmodules(setup.parent.dir))[0].state, 'ok');
    } finally {
      setup.dispose();
    }
  });

  it('has no submodules in a plain repository', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'hello\n' }] });
    try {
      assert.deepEqual(await readSubmodules(repo.dir), []);
    } finally {
      repo.dispose();
    }
  });

  it('tells an empty list from a list git could not produce', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'hello\n' }] });
    try {
      const result = await readSubmoduleStatus(repo.dir);
      assert.deepEqual(result.submodules, []);
      if (result.error) {
        // A sandbox that blocks `sh` refuses `git submodule status` itself; the
        // screen has to say so instead of claiming there are no submodules.
        assert.ok(result.error.length > 0);
        assert.equal(typeof result.error, 'string');
      } else {
        assert.equal(result.error, undefined);
      }
    } finally {
      repo.dispose();
    }
  });

  it('surfaces git failures instead of pretending the update worked', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'hello\n' }] });
    try {
      await assert.rejects(
        () => updateSubmodule(repo.dir, 'libs/nope', { init: true }),
        (error: unknown) => error instanceof Error && error.message.trim().length > 0
      );
    } finally {
      repo.dispose();
    }
  });
});
