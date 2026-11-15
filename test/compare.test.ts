import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { compareRange, headSha } from '../src/git/compare';
import { logArgs, parseLog } from '../src/git/log';
import { createTempRepo, TempRepo } from './helpers/tempRepo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

describe('compareRange', () => {
  it('builds two-dot and three-dot ranges', () => {
    assert.equal(compareRange('aaa', 'bbb', 'two'), 'aaa..bbb');
    assert.equal(compareRange('aaa', 'bbb', 'three'), 'aaa...bbb');
  });

  it('swaps sides by swapping arguments', () => {
    assert.equal(compareRange('bbb', 'aaa', 'two'), 'bbb..aaa');
  });
});

describe('logArgs with a range', () => {
  it('passes the range instead of --all', () => {
    const args = logArgs({ range: 'a..b' });
    assert.ok(args.includes('a..b'));
    assert.ok(!args.includes('--all'));
  });

  it('adds --left-right for three-dot ranges', () => {
    assert.ok(logArgs({ range: 'a...b', leftRight: true }).includes('--left-right'));
    assert.ok(!logArgs({ range: 'a...b' }).includes('--left-right'));
  });
});

describe('parseLog left/right markers', () => {
  it('detects < and > markers before the graph', () => {
    const SEP = '\x1f';
    const line = (prefix: string, sha: string) => `${prefix}${SEP}${sha}${SEP}${sha.slice(0, 7)}${SEP}${SEP}A${SEP}2026-01-01 10:00${SEP}s${SEP}`;
    const parsed = parseLog([line('< * ', 'a'.repeat(40)), line('> * ', 'b'.repeat(40)), ''].join('\n'));

    assert.equal(parsed.commits[0].side, '<');
    assert.equal(parsed.commits[1].side, '>');
  });

  it('leaves side undefined without markers', () => {
    const SEP = '\x1f';
    const line = `* ${SEP}${'c'.repeat(40)}${SEP}ccccccc${SEP}${SEP}A${SEP}2026-01-01 10:00${SEP}s${SEP}`;
    assert.equal(parseLog(line).commits[0].side, undefined);
  });
});

describe('headSha', () => {
  it('returns the current HEAD', async () => {
    repo = createTempRepo({ commits: [{ 'a.txt': 'one\n' }] });
    assert.equal(await headSha(repo.dir), repo.git('rev-parse', 'HEAD').trim());
  });
});
