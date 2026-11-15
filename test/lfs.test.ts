import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { diffHasLfsPointer, isLfsPointer, listLfsFiles, parseLfsPointer, readLfsPointer } from '../src/git/lfs';
import { createTempRepo } from './helpers/tempRepo';

const OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 1234567\n`;

describe('LFS pointers', () => {
  it('parses a pointer file', () => {
    assert.deepEqual(parseLfsPointer(POINTER), { oid: OID, size: 1234567 });
  });

  it('accepts CRLF line endings', () => {
    assert.deepEqual(parseLfsPointer(POINTER.replace(/\n/g, '\r\n')), { oid: OID, size: 1234567 });
  });

  it('rejects ordinary text that merely mentions git-lfs', () => {
    const prose = 'This repository uses git-lfs.\nversion https://git-lfs.github.com/spec/v1\n';
    assert.equal(parseLfsPointer(prose), undefined);
    assert.equal(isLfsPointer(prose), false);
  });

  it('rejects a pointer with a broken oid or size', () => {
    assert.equal(parseLfsPointer(POINTER.replace('sha256:', 'sha1:')), undefined);
    assert.equal(parseLfsPointer(POINTER.replace('size 1234567', 'size big')), undefined);
    assert.equal(parseLfsPointer(POINTER.replace('1234567', '')), undefined);
  });

  it('rejects a short file that happens to start with the spec line', () => {
    assert.equal(parseLfsPointer('version https://git-lfs.github.com/spec/v1\n'), undefined);
  });

  it('spots a pointer inside a diff, added or removed', () => {
    const diff = [
      'diff --git a/big.bin b/big.bin',
      'index 000..111 100644',
      '--- a/big.bin',
      '+++ b/big.bin',
      '@@ -1,3 +1,3 @@',
      '-version https://git-lfs.github.com/spec/v1',
      '-oid sha256:' + OID,
      '+version https://git-lfs.github.com/spec/v1',
      '+oid sha256:' + OID,
    ].join('\n');
    assert.equal(diffHasLfsPointer(diff), true);
  });

  it('spots a pointer that a diff shows as an unchanged context line', () => {
    const diff = [
      'diff --git a/big.bin b/big.bin',
      '@@ -1,3 +1,3 @@',
      ' version https://git-lfs.github.com/spec/v1',
      ' oid sha256:' + OID,
      '-size 1',
      '+size 2',
    ].join('\n');
    assert.equal(diffHasLfsPointer(diff), true);
  });

  it('leaves a diff of ordinary files alone', () => {
    const diff = ['diff --git a/a.txt b/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    assert.equal(diffHasLfsPointer(diff), false);
  });
});

describe('LFS in a repository', () => {
  it('reports no LFS files when git-lfs is not installed', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'hello\n' }] });
    try {
      // Without the extension every call fails, and an empty list is the
      // documented answer rather than an exception.
      assert.deepEqual(await listLfsFiles(repo.dir), []);
    } finally {
      repo.dispose();
    }
  });

  it('reads a pointer from the working tree', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'hello\n' }] });
    try {
      repo.write('big.bin', POINTER);
      assert.deepEqual(await readLfsPointer(repo.dir, 'big.bin'), { oid: OID, size: 1234567 });
      assert.equal(await readLfsPointer(repo.dir, 'a.txt'), undefined);
      assert.equal(await readLfsPointer(repo.dir, 'missing.bin'), undefined);
    } finally {
      repo.dispose();
    }
  });

  it('lists files when git-lfs is available', async (t) => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'hello\n' }] });
    try {
      const hasLfs = (() => {
        try {
          repo.git('lfs', 'version');
          return true;
        } catch {
          return false;
        }
      })();
      if (!hasLfs) {
        t.skip('git-lfs is not installed');
        return;
      }
      repo.write('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
      repo.write('big.bin', POINTER);
      repo.git('add', '-A');
      repo.git('commit', '--quiet', '-m', 'lfs');
      const files = await listLfsFiles(repo.dir);
      assert.equal(files.length, 1);
      assert.equal(files[0].path, 'big.bin');
      assert.equal(files[0].oid.length >= 7, true);
      assert.equal(fs.existsSync(path.join(repo.dir, '.gitattributes')), true);
    } finally {
      repo.dispose();
    }
  });
});
