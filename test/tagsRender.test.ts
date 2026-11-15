import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TagEntry } from '../src/git/tags';
import { renderTags } from '../src/views/tagsRender';

const TAGS: TagEntry[] = [
  { name: 'v0.2.0', sha: 'f0f0f0f', date: '2026-11-17 18:20', author: 'Ada Lovelace', subject: 'Merge branch feature/graph' },
  { name: 'v0.1.0', sha: 'abc1234', date: '2026-11-02 09:05', author: 'Grace Hopper', subject: 'Start the graph renderer' },
];

function rowLines(text: string): string[] {
  return text.split('\n').filter((line) => /^ {2}\S/.test(line) && !line.includes('─') && !line.includes('—'));
}

describe('renderTags', () => {
  it('prints a commit row per tag: name, sha, date, author, subject', () => {
    const rendered = renderTags('/repo', TAGS);
    const [first] = rowLines(rendered.text);
    assert.ok(first, rendered.text);
    assert.match(
      first,
      /^ {2}v0\.2\.0 {2}f0f0f0f {2}2026-11-17 18:20 {2}Ada Lovelace {2}Merge branch feature\/graph/,
      first
    );
  });

  it('puts the commit columns where the history graph puts them', () => {
    const rendered = renderTags('/repo', TAGS);
    const [first, second] = rowLines(rendered.text);
    // `prefix + shortSha.padEnd(9) + date.padEnd(18) + author.padEnd(authorColumnWidth)`.
    const sha = 2 + 'v0.2.0'.length + 2;
    assert.equal(first.indexOf('f0f0f0f'), sha, 'the sha follows the name column');
    assert.equal(first.indexOf('2026-11-17 18:20'), sha + 9, 'the date follows the sha column');
    assert.equal(first.indexOf('Ada Lovelace'), sha + 9 + 18, 'the author follows the date column');
    assert.equal(first.indexOf('Merge'), sha + 9 + 18 + 'Ada Lovelace'.length + 2, 'the subject closes the row');
    assert.equal(second.indexOf('abc1234'), sha, 'both rows share the sha column');
    assert.equal(second.indexOf('2026-11-02 09:05'), sha + 9, 'the date column is the same width');
  });

  it('paints name, sha, date and author, and leaves the subject plain', () => {
    const rendered = renderTags('/repo', TAGS);
    const line = rendered.text.split('\n').findIndex((text) => text.includes('v0.2.0'));
    const at = (kind: string) => rendered.spans.find((span) => span.line === line && span.kind === kind);

    assert.equal(rendered.text.split('\n')[line].slice(at('branch')!.start, at('branch')!.end), 'v0.2.0');
    assert.equal(rendered.text.split('\n')[line].slice(at('hash')!.start, at('hash')!.end), 'f0f0f0f');
    assert.equal(rendered.text.split('\n')[line].slice(at('date')!.start, at('date')!.end), '2026-11-17 18:20');
    assert.equal(rendered.text.split('\n')[line].slice(at('author')!.start, at('author')!.end), 'Ada Lovelace');
    const painted = rendered.spans.filter((span) => span.line === line && span.kind !== 'section' && span.kind !== 'help');
    assert.ok(
      painted.every((span) => span.end <= rendered.text.split('\n')[line].indexOf('Merge')),
      'nothing paints the subject'
    );
  });

  it('addresses every row so the tag commands can find it', () => {
    const rendered = renderTags('/repo', TAGS);
    const lines = rendered.text.split('\n');
    const row = lines.findIndex((line) => line.includes('v0.1.0'));
    assert.deepEqual(rendered.targets.get(row + 1), TAGS[1]);
    assert.equal([...rendered.targets.values()].length, 2);
  });

  it('keeps the rows aligned when names and authors differ in length', () => {
    const rendered = renderTags('/repo', [
      ...TAGS,
      { name: 'release/2026-11', sha: 'def5678', date: '2026-10-01 08:00', author: 'Bob', subject: 'short' },
    ]);
    const starts = (kind: string): number[] => [
      ...new Set(rendered.spans.filter((span) => span.kind === kind).map((span) => span.start)),
    ];
    assert.equal(starts('hash').length, 1, 'the sha column is one column');
    assert.equal(starts('date').length, 1, 'so is the date column');
    assert.equal(starts('author').length, 1, 'and the author column');
    assert.equal(rowLines(rendered.text).length, 3, 'every tag gets a row');
  });

  it('says so when there are no tags', () => {
    const rendered = renderTags('/repo', []);
    assert.ok(rendered.text.includes('0'));
    assert.equal(rendered.targets.size, 0);
    assert.ok(rendered.text.includes('—'));
  });

  it('shows the graph key with the other tag keys', () => {
    const rendered = renderTags('/repo', TAGS);
    assert.ok(rendered.text.includes('g graph'), 'g opens the graph from here');
    assert.ok(rendered.text.includes('enter show commit'));
  });
});
