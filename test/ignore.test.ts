import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addToGitignore } from '../src/git/ignore';
import { createTempRepo } from './helpers/tempRepo';

describe('addToGitignore', () => {
  it('creates .gitignore and appends the untracked paths', async () => {
    const repo = createTempRepo();
    try {
      repo.write('dist/bundle.js', 'x');
      repo.write('debug.log', 'x');
      const result = await addToGitignore(repo.dir, ['dist/bundle.js', 'debug.log']);
      assert.deepEqual(result, { added: ['dist/bundle.js', 'debug.log'], present: [], tracked: [] });
      assert.equal(repo.read('.gitignore'), 'dist/bundle.js\ndebug.log\n');
    } finally {
      repo.dispose();
    }
  });

  it('keeps existing lines and does not duplicate a listed path', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'a' }] });
    try {
      repo.write('.gitignore', 'node_modules\n');
      repo.write('debug.log', 'x');
      const first = await addToGitignore(repo.dir, ['debug.log', 'node_modules']);
      assert.deepEqual(first, { added: ['debug.log'], present: ['node_modules'], tracked: [] });
      assert.equal(repo.read('.gitignore'), 'node_modules\ndebug.log\n');

      const second = await addToGitignore(repo.dir, ['debug.log']);
      assert.deepEqual(second, { added: [], present: ['debug.log'], tracked: [] });
      assert.equal(repo.read('.gitignore'), 'node_modules\ndebug.log\n');
    } finally {
      repo.dispose();
    }
  });

  it('reports tracked files instead of writing them', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'a' }] });
    try {
      const result = await addToGitignore(repo.dir, ['a.txt']);
      assert.deepEqual(result, { added: [], present: [], tracked: ['a.txt'] });
      assert.ok(!fs.existsSync(path.join(repo.dir, '.gitignore')), 'nothing is written for tracked files');
    } finally {
      repo.dispose();
    }
  });

  it('adds the untracked half of a mixed selection', async () => {
    const repo = createTempRepo({ commits: [{ 'a.txt': 'a' }] });
    try {
      repo.write('debug.log', 'x');
      const result = await addToGitignore(repo.dir, ['a.txt', 'debug.log']);
      assert.deepEqual(result, { added: ['debug.log'], present: [], tracked: ['a.txt'] });
      assert.equal(repo.read('.gitignore'), 'debug.log\n');
    } finally {
      repo.dispose();
    }
  });

  it('does not start a duplicate line when the file lacks a trailing newline', async () => {
    const repo = createTempRepo();
    try {
      repo.write('.gitignore', 'node_modules');
      repo.write('debug.log', 'x');
      await addToGitignore(repo.dir, ['debug.log']);
      assert.equal(repo.read('.gitignore'), 'node_modules\ndebug.log\n');
    } finally {
      repo.dispose();
    }
  });

  it('stores windows separators as unix ones', async () => {
    const repo = createTempRepo();
    try {
      repo.write('src/gen/out.js', 'x');
      const result = await addToGitignore(repo.dir, [`src${path.sep}gen${path.sep}out.js`]);
      assert.deepEqual(result.added, ['src/gen/out.js']);
    } finally {
      repo.dispose();
    }
  });
});
