import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderLog } from '../src/views/logRender';
import { ParsedLog } from '../src/git/log';

/**
 * `renderLog` is the whole history screen as a string: the demo images and the
 * filter block both read the layout from here, so a wrong line offset would
 * move every clickable row.
 */
const commit = {
  sha: 'a'.repeat(40),
  shortSha: 'aaaaaaa',
  parents: [],
  author: 'Ada Lovelace',
  date: '2 days ago',
  subject: 'Add the graph column',
  refs: ['HEAD -> main', 'tag: v1.0.0'],
  graphPrefix: '* ',
};

const parsed: ParsedLog = {
  entries: [{ commit, graphPrefix: '* ' }],
  commits: [commit],
  maxPrefixWidth: 2,
};

const options = { repoPath: '/repo/githelm', all: false, filter: {}, sort: 'topo' as const };

describe('history screen', () => {
  it('starts with the title, the count and the filter block', () => {
    const { lines } = renderLog(parsed, options);
    assert.match(lines[0] ?? '', /^githelm — commit history/);
    assert.match(lines[1] ?? '', /1 commit/);
    assert.ok((lines[2] ?? '').startsWith('## filters'), 'the filter header keeps its line');
  });

  it('puts every commit row below the filter block', () => {
    const { lines, spans } = renderLog(parsed, options);
    const row = lines.findIndex((line) => line.includes('Add the graph column'));
    assert.ok(row > 2, `commit row is at ${row}`);
    assert.ok(
      spans.some((span) => span.line === row && span.kind === 'hash'),
      'the short sha keeps its own span on the row'
    );
    assert.ok(
      spans.some((span) => span.line === row && span.kind === 'author'),
      'the author keeps its own span on the row'
    );
  });

  it('numbers the filter lines so a click knows which field it hit', () => {
    const { fieldLines } = renderLog(parsed, options);
    assert.equal(fieldLines.get(4), 'grep');
    assert.equal(fieldLines.size, 7);
  });

  it('keeps the commit index one-based, as the editor reports lines', () => {
    const { lines, commitsByLine } = renderLog(parsed, options);
    const row = lines.findIndex((line) => line.includes('Add the graph column'));
    assert.equal(commitsByLine.get(row + 1)?.shortSha, 'aaaaaaa');
  });

  it('shows the current filters in the block', () => {
    const { lines } = renderLog(parsed, { ...options, filter: { author: 'ada' } });
    assert.ok(lines.some((line) => line.includes('ada')), 'the author filter is printed');
  });
});
