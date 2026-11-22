import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorColumnWidth, checkoutableRefs, commitBySha, logRows, parseLog, readLog, truncateAuthor } from '../src/git/log';
import { createTempRepo } from './helpers/tempRepo';

const SEP = '\x1f';

function line(prefix: string, sha: string, parents: string, refs = ''): string {
  return `${prefix}${SEP}${sha}${SEP}${sha.slice(0, 7)}${SEP}${parents}${SEP}Ann Author${SEP}2 days ago${SEP}subject of ${sha.slice(0, 4)}${SEP}${refs}`;
}

const RAW = [
  line('* ', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '', 'HEAD -> main, origin/main'),
  line('|\\', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tag: v1'),
  '|/',
  line('* ', 'cccccccccccccccccccccccccccccccccccccccc', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  '',
].join('\n');

describe('parseLog', () => {
  it('splits the graph prefix from commit fields', () => {
    const parsed = parseLog(RAW);
    assert.equal(parsed.commits.length, 3);
    assert.equal(parsed.entries.length, 4, 'continuation row is kept');
    assert.equal(parsed.commits[0].sha, 'a'.repeat(40));
    assert.equal(parsed.commits[0].graphPrefix, '* ');
    assert.deepEqual(parsed.commits[0].refs, ['HEAD -> main', 'origin/main']);
    assert.deepEqual(parsed.commits[1].refs, ['tag: v1']);
    assert.deepEqual(parsed.commits[2].parents, ['b'.repeat(40)]);
    assert.equal(parsed.maxPrefixWidth, 2);
  });

  it('returns no commits for an empty history', () => {
    const parsed = parseLog('');
    assert.deepEqual(parsed.commits, []);
    assert.deepEqual(parsed.entries, []);
  });

  it('keeps rows without a commit as graph-only rows', () => {
    const parsed = parseLog(RAW);
    const continuation = parsed.entries.filter((entry) => entry.commit === undefined);
    assert.equal(continuation.length, 1);
    assert.equal(continuation[0].graphPrefix, '|/');
  });
});

describe('logRows', () => {
  it('aligns commit text after the widest graph prefix', () => {
    const rows = logRows(parseLog(RAW));
    assert.equal(rows.length, 4);
    assert.ok(rows[0].text.startsWith('* '));
    assert.ok(rows[0].text.includes('aaaaaaa'));
    assert.ok(rows[0].text.includes('[HEAD -> main origin/main]'));
    assert.equal(rows[2].text, '|/');
    assert.equal(rows[0].commit?.shortSha, 'aaaaaaa');
  });

  it('keeps the mapping between row and commit', () => {
    const rows = logRows(parseLog(RAW));
    assert.equal(rows.filter((row) => row.commit).length, 3);
  });

  it('truncates long author names', () => {
    const sha = 'd'.repeat(40);
    const longAuthor = `${sha}${SEP}ddddddd${SEP}${SEP}${'Author With A Very Long Name Indeed'}${SEP}now${SEP}subject${SEP}`;
    const rows = logRows(parseLog(`* ${SEP}${longAuthor}\n`));
    assert.ok(rows[0].text.includes('…'), 'author should be ellipsised');
  });

  it('sizes the author column to the longest name in the log', () => {
    const parsed = parseLog([
      line('* ', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '', 'dev'),
      line('* ', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      '',
    ].join('\n'));
    const [first, second] = logRows(parsed);
    assert.equal(first.text, '*  aaaaaaa  2 days ago        Ann Author  [dev] subject of aaaa');
    assert.equal(second.text, '*  bbbbbbb  2 days ago        Ann Author  subject of bbbb');
  });

  it('leaves two spaces after a short author instead of padding to a fixed column', () => {
    const sha = 'e'.repeat(40);
    const raw = `* ${SEP}${sha}${SEP}eeeeeee${SEP}${SEP}me${SEP}now${SEP}subject${SEP}HEAD -> main`;
    const row = logRows(parseLog(raw))[0];
    assert.ok(row.text.endsWith('me  [HEAD -> main] subject'), row.text);

    const refsSpan = row.spans.find((span) => span.kind === 'refs');
    assert.ok(refsSpan, 'the refs label has a span');
    assert.equal(row.text.slice(refsSpan.start, refsSpan.end), '[HEAD -> main]', 'span follows the tighter column');
  });
});

describe('author column', () => {
  it('sits two columns after the longest name', () => {
    assert.equal(authorColumnWidth(['me', 'Ann Author']), 12);
  });

  it('caps the column for very long names', () => {
    assert.equal(authorColumnWidth(['A'.repeat(40)]), 20);
    assert.equal(truncateAuthor('A'.repeat(40)), `${'A'.repeat(17)}…`);
  });

  it('falls back to a single column when there are no authors', () => {
    assert.equal(authorColumnWidth([]), 1);
  });
});

describe('readLog in a fresh repository', () => {
  it('returns an empty history instead of failing without HEAD', async () => {
    const repo = createTempRepo();
    try {
      // `git log` exits 128 here ("does not have any commits yet"); the status
      // screen must still render, so an empty history is the right answer.
      const parsed = await readLog(repo.dir, { limit: 10 });
      assert.deepEqual(parsed.commits, []);
      assert.deepEqual(parsed.entries, []);
      assert.equal(parsed.maxPrefixWidth, 0);
      assert.deepEqual(logRows(parsed), []);
    } finally {
      repo.dispose();
    }
  });
});

describe('a page of the history', () => {
  /** Three commits, newest last, each with its own subject so a page is identifiable. */
  const history = (): ReturnType<typeof createTempRepo> => {
    const repo = createTempRepo();
    for (const subject of ['first', 'second', 'third']) {
      repo.git('commit', '--quiet', '--allow-empty', '-m', subject);
    }
    return repo;
  };

  it('reads only as many commits as it was asked for, newest first', async () => {
    const repo = history();
    try {
      const all = await readLog(repo.dir, { limit: 10 });
      assert.deepEqual(
        all.commits.map((commit) => commit.subject),
        ['third', 'second', 'first']
      );
      const page = await readLog(repo.dir, { limit: 2 });
      assert.deepEqual(
        page.commits.map((commit) => commit.subject),
        ['third', 'second'],
        'a page is the newest commits, not the oldest'
      );
      // A full page is what tells the panel there may be more: `more` is computed as
      // `commits.length >= limit`, so this pairing is the lazy loading contract.
      assert.equal(page.commits.length >= 2, true);
      assert.equal(all.commits.length >= 3, true, 'but a page of three is the whole history');
      const short = await readLog(repo.dir, { limit: 4 });
      assert.equal(short.commits.length, 3, 'a limit past the end returns what exists');
    } finally {
      repo.dispose();
    }
  });

  it('draws a page as the same grid the whole history has', async () => {
    const repo = history();
    try {
      const page = await readLog(repo.dir, { limit: 2 });
      const rows = logRows(page);
      assert.equal(rows.length, 2);
      // The graph column is padded to the widest prefix of *this* read, so a page can
      // narrow it — the text is still the buffer's line for those commits: the graph,
      // the sha, the date and the author in the same columns, the subject last.
      for (const row of rows) {
        assert.match(row.text, /^\* {2}[0-9a-f]{7} {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}Test /);
        assert.match(row.text, /(third|second)$/, 'the refs sit between the author and the subject');
      }
      assert.match(rows[0].text, /\[HEAD -> main\] third$/, 'the refs of the newest commit are on its row');
    } finally {
      repo.dispose();
    }
  });
});

describe('a filter', () => {
  /** Five commits; only the first and the third mention the needle. */
  const history = (): ReturnType<typeof createTempRepo> => {
    const repo = createTempRepo();
    for (const subject of ['needle one', 'second', 'needle three', 'fourth', 'fifth']) {
      repo.git('commit', '--quiet', '--allow-empty', '-m', subject);
    }
    return repo;
  };

  it('searches the whole history, not the page that happens to be on screen', async () => {
    const repo = history();
    try {
      // A filter is a `git log` argument, so git answers it over the history it walks and
      // the page limit truncates the *answer*: the match five commits back is found even
      // though the first page of two commits has no match on it at all.
      const page = await readLog(repo.dir, { limit: 2 });
      assert.deepEqual(
        page.commits.map((commit) => commit.subject),
        ['fifth', 'fourth'],
        'the first page carries no match'
      );
      const matched = await readLog(repo.dir, { limit: 2, filter: { grep: 'needle' } });
      assert.deepEqual(
        matched.commits.map((commit) => commit.subject),
        ['needle three', 'needle one'],
        'both matches, including the one five commits deep'
      );
    } finally {
      repo.dispose();
    }
  });

  it('pages the matches, so a short page means the matches are exhausted', async () => {
    const repo = history();
    try {
      const first = await readLog(repo.dir, { limit: 1, filter: { grep: 'needle' } });
      assert.deepEqual(
        first.commits.map((commit) => commit.subject),
        ['needle three']
      );
      // A page of matches is what the panel turns into `more`; the next page holds the
      // older match, and a limit past the last match comes back short.
      const second = await readLog(repo.dir, { limit: 2, filter: { grep: 'needle' } });
      assert.equal(second.commits.length, 2);
      const exhausted = await readLog(repo.dir, { limit: 3, filter: { grep: 'needle' } });
      assert.equal(exhausted.commits.length, 2, 'no more matches than git found');
    } finally {
      repo.dispose();
    }
  });

  it('searches the refs in play — `a` is what widens it past HEAD', async () => {
    const repo = createTempRepo();
    try {
      repo.git('commit', '--quiet', '--allow-empty', '-m', 'base');
      repo.git('checkout', '--quiet', '-b', 'side');
      repo.git('commit', '--quiet', '--allow-empty', '-m', 'needle on the side');
      repo.git('checkout', '--quiet', 'main');
      // Without `a` the walk starts at HEAD, so a match only on a side branch is not there.
      assert.deepEqual((await readLog(repo.dir, { limit: 10, filter: { grep: 'needle' } })).commits, []);
      assert.deepEqual(
        (await readLog(repo.dir, { limit: 10, all: true, filter: { grep: 'needle' } })).commits.map(
          (commit) => commit.subject
        ),
        ['needle on the side']
      );
    } finally {
      repo.dispose();
    }
  });
});

describe('a commit read by its sha', () => {
  it('finds the commit the row named, with its refs and parents', async () => {
    const repo = createTempRepo();
    try {
      repo.git('commit', '--quiet', '--allow-empty', '-m', 'only');
      const [row] = (await readLog(repo.dir, { limit: 1 })).commits;
      const commit = await commitBySha(repo.dir, row.sha);
      assert.equal(commit?.sha, row.sha);
      assert.equal(commit?.shortSha, row.shortSha);
      assert.equal(commit?.subject, 'only');
      assert.equal(commit?.author, 'Test');
      assert.deepEqual(commit?.refs, ['HEAD -> main']);
    } finally {
      repo.dispose();
    }
  });

  it('refuses anything that is not a sha, so a row id cannot become an option', async () => {
    const repo = createTempRepo();
    try {
      repo.git('commit', '--quiet', '--allow-empty', '-m', 'only');
      for (const bad of ['', 'HEAD', 'main', 'abc', 'field:grep', 'commit:abc', '--upload-pack=calc']) {
        assert.equal(await commitBySha(repo.dir, bad), undefined, `${bad || 'the empty string'} is refused`);
      }
    } finally {
      repo.dispose();
    }
  });

  it('has no answer for a commit that is gone', async () => {
    const repo = createTempRepo();
    try {
      repo.git('commit', '--quiet', '--allow-empty', '-m', 'only');
      assert.equal(await commitBySha(repo.dir, '0'.repeat(40)), undefined);
    } finally {
      repo.dispose();
    }
  });
});

describe('checkoutableRefs', () => {
  it('drops tags and the HEAD marker', () => {
    assert.deepEqual(checkoutableRefs(['HEAD -> main', 'origin/main', 'tag: v1', 'HEAD']), ['main', 'origin/main']);
  });

  it('returns an empty list when there is nothing to check out', () => {
    assert.deepEqual(checkoutableRefs(['tag: v1']), []);
  });
});

describe('refs label', () => {
  it('puts branch and tag labels inline, right before the subject', () => {
    const parsed = parseLog([
      line('* ', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '', 'HEAD -> main, origin/main, tag: v1'),
      line('* ', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      '',
    ].join('\n'));
    const rows = logRows(parsed);

    const first = rows[0].text;
    const labelIndex = first.indexOf('[HEAD -> main origin/main tag: v1]');
    const subjectIndex = first.indexOf('subject of aaaa');
    assert.ok(labelIndex > 0, 'labels are present');
    assert.ok(subjectIndex > labelIndex, 'subject comes after the labels');
    assert.ok(!first.includes('…'), 'labels are no longer truncated');

    const second = rows[1].text;
    assert.ok(second.indexOf('subject of bbbb') > 0);
    assert.ok(!second.includes('['), 'no empty brackets for commits without refs');
  });

  it('keeps labels tight against the subject', () => {
    const parsed = parseLog([
      line('* ', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '', 'dev'),
      line('* ', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      '',
    ].join('\n'));
    const first = logRows(parsed)[0].text;
    assert.ok(first.includes('[dev] subject of aaaa'), 'label and subject are separated by one space');
  });
});