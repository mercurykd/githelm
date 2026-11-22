import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BLAME_GUTTER_WIDTH,
  BLAME_WIDTHS,
  blameLines,
  parseBlame,
  type BlameView,
} from '../src/git/fileHistory';

/**
 * A blame is read for its code, so the code is the file itself: the same lines, in the same
 * order, untouchable by anything the blame knows — no header, no rule, no padding. The
 * metadata is a column in front of it, and a column is a width: these are the guarantees that
 * keep the four cells where they are and the code on one line of the screen.
 */

const ONE = ['^dc3ba5e (Test 2026-11-21 1) one', '  7a1b2c3 (Ann Author 2026-11-20 2) two'].join('\n');
/** Two consecutive lines from one commit: one block, so one gutter of metadata. */
const BLOCK = ['abc1234 (Ada 2026-11-20 1) first', '   abc1234 (Ada 2026-11-20 2) second'].join('\n');

/** Where each cell of the gutter begins and ends, as the cells are laid out. */
const SHA = [1, 1 + BLAME_WIDTHS.sha] as const;
const AUTHOR = [SHA[1] + 1, SHA[1] + 1 + BLAME_WIDTHS.author] as const;
const DATE = [AUTHOR[1] + 1, AUTHOR[1] + 1 + BLAME_WIDTHS.date] as const;
const SUBJECT = [DATE[1] + 1, DATE[1] + 1 + BLAME_WIDTHS.subject] as const;
const META = SUBJECT[1];
const GAP = BLAME_GUTTER_WIDTH - META;

const view = (stdout: string, maxLines = 3000, messages?: Map<string, string>): BlameView =>
  blameLines('src/app.ts', parseBlame(stdout), maxLines, messages);
const messages = (entries: Array<[string, string]>): Map<string, string> => new Map(entries);
/** One cell of a gutter line, trimmed: what the reader sees in it. */
const cellOf = (gutter: string, [from, to]: readonly [number, number]): string =>
  gutter.slice(from, to).trim();

describe('blame rows', () => {
  it('splits a `git blame` row into the cells a reader scans', () => {
    const [row] = parseBlame('^dc3ba5e (Test 2026-11-21 1) one');
    assert.deepEqual(row, {
      sha: 'dc3ba5e',
      author: 'Test',
      date: '2026-11-21',
      line: 1,
      text: 'one',
      uncommitted: false,
    });
  });

  it('keeps an author with spaces whole, and takes the date as the anchor', () => {
    const [row] = parseBlame('7a1b2c3 (Ann Author 2026-11-20 42) const x = 1;');
    assert.equal(row.author, 'Ann Author');
    assert.equal(row.line, 42);
    assert.equal(row.text, 'const x = 1;');
  });

  it('is not confused by parentheses in the line itself', () => {
    const [row] = parseBlame('7a1b2c3 (Ann 2026-11-20 3) if (a) { b(c); }');
    assert.equal(row.author, 'Ann');
    assert.equal(row.text, 'if (a) { b(c); }');
  });

  it('marks a line that is not committed yet, and drops the carriage of CRLF', () => {
    const [row] = parseBlame('0000000 (Not Committed Yet 2026-11-21 4) edited\r');
    assert.equal(row.uncommitted, true);
    assert.equal(row.text, 'edited');
  });

  it('skips lines that are not blame rows', () => {
    assert.deepEqual(parseBlame('fatal: no such path'), []);
  });
});

describe('a blame is the file itself', () => {
  it('is the file\'s lines and nothing else', () => {
    const blame = view(ONE);
    assert.equal(blame.text, 'one\ntwo', 'not the code, the file: no header, no rule, no padding');
    assert.equal(blame.relativePath, 'src/app.ts');
    assert.equal(blame.truncated, 0);
  });

  it('keeps the code exactly as the file has it', () => {
    // Tabs, runs of spaces and trailing whitespace are the code: a grammar reads them.
    const source = '\tif (x) {   \n\t\treturn y;\t\n}';
    const blame = view(['abc1234 (Ada 2026-11-20 1) \tif (x) {   ', '   abc1234 (Ada 2026-11-20 2) \t\treturn y;\t', '   abc1234 (Ada 2026-11-20 3) }'].join('\n'));
    assert.equal(blame.text, source);
  });

  it('gives the editor one row per line of the file, in the same order', () => {
    const blame = view(ONE);
    assert.deepEqual(
      blame.lines.map((line) => line.line),
      [0, 1],
      '0-based, because a decoration is attached by line index'
    );
    assert.equal(blame.lines.length, blame.text.split('\n').length);
  });

  it('says how much of a long blame it left out', () => {
    const many = Array.from({ length: 5 }, (_, index) => `abcdef${index} (Ann 2026-11-20 ${index + 1}) l${index}`);
    const blame = view(many.join('\n'), 2);
    assert.equal(blame.text, 'l0\nl1');
    assert.equal(blame.lines.length, 2);
    assert.equal(blame.truncated, 3);
  });
});

describe('the gutter', () => {
  it('is a width, not a line of text', () => {
    assert.equal(BLAME_GUTTER_WIDTH, 68, 'the four cells, their separators and the gap');
    assert.equal(META + GAP, BLAME_GUTTER_WIDTH);
    for (const line of view(BLOCK).lines) {
      assert.equal(line.gutter.length, BLAME_GUTTER_WIDTH, 'every line, blank or not');
    }
  });

  it('puts each cell in its own fixed column', () => {
    const [gutter] = view(ONE).lines.map((line) => line.gutter);
    assert.equal(cellOf(gutter, SHA), 'dc3ba5e');
    assert.equal(cellOf(gutter, AUTHOR), 'Test');
    assert.equal(cellOf(gutter, DATE), '2026-11-21');
    assert.equal(gutter.slice(SUBJECT[0], META).trim(), '');
    assert.equal(gutter.slice(META), ' '.repeat(GAP), 'the gap the code starts after');
  });

  it('keeps the columns still for a short sha and a short author', () => {
    const [gutter] = view('abc1234 (A 2026-11-20 1) x').lines.map((line) => line.gutter);
    assert.equal(gutter.slice(0, SHA[0]), ' ', 'the sha is one space in');
    assert.equal(cellOf(gutter, SHA), 'abc1234');
    assert.equal(gutter[AUTHOR[0]], 'A', 'the author column starts at 10');
    assert.equal(gutter[DATE[0]], '2', 'and the date column at 27');
    assert.equal(gutter[SUBJECT[0]], ' ', 'and the subject column at 38');
  });

  it('cuts the sha blame printed to the eight characters a reader scans', () => {
    const full = 'abcdef0123456789abcdef0123456789abcdef01';
    const [gutter] = view(`${full} (Ada 2026-11-20 1) x`).lines.map((line) => line.gutter);
    assert.equal(cellOf(gutter, SHA), 'abcdef01');
  });

  it('cuts a long author and a long subject inside their cells', () => {
    const [gutter] = view('abc1234 (Someone With A Very Long Login 2026-11-20 1) x', 3000, messages([
      ['abc1234', 'feat: isolate WireGuard instance state'],
    ])).lines.map((line) => line.gutter);
    assert.equal(cellOf(gutter, AUTHOR), 'Someone With A …', 'cut to the cell, not pushed past it');
    assert.equal(cellOf(gutter, DATE), '2026-11-20', 'and the date is still in its own column');
    assert.equal(cellOf(gutter, SUBJECT), 'feat: isolate WireGuard ins…');
    assert.equal(gutter.slice(META), ' '.repeat(GAP), 'the code still starts where it started');
  });

  it('prints the metadata once per block, and holds the column open for the rest', () => {
    const [head, rest] = view(BLOCK).lines;
    assert.equal(head.block, true);
    assert.ok(cellOf(head.gutter, SHA).startsWith('abc1234'));
    assert.equal(rest.block, false);
    assert.equal(rest.gutter, ' '.repeat(BLAME_GUTTER_WIDTH), 'blank, and the same width');
  });

  it('starts a new block when the commit changes, and only then', () => {
    const blame = view([BLOCK, 'def5678 (Bob 2026-11-19 3) third'].join('\n'));
    assert.deepEqual(
      blame.lines.map((line) => line.block),
      [true, false, true]
    );
    assert.equal(cellOf(blame.lines[2].gutter, AUTHOR), 'Bob', 'a new commit prints its own cells');
  });

  it('shows a line that is not committed yet as one', () => {
    const [line] = view('0000000 (Not Committed Yet 2026-11-21 1) mine').lines;
    assert.equal(line.uncommitted, true);
    assert.equal(cellOf(line.gutter, SHA), '—', 'there is no sha to name');
    assert.equal(cellOf(line.gutter, AUTHOR), 'не в коммите');
    assert.equal(cellOf(line.gutter, DATE), '—');
    assert.equal(cellOf(line.gutter, SUBJECT), '');
  });
});

describe('the message', () => {
  it('prints the subject in its own cell, cut to the width', () => {
    const [line] = view(ONE, 3000, messages([['dc3ba5e', 'feat: isolate WireGuard instance state']])).lines;
    assert.equal(cellOf(line.gutter, SUBJECT), 'feat: isolate WireGuard ins…');
    assert.ok(!line.gutter.includes('state'), 'what does not fit is not in the gutter');
  });

  it('carries the whole message of every line of a block', () => {
    const message = 'subject\n\nbody line one\nbody line two';
    const blame = view(BLOCK, 3000, messages([['abc1234', message]]));
    assert.deepEqual(
      blame.lines.map((line) => line.message),
      [message, message],
      'the question a line raises is about its commit, not about its place in the block'
    );
  });

  it('leaves the cell blank when the message is not known', () => {
    const [line] = view(ONE).lines;
    assert.equal(line.message, '');
    assert.equal(cellOf(line.gutter, SUBJECT), '');
    assert.equal(line.gutter.length, BLAME_GUTTER_WIDTH, 'the column is still there');
  });

  it('has nothing to say about a line that is not committed', () => {
    const blame = view(
      '0000000 (Not Committed Yet 2026-11-21 1) mine',
      3000,
      messages([['0000000', 'a message for a commit that does not exist']])
    );
    assert.equal(blame.lines[0].message, '', 'no commit, no message');
  });

  it('takes the first line that has something in it, not a leading blank', () => {
    const blame = view(ONE, 3000, messages([['dc3ba5e', '\n  indented subject  \n\nbody']]));
    assert.equal(cellOf(blame.lines[0].gutter, SUBJECT), 'indented subject');
    assert.equal(blame.lines[0].message, '\n  indented subject  \n\nbody', 'the hover keeps it all');
  });

  it('finds the message by the sha blame printed, full or short', () => {
    // `fileBlame` asks for forty characters so a second command can find the commit again;
    // a row written by hand has eight, and both look the message up by what they were given.
    const full = 'abcdef0123456789abcdef0123456789abcdef01';
    const blame = view(`${full} (Ada 2026-11-20 1) x`, 3000, messages([[full, 'subject']]));
    assert.equal(cellOf(blame.lines[0].gutter, SUBJECT), 'subject');
    assert.equal(cellOf(blame.lines[0].gutter, SHA), 'abcdef01', 'the gutter prints eight');
  });
});
