import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { t } from '../src/i18n';
import { RepoStatus } from '../src/git/status';
import { WorktreeEntry } from '../src/git/worktree';
import { RenderedStatus, renderStatus, renderUninitialized, resolveSelections, resolveTargets, StatusExtras, StatusTarget, targetAtCell } from '../src/views/statusRender';

const STATUS: RepoStatus = {
  branch: 'main',
  ahead: 2,
  behind: 0,
  head: 'abc1234',
  headSubject: 'Fix the thing',
  entries: [
    { section: 'staged', xy: 'M ', path: 'src/app.ts' },
    { section: 'unstaged', xy: ' M', path: 'src/app.ts' },
    { section: 'unstaged', xy: ' M', path: 'src/second.ts' },
    { section: 'untracked', xy: '??', path: 'README.md' },
  ],
};

const EXTRAS: StatusExtras = {
  stashes: [{ ref: 'stash@{0}', subject: 'WIP on main: abc1234 msg' }],
  remotes: [{ name: 'origin', url: 'git@github.com:u/r.git' }],
  upstream: { ref: 'origin/main', ahead: 2, behind: 5 },
};

function lineIndexOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `line "${needle}" not found`);
  return index + 1; // 1-based, like cursor positions in commands
}

function filePathAt(rendered: RenderedStatus, line: number): string | undefined {
  const target = rendered.targets.get(line);
  return target?.kind === 'file' ? target.path : undefined;
}

function pathsOf(rendered: RenderedStatus, line: number): string[] {
  // The cursor sits at the left edge, so the lookup answers for the file side —
  // a line can also carry a row of the right-hand column.
  return resolveTargets(rendered, line, line, 0).targets.map((target) => (target.kind === 'file' ? target.path : target.kind));
}

/** The file-side text of a line: everything left of the right-hand column. */
function leftOf(rendered: RenderedStatus, line: number): string {
  const text = rendered.text.split('\n')[line - 1] ?? '';
  return rendered.columnStart > 0 ? text.slice(0, rendered.columnStart) : text;
}

describe('renderStatus', () => {
  it('renders sections, headers and the key hints', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    // The divergence of the tracked branch is part of the branch line: as a row
    // of its own under the remote it pushed the column past the URL beside it.
    assert.ok(rendered.text.includes('BRANCH: main  origin/main: +2 −5'));
    assert.ok(!rendered.text.includes('(ahead 2'), 'the plain counters give way to the named upstream');
    assert.equal(lineIndexOf(rendered.text, 'origin/main: +2 −5'), 1, 'and they sit on the header line');
    assert.ok(rendered.text.includes('## staged (1)'));
    assert.ok(rendered.text.includes('## unstaged (2)'));
    assert.ok(rendered.text.includes('## untracked (1)'));
    assert.ok(rendered.text.includes('s stage'));
    assert.ok(rendered.text.includes('z stash'));
    assert.ok(!rendered.text.includes('## conflicts'), 'empty sections are skipped');
  });

  it('renders stash, remotes and tags with their entries', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    assert.ok(rendered.text.includes('## stash (1)'));
    assert.ok(rendered.text.includes('stash@{0}'));
    assert.ok(rendered.text.includes('## remotes (1)'));
    assert.ok(rendered.text.includes('git@github.com:u/r.git'));
  });

  it('draws the stash block even when it is empty, so the keys stay reachable', () => {
    const rendered = renderStatus('/repo', { ahead: 0, behind: 0, entries: [] }, {
      stashes: [],
      remotes: [],
    });
    assert.ok(rendered.text.includes('(clean working tree)'));
    assert.ok(rendered.text.includes('## stash (0)'), 'the empty stash block is drawn');
    assert.ok(rendered.text.includes('no stashes yet'), 'and says why it is empty');
    assert.ok(rendered.text.includes('z stash'), 'the keys that make the first stash are on screen');
    assert.ok(rendered.text.includes('## remotes (0)'), 'the remotes block stays reachable');
  });

  it('keeps the three file sections on screen when they are empty', () => {
    const rendered = renderStatus('/repo', { ahead: 0, behind: 0, entries: [] }, {
      stashes: [],
      remotes: [],
    });
    for (const section of ['staged', 'unstaged', 'untracked']) {
      assert.ok(rendered.text.includes(`## ${section} (0)`), `missing empty section: ${section}`);
    }
  });

  it('keeps the layout still: a file joining a section only adds a row', () => {
    const repo = { ahead: 0, behind: 0 };
    const empty = renderStatus('/repo', { ...repo, entries: [] }, { stashes: [], remotes: [] });
    const one = renderStatus(
      '/repo',
      { ...repo, entries: [{ xy: '??', path: 'NOTES.md', section: 'untracked' }] },
      { stashes: [], remotes: [] }
    );
    const header = '## untracked';
    const emptyAt = lineIndexOf(empty.text, header);
    const oneAt = lineIndexOf(one.text, header);
    assert.equal(emptyAt, oneAt, 'the untracked header sits on the same line in both states');
    assert.ok(one.text.split('\n')[oneAt + 2].includes('NOTES.md'), 'the row lands under the unchanged hint line');
  });

  it('still hides the conflict section when there is none', () => {
    const rendered = renderStatus('/repo', { ahead: 0, behind: 0, entries: [] }, { stashes: [], remotes: [] });
    assert.ok(!rendered.text.includes('## conflicts'), 'conflicts are the exception: their absence is normal');
  });

  it('gives an empty section its keys, so the block does not collapse', () => {
    const rendered = renderStatus('/repo', { ahead: 0, behind: 0, entries: [] }, { stashes: [], remotes: [] });
    const untrackedAt = lineIndexOf(rendered.text, '## untracked');
    assert.ok(rendered.text.split('\n')[untrackedAt].includes('s stage'), 'hint line stays under the header');
    assert.ok(rendered.text.split('\n')[untrackedAt + 1].startsWith('  ─'), 'the hairline closes the block');
  });

  it('maps every file line to a target and every header to a section', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const unstagedHeader = lineIndexOf(rendered.text, '## unstaged (2)');
    assert.equal(rendered.sectionLines.get(unstagedHeader), 'unstaged');

    const firstFile = lineIndexOf(rendered.text, 'M src/app.ts');
    assert.equal(filePathAt(rendered, firstFile), 'src/app.ts');
  });

  it('counts lines consistently: header, hint, hairline, then entries', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const unstagedHeader = lineIndexOf(rendered.text, '## unstaged (2)');
    assert.ok(rendered.text.split('\n')[unstagedHeader].includes('s stage'), 'hint right under the header');
    assert.match(leftOf(rendered, unstagedHeader + 2).trimEnd(), /^ {2}─+$/, 'hairline under the hint');
    assert.equal(filePathAt(rendered, unstagedHeader + 3), 'src/app.ts');
    assert.equal(filePathAt(rendered, unstagedHeader + 4), 'src/second.ts');
  });

  it('maps stash, remote and tag lines to their own target kinds', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);

    // The cursor of a row of the column sits inside the column, and the cell
    // under it answers — a file row drawn to the left of it must not.
    const stashLine = lineIndexOf(rendered.text, 'stash@{0}');
    assert.equal(targetAtCell(rendered, stashLine, rendered.columnStart + 4)?.kind, 'stash');

    const remoteLine = lineIndexOf(rendered.text, 'git@github.com:u/r.git');
    assert.equal(targetAtCell(rendered, remoteLine, rendered.columnStart + 4)?.kind, 'remote');
  });

  it('colours every title with its own kind and keeps the ## quiet', () => {
    const trees: WorktreeEntry[] = [
      { path: '/repo', head: 'abc1234', branch: 'main', bare: false, detached: false, locked: false, prunable: false },
      { path: '/repo-feature', head: 'def5678', branch: 'feature-x', bare: false, detached: false, locked: false, prunable: false },
    ];
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees: trees });
    const lines = rendered.text.split('\n');

    const titles: Array<[string, string]> = [
      ['## staged', 'staged'],
      ['## unstaged', 'unstaged'],
      ['## untracked', 'untracked'],
      ['## remotes', 'remotes'],
      // Both blocks stand in one column, so their headings share a colour.
      ['## worktrees', 'remotes'],
    ];
    for (const [title, kind] of titles) {
      const line = lines.findIndex((text) => text.includes(title));
      assert.ok(line >= 0, `${title} is on screen`);
      const titleSpan = rendered.spans.find((span) => span.line === line && span.kind === kind);
      assert.ok(titleSpan, `${title}: the title carries the ${kind} kind`);
      assert.equal(titleSpan.start, lines[line].indexOf(title) + 3, `${title}: the colour starts after "## "`);
      assert.ok(
        lines[line].slice(titleSpan.start, titleSpan.end).startsWith(title.slice(3)),
        `${title}: the coloured range covers the title`
      );
      const marker = rendered.spans.find((span) => span.line === line && span.kind === 'meta' && span.end === titleSpan.start - 1);
      assert.ok(marker, `${title}: ## is a meta span`);
      assert.equal(marker.end - marker.start, 2, `${title}: ## is a two-character meta span`);
    }
  });

  it('paints every file row in the colour of its own section', () => {
    const lines = renderStatus('/repo', STATUS, EXTRAS).text.split('\n');
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const expected: Array<[string, string]> = [
      ['src/app.ts', 'staged'],
      ['src/second.ts', 'unstaged'],
      ['README.md', 'untracked'],
    ];
    for (const [path, kind] of expected) {
      const line = lines.findIndex((text) => text.includes(path));
      assert.ok(line >= 0, `${path} is on screen`);
      const span = rendered.spans.find((candidate) => candidate.line === line && candidate.kind === kind);
      assert.ok(span, `${path} is painted as ${kind}`);
      assert.equal(lines[line].slice(span.start, span.end), path, `${path}: the coloured range is the path itself`);
    }
  });

  it('gives the conflict section one colour for its title and its rows', () => {
    const conflicted = renderStatus('/repo', {
      ahead: 0,
      behind: 0,
      entries: [{ section: 'conflict', xy: 'UU', path: 'src/conflict.ts' }],
    }, { stashes: [], remotes: [] });
    const lines = conflicted.text.split('\n');
    const header = lines.findIndex((text) => text.startsWith('## conflicts'));
    assert.ok(header >= 0, 'the conflict section is on screen');
    assert.ok(
      conflicted.spans.some((span) => span.line === header && span.kind === 'file-conflict'),
      'the conflict title takes the conflict colour'
    );
    const row = lines.findIndex((text) => text.endsWith('src/conflict.ts'));
    assert.ok(
      conflicted.spans.some((span) => span.line === row && span.kind === 'file-conflict'),
      'and so does the conflicted path'
    );
  });

  it('never paints the row metadata over the path', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const lines = rendered.text.split('\n');
    const line = lines.findIndex((candidate) => candidate.includes('src/second.ts'));
    assert.ok(line >= 0, 'the second unstaged file is on screen');

    const path = rendered.spans.find((span) => span.kind === 'unstaged' && span.line === line);
    assert.ok(path, 'the row path has a span of its own');
    for (const span of rendered.spans.filter((candidate) => candidate.line === line && candidate.kind === 'meta')) {
      assert.ok(span.start >= path.end || span.end <= path.start, 'the metadata never overlaps the path');
    }
  });

  it('greys the hints and draws a hairline under them', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const lines = rendered.text.split('\n');
    const header = lines.findIndex((line) => line.startsWith('## unstaged'));

    const hint = rendered.spans.find((span) => span.line === header + 1 && span.kind === 'help');
    assert.ok(hint, 'the hint line is a help span');
    assert.equal(hint.start, 2, 'the indent stays out of the hint span');
    assert.equal(hint.end, leftOf(rendered, header + 2).trimEnd().length);

    const rule = rendered.spans.find((span) => span.line === header + 2 && span.kind === 'rule');
    assert.ok(rule, 'the hairline has its own kind');
    assert.match(leftOf(rendered, header + 3).trimEnd(), /^ {2}─+$/, 'the hairline is dashes under the hint');
    assert.ok(lines[header + 1].includes('s stage'), 'the hint is the line above');
    assert.equal(rule.start, 2);
    assert.equal(rule.end, leftOf(rendered, header + 3).trimEnd().length);
    assert.equal(
      rule.end - rule.start,
      leftOf(rendered, header + 2).trimEnd().length - 2,
      'the hairline matches the hint width'
    );
  });

  it('splits the divergence into ahead and behind colours', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const lines = rendered.text.split('\n');
    const line = lines.findIndex((text) => text.includes('origin/main: +2 −5'));
    assert.ok(line >= 0, 'the divergence is on screen');

    const spanOf = (kind: string): { start: number; end: number } => {
      const span = rendered.spans.find((candidate) => candidate.line === line && candidate.kind === kind);
      assert.ok(span, `missing ${kind} span on the divergence line`);
      return span;
    };
    const add = spanOf('add');
    const del = spanOf('del');
    const upstream = spanOf('upstream');
    assert.equal(lines[line].slice(add.start, add.end), '+2', 'ahead uses the add colour');
    assert.equal(lines[line].slice(del.start, del.end), '−5', 'behind uses the delete colour');
    assert.equal(lines[line].slice(upstream.start, upstream.end), 'origin/main: ', 'the mapping has its own colour, not the ref one');
    assert.ok(!rendered.spans.some((candidate) => candidate.line === line && candidate.kind === 'refs'), 'refs stay for commits');
    assert.ok(!rendered.spans.some((span) => span.line === line && span.kind === 'hunk'), 'no single label spanning the whole divergence');
  });

  it('leaves the stash message, the remote URL and the worktree path as plain text', () => {
    // They should read like the subject of a commit in the history screen,
    // which is painted by the editor and not by us.
    const trees: WorktreeEntry[] = [
      { path: '/repo', head: 'abc1234', branch: 'main', bare: false, detached: false, locked: false, prunable: false },
      { path: '/repo-feature', head: 'def5678', branch: 'feature-x', bare: false, detached: false, locked: false, prunable: false },
    ];
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees: trees });
    const painted = (line: number, start: number, end: number): boolean =>
      rendered.spans.some((span) => span.line === line - 1 && span.start < end && span.end > start);

    const lines = rendered.text.split('\n');
    const cases: Array<[string, string]> = [
      ['stash@{0}', 'WIP on main: abc1234 msg'],
      ['git@github.com:u/r.git', 'git@github.com:u/r.git'],
      ['/repo-feature', '/repo-feature'],
    ];
    for (const [needle, plain] of cases) {
      const index = lines.findIndex((line) => line.includes(needle));
      assert.ok(index >= 0, `line with ${needle} not found`);
      const start = lines[index].indexOf(plain);
      assert.ok(start > 0, `${needle} is on screen`);
      assert.equal(painted(index + 1, start, start + plain.length), false, `${needle} is painted by a span`);
    }
  });

  it('adds colour spans for branch, hash and status codes', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const kinds = new Set(rendered.spans.map((span) => span.kind));
    for (const kind of ['branch', 'hash', 'section', 'meta', 'help', 'file-modified', 'file-untracked']) {
      assert.ok(kinds.has(kind as never), `missing span kind ${kind}`);
    }

    const firstFile = lineIndexOf(rendered.text, 'M src/app.ts');
    const xySpan = rendered.spans.find((span) => span.line === firstFile - 1 && span.start === 2);
    assert.ok(xySpan);
    assert.equal(xySpan.end, 4);
  });
});

describe('resolveTargets', () => {
  it('resolves a section header to the whole group', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const header = lineIndexOf(rendered.text, '## unstaged (2)');
    const resolved = resolveTargets(rendered, header, header);
    assert.equal(resolved.kind, 'section');
    assert.equal(resolved.section, 'unstaged');
    assert.deepEqual(pathsOf(rendered, header), ['src/app.ts', 'src/second.ts']);
  });

  it('resolves a single entry line', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const line = lineIndexOf(rendered.text, 'README.md');
    const resolved = resolveTargets(rendered, line, line);
    assert.equal(resolved.kind, 'files');
    assert.deepEqual(pathsOf(rendered, line), ['README.md']);
  });

  it('resolves a multi-line selection to all entries inside it', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const from = lineIndexOf(rendered.text, '## unstaged (2)');
    const to = from + 3;
    const resolved = resolveTargets(rendered, from, to);
    assert.equal(resolved.kind, 'files');
    assert.deepEqual(pathsOf(rendered, from).slice(0, 2), ['src/app.ts', 'src/second.ts']);
  });

  it('resolves nothing for a blank line', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const resolved = resolveTargets(rendered, 4, 4);
    assert.equal(resolved.kind, 'none');
    assert.deepEqual(resolved.targets, []);
  });

  it('accepts a reversed selection', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const from = lineIndexOf(rendered.text, '## staged (1)');
    const to = from + 2;
    assert.deepEqual(resolveTargets(rendered, to, from), resolveTargets(rendered, from, to));
  });

  it('resolves the stash header to stash targets only', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const header = lineIndexOf(rendered.text, '## stash (1)');
    const column = rendered.columnStart + 3;
    const resolved = resolveTargets(rendered, header, header, column);
    assert.equal(resolved.kind, 'section');
    assert.equal(resolved.section, 'stash');
    assert.deepEqual(
      resolved.targets.map((target) => target.kind),
      ['stash']
    );
    // The title of the column can share its line with a title of the file side:
    // the cursor column decides which one answers.
    assert.equal(resolveTargets(rendered, header, header, 0).section, 'unstaged');
  });
});

describe('renderStatus on a clean tree', () => {
  it('shows the clean marker and no file targets', () => {
    const rendered = renderStatus('/repo', { ahead: 0, behind: 0, entries: [] });
    assert.ok(rendered.text.includes('(clean working tree)'));
    assert.equal(rendered.targets.size, 0);
    // The three headers are on screen even when empty, so they still resolve.
    assert.equal(rendered.sectionLines.size, 3);
  });
});

describe('right column', () => {
  it('puts key hints in a right-hand column', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const lines = rendered.text.split('\n');
    assert.ok(lines[0].includes('keys'), 'hints header sits on the first line');
    assert.ok(lines[1].includes('c commit'));
    assert.ok(lines[1].indexOf('c commit') > 40, 'global hints live in the right-hand column');
    assert.ok(rendered.spans.some((span) => span.line === 0 && span.kind === 'section'));
  });

  it('keeps hints on the right when there are no actions', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    assert.ok(rendered.text.includes('c commit'));
    assert.ok(rendered.text.includes('s stage'), 'section hints stay under their section');
    assert.ok(!rendered.text.includes('## recent actions'));
  });

  it('advertises the screens the status buffer can open', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    for (const hint of ['b branches', 'T tags', 'S submodules', 'F pulls']) {
      assert.ok(rendered.text.includes(hint), `missing hint: ${hint}`);
    }
    // `t` creates a tag, `T` opens the tags screen: the hint has to say which is
    // which, and `g` is not a screen — it draws the commits listed below.
    assert.ok(rendered.text.includes('t tag'), 'the tag creation key is advertised');
    assert.ok(!rendered.text.includes('t tags'), 'and it is not confused with the tags screen');
    assert.ok(!rendered.text.includes('g graph'), 'the graph key is still with the commits it draws');
  });

  it('keeps the graph key with the commits it draws', () => {
    const extras: StatusExtras = {
      ...EXTRAS,
      commits: [{ shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'me', subject: 'first' }],
    };
    const lines = renderStatus('/repo', STATUS, extras).text.split('\n');
    const header = lines.findIndex((line) => line.includes('## last commits (1)'));
    assert.ok(header >= 0);
    assert.ok(lines[header + 1].startsWith('  g graph'), 'the hint sits under the block title');
    assert.match(lines[header + 2], /^ {2}─+$/, 'and closes with the hairline every block has');
    const hint = renderStatus('/repo', STATUS, extras).spans.find(
      (span) => span.line === header + 1 && span.kind === 'help'
    );
    assert.ok(hint, 'the hint keeps the hint colour');
  });

  it('advertises them on the git init screen too', () => {
    const rendered = renderUninitialized('/empty');
    assert.ok(rendered.text.includes('S submodules'), rendered.text);
    assert.ok(rendered.text.includes('F pulls'), rendered.text);
  });
});

describe('recent actions section', () => {
  it('renders the actions at the bottom, under the commit list', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS, ['fetch origin', 'push origin main']);
    const lines = rendered.text.split('\n');
    const headerIndex = lines.findIndex((line) => line.includes('## recent actions (2)'));
    assert.ok(headerIndex > 0);

    const commitHeader = lines.findIndex((line) => line.includes('## last commits') || line.includes('## staged'));
    assert.ok(commitHeader < headerIndex, 'actions come after the history');

    assert.ok(lines[headerIndex + 3].includes('fetch origin'));
    assert.ok(lines[headerIndex + 4].includes('push origin main'));
  });
});
describe('commits section', () => {
  it('lists the last commits of the current branch', () => {
    const extras: StatusExtras = {
      ...EXTRAS,
      commits: [
        { shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'mercury', subject: 'isolate WireGuard state' },
        { shortSha: 'def5678', date: '2026-11-13 10:02', author: 'Ann Author', subject: 'fix typo' },
      ],
    };
    const rendered = renderStatus('/repo', STATUS, extras);
    assert.ok(rendered.text.includes('## last commits (2)'));
    assert.ok(rendered.text.includes('abc1234'));
    assert.ok(rendered.text.includes('2026-11-14 20:11'));
    assert.ok(rendered.text.includes('isolate WireGuard state'));
    assert.ok(rendered.text.includes('mercury'), 'the author is shown like in the graph');
  });

  it('keeps the author column as tight as the history graph', () => {
    const extras: StatusExtras = {
      ...EXTRAS,
      commits: [
        { shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'me', subject: 'first' },
        { shortSha: 'def5678', date: '2026-11-13 10:02', author: 'Ann Author', subject: 'second' },
      ],
    };
    const lines = renderStatus('/repo', STATUS, extras).text.split('\n');
    // The header line also carries the HEAD sha, so match the commit row itself.
    const first = lines.find((line) => line.includes('abc1234') && line.includes('first')) ?? '';
    const second = lines.find((line) => line.includes('def5678') && line.includes('second')) ?? '';
    assert.equal(first.indexOf('first'), second.indexOf('second'), 'subjects start in the same column');
    const authorStart = first.indexOf('me');
    assert.equal(first.indexOf('first') - (authorStart + 'me'.length), 10, 'only the gap is left after a short name');
    assert.ok(first.includes('me        '), 'the short name is padded to the shared width');
  });

  it('tags the author column with the author colour, not the subject', () => {
    const extras: StatusExtras = {
      ...EXTRAS,
      commits: [{ shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'mercury', subject: 'subject' }],
    };
    const rendered = renderStatus('/repo', STATUS, extras);
    const index = rendered.text.split('\n').findIndex((line) => line.includes('mercury'));
    const authorSpans = rendered.spans.filter((span) => span.line === index && span.kind === 'author');
    assert.equal(authorSpans.length, 1);
    assert.equal(rendered.text.split('\n')[index].slice(authorSpans[0].start, authorSpans[0].end), 'mercury');
  });

  it('skips the section without commits', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    assert.ok(!rendered.text.includes('last commits'));
  });

  it('points every commit row at the commit it shows, so `t` can tag it', () => {
    const extras: StatusExtras = {
      ...EXTRAS,
      commits: [
        { sha: 'abc1234def', shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'me', subject: 'first' },
        { sha: 'def5678abc', shortSha: 'def5678', date: '2026-11-13 10:02', author: 'me', subject: 'second' },
      ],
    };
    const rendered = renderStatus('/repo', STATUS, extras);
    const lines = rendered.text.split('\n');
    // The dates, not the subjects: `second` also matches the path `src/second.ts`.
    const first = lineIndexOf(rendered.text, '20:11');
    const second = lineIndexOf(rendered.text, '10:02');
    assert.deepEqual(rendered.commitLines.get(first), { ref: 'abc1234def', shortSha: 'abc1234', subject: 'first' });
    assert.deepEqual(rendered.commitLines.get(second), { ref: 'def5678abc', shortSha: 'def5678', subject: 'second' });
    assert.equal(rendered.commitLines.size, 2, 'only the rows carry a commit');
    const hint = lines.findIndex((line) => line.startsWith('## last commits'));
    assert.equal(rendered.commitLines.has(hint + 1), false, 'the hint line under the title is not a commit');
    assert.equal(rendered.commitLines.has(hint + 2), false, 'nor is the hairline');
    assert.equal(rendered.targets.has(first), false, 'a commit row is not a clickable target for file keys');
  });

  it('falls back to the short sha when the extras carry no full one', () => {
    const extras: StatusExtras = {
      ...EXTRAS,
      commits: [{ shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'me', subject: 'first' }],
    };
    const rendered = renderStatus('/repo', STATUS, extras);
    const line = lineIndexOf(rendered.text, '20:11');
    assert.equal(rendered.commitLines.get(line)?.ref, 'abc1234', 'git resolves an abbreviated sha on its own');
  });
});

/** Target under the first occurrence of `needle`, resolved by column like a click. */
function cellAt(rendered: RenderedStatus, needle: string): StatusTarget | undefined {
  const lines = rendered.text.split('\n');
  const lineIndex = lines.findIndex((line) => line.includes(needle));
  assert.ok(lineIndex >= 0, `line "${needle}" not found`);
  return targetAtCell(rendered, lineIndex + 1, lines[lineIndex].indexOf(needle));
}

describe('worktrees section', () => {
  const worktrees: WorktreeEntry[] = [
    { path: '/repo', head: 'abc1234', branch: 'main', bare: false, detached: false, locked: false, prunable: false },
    { path: '/repo-feature', head: 'def5678', branch: 'feature-x', bare: false, detached: false, locked: false, prunable: false },
  ];

  it('lists every worktree and marks the current one', () => {
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees });
    assert.ok(rendered.text.includes('## worktrees (2)'));
    assert.ok(rendered.text.includes('* main'));
    assert.ok(rendered.text.includes('feature-x'));
    assert.ok(rendered.text.includes('/repo-feature'));
    assert.ok(!rendered.text.includes('* feature-x'), 'only the current worktree gets the star');
  });

  it('stands under remotes in the column beside the files', () => {
    const extras: StatusExtras = {
      ...EXTRAS,
      worktrees,
      commits: [{ shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'me', subject: 'first' }],
    };
    const rendered = renderStatus('/repo', STATUS, extras);
    const lines = rendered.text.split('\n');
    const remotesHeader = lines.findIndex((line) => line.includes('## remotes (1)'));
    const worktreesHeader = lines.findIndex((line) => line.includes('## worktrees (2)'));
    assert.ok(remotesHeader >= 0, 'remotes are on screen');
    assert.ok(worktreesHeader > remotesHeader, 'worktrees come after remotes, not beside them');
    assert.equal(
      lines[remotesHeader].indexOf('## remotes'),
      lines[worktreesHeader].indexOf('## worktrees'),
      'both headings start in one column'
    );
    assert.ok(rendered.columnStart > 2, 'the column has its own start');
    assert.equal(lines[remotesHeader].indexOf('## remotes'), rendered.columnStart, 'the heading starts the column');

    const stagedHeader = lines.findIndex((line) => line.startsWith('## staged'));
    assert.ok(remotesHeader >= stagedHeader, 'the column does not start above the staged title');
    assert.ok(
      worktreesHeader < lines.findIndex((line) => line.startsWith('## last commits')),
      'the whole column stays above the commit list'
    );
  });

  /** The text of one line inside the right-hand column. */
  const columnAt = (rendered: RenderedStatus, index: number): string => {
    const line = rendered.text.split('\n')[index] ?? '';
    return line.slice(rendered.columnStart);
  };

  it('hints the new-window key with the other worktree keys, on one line', () => {
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees });
    const lines = rendered.text.split('\n');
    const header = lines.findIndex((line) => line.includes('## worktrees (2)'));
    // Only the column counts here: the file side draws hairlines of its own on
    // the same rows.
    let rule = header + 1;
    while (!columnAt(rendered, rule).includes('───')) {
      rule++;
    }
    const keys = columnAt(rendered, header + 1);

    assert.ok(keys.includes('n add'), 'the keys are right under the header');
    assert.ok(keys.includes('S-Enter window'), 'the new-window key sits with the other keys');
    assert.ok(keys.indexOf('S-Enter window') > keys.indexOf('enter switch'), 'it follows the plain enter');
    assert.ok(keys.includes('A-Enter here'), 'the same-window key sits next to it');
    assert.ok(keys.indexOf('A-Enter here') > keys.indexOf('S-Enter window'), 'and after the new-window one');
    assert.equal(rule, header + 2, 'the hint is one line, so the hairline closes it right away');
    assert.ok(!rendered.text.includes('S-Enter:'), 'no extra hint line under the rows');
  });

  it('underlines the block hints and puts the rows right below the line', () => {
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees });
    const lines = rendered.text.split('\n');

    for (const title of ['## remotes', '## worktrees', '## stash']) {
      const header = lines.findIndex((_line, index) => columnAt(rendered, index).includes(title));
      assert.ok(header >= 0, `${title} is on screen`);
      assert.ok(lines[header].length > rendered.columnStart, `${title}: the title opens the column`);
      let rule = header + 1;
      while (!columnAt(rendered, rule).includes('───')) {
        rule++;
      }
      assert.equal(rule, header + 2, `${title}: one hint line, then the hairline`);
      assert.ok(columnAt(rendered, rule).trim().startsWith('───'), `${title}: the hairline sits in the column`);
      assert.ok(columnAt(rendered, rule + 1).trim().length > 0, `${title}: the rows are not pushed away`);
    }
  });

  it('maps rows to worktree targets with the current flag', () => {
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees });
    const current = cellAt(rendered, '* main');
    assert.equal(current?.kind, 'worktree');
    assert.equal(current?.kind === 'worktree' && current.current, true);
    assert.equal(current?.kind === 'worktree' && current.path, '/repo');

    const other = cellAt(rendered, '/repo-feature');
    assert.equal(other?.kind, 'worktree');
    assert.equal(other?.kind === 'worktree' && other.current, false);
  });

  it('picks the cell of the row under the cursor', () => {
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees });
    const remoteLine = lineIndexOf(rendered.text, 'git@github.com:u/r.git');
    const remoteRow = rendered.text.split('\n')[remoteLine - 1];
    assert.equal(targetAtCell(rendered, remoteLine, remoteRow.indexOf('origin'))?.kind, 'remote');
    assert.equal(
      resolveTargets(rendered, remoteLine, remoteLine, remoteRow.indexOf('origin')).targets[0].kind,
      'remote',
      'a cursor on the remote finds the remote, even when a file row shares the line'
    );

    const worktreeLine = lineIndexOf(rendered.text, '/repo-feature');
    const worktreeRow = rendered.text.split('\n')[worktreeLine - 1];
    assert.equal(targetAtCell(rendered, worktreeLine, worktreeRow.indexOf('/repo-feature'))?.kind, 'worktree');

    const selection = resolveTargets(
      rendered,
      worktreeLine,
      worktreeLine,
      worktreeRow.indexOf('/repo-feature')
    ).targets.map((target) => target.kind);
    assert.ok(selection.includes('worktree'), 'a row selection covers the worktree cell');
  });

  it('aligns the paths of differently named branches', () => {
    const lines = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees }).text.split('\n');
    const first = lines.find((line) => line.includes('* main')) ?? '';
    const second = lines.find((line) => line.includes('feature-x')) ?? '';
    assert.equal(first.indexOf('/repo'), second.indexOf('/repo-feature'), 'paths start in one column');
  });

  it('shows flags for locked, bare and prunable worktrees', () => {
    const flagged: WorktreeEntry[] = [
      { path: '/repo', head: '', branch: undefined, bare: false, detached: true, locked: true, prunable: false },
      { path: '/repo-gone', head: '', branch: undefined, bare: false, detached: false, locked: false, prunable: true },
    ];
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees: flagged });
    assert.ok(rendered.text.includes('locked'));
    assert.ok(rendered.text.includes('prunable'));
    assert.ok(rendered.text.includes('(detached)'));

    const gone = cellAt(rendered, '/repo-gone');
    assert.equal(gone?.kind === 'worktree' && gone.prunable, true);
  });

  it('keeps the left header resolvable to its own section', () => {
    const rendered = renderStatus('/repo', STATUS, { ...EXTRAS, worktrees });
    // `## remotes` can share its line with `## staged`: the column decides.
    const header = lineIndexOf(rendered.text, '## remotes (1)');
    const inColumn = resolveTargets(rendered, header, header, rendered.columnStart + 3);
    assert.equal(inColumn.kind, 'section');
    assert.equal(inColumn.section, 'remotes');
    assert.deepEqual(
      inColumn.targets.map((target) => (target.kind === 'remote' ? target.name : target.kind)),
      ['origin']
    );
    assert.equal(
      resolveTargets(rendered, header, header, 0).section,
      'staged',
      'a cursor at the left edge still answers for the file section on that line'
    );
  });

  it('draws the remotes block for a repository without remotes, so the first one can be added', () => {
    const rendered = renderStatus('/repo', STATUS, { stashes: [], remotes: [], worktrees });
    const lines = rendered.text.split('\n');
    const header = lines.findIndex((line) => line.includes('## remotes (0)'));
    assert.ok(header >= 0, 'the block header is drawn even with zero remotes');
    assert.ok(lines[header + 1].includes('A add'), 'the hint line still offers the add key');
    assert.ok(rendered.text.includes('no remotes yet'), 'the empty block says why it is empty');
    assert.ok(
      lines.findIndex((line) => line.includes('## worktrees (2)')) > header,
      'worktrees follow the remotes block in the column'
    );
  });

  it('skips the section when worktrees are not provided or empty', () => {
    assert.ok(!renderStatus('/repo', STATUS, EXTRAS).text.includes('## worktrees'));
    assert.ok(!renderStatus('/repo', STATUS, { ...EXTRAS, worktrees: [] }).text.includes('## worktrees'));
  });
});

describe('status layout', () => {
  const layoutTrees: WorktreeEntry[] = [
    { path: '/repo', head: 'abc1234', branch: 'main', bare: false, detached: false, locked: false, prunable: false },
    { path: '/repo-feature', head: 'def5678', branch: 'feature-x', bare: false, detached: false, locked: false, prunable: false },
  ];
  const layoutExtras: StatusExtras = {
    ...EXTRAS,
    worktrees: layoutTrees,
    commits: [{ shortSha: 'abc1234', date: '2026-11-14 20:11', author: 'me', subject: 'first' }],
  };

  it('packs the global keys into three lines without losing one', () => {
    const lines = renderStatus('/repo', STATUS, layoutExtras).text.split('\n');
    const column = lines[0].indexOf('keys');
    assert.ok(column > 0, 'the key column has its header on the first line');

    // The packing follows the list: three lines tall, the keys spread evenly.
    const keys = t('hints.global').split(/\s{3,}/);
    const perLine = Math.max(2, Math.ceil(keys.length / 3));
    const packed = [1, 2, 3].map((line) => lines[line].slice(column).trim());
    packed.forEach((hint, index) => {
      const shown = hint.length > 0 ? hint.split(/\s{3,}/) : [];
      assert.equal(shown.length, Math.min(perLine, keys.length - index * perLine), `line ${index + 1} holds its share`);
    });
    assert.deepEqual(packed.join('   ').split(/\s{3,}/), keys, 'every key of the hint line is on screen, in order');
    assert.equal(lines[4].slice(column).includes(keys[0]), false, 'and nothing after the third line');
  });

  it('leaves one blank row between the blocks of the column, as on the file side', () => {
    const rendered = renderStatus('/repo', STATUS, layoutExtras);
    const lines = rendered.text.split('\n');
    const columnAt = (index: number): string => lines[index].slice(rendered.columnStart);
    const headerOf = (index: number): boolean => columnAt(index).trim().startsWith('##');
    const headers = lines.map((_line, index) => index).filter((index) => headerOf(index));
    assert.deepEqual(
      headers.map((index) => columnAt(index).trim().split(' ')[1]),
      ['remotes', 'worktrees', 'stash'],
      'the three blocks of the column, in order'
    );
    for (let index = 1; index < headers.length; index++) {
      const gap = headers[index] - headers[index - 1];
      assert.ok(gap > 3, `the ${index} pair of blocks is separated by a blank row`);
      assert.equal(columnAt(headers[index] - 1).trim(), '', 'the row before a block title is empty in the column');
      assert.ok(
        columnAt(headers[index] - 2).trim().length > 0,
        'and the row before that one is the last row of the previous block: exactly one blank row'
      );
      assert.equal(headerOf(headers[index] - 1), false);
    }
  });

  it('gives the cursor column the last word on a shared title line', () => {
    const rendered = renderStatus('/repo', STATUS, layoutExtras);
    const lines = rendered.text.split('\n');
    const shared = lines.findIndex(
      (line) => line.startsWith('## staged') && line.slice(rendered.columnStart).includes('## remotes')
    );
    assert.ok(shared >= 0, 'the fixture puts a title of each side on one line');
    assert.equal(resolveTargets(rendered, shared + 1, shared + 1, 0).section, 'staged');
    assert.equal(resolveTargets(rendered, shared + 1, shared + 1, rendered.columnStart + 3).section, 'remotes');
  });

  it('leaves a gutter between the file side and the column', () => {
    const rendered = renderStatus('/repo', STATUS, layoutExtras);
    const lines = rendered.text.split('\n');
    const hintLine = lines.findIndex((line) => line.startsWith('  s stage'));
    assert.ok(hintLine >= 0, 'the widest file line is on screen');
    const gap = rendered.columnStart - leftOf(rendered, hintLine + 1).trimEnd().length;
    assert.ok(gap >= 4, `the column clears the widest file line by ${gap} columns`);
    assert.ok(rendered.columnStart > 2, 'the column has a start of its own');
  });

  it('gives every section of the screen a one-line hint', () => {
    const rendered = renderStatus('/repo', STATUS, layoutExtras);
    const lines = rendered.text.split('\n');
    for (const title of ['## staged', '## unstaged', '## untracked', '## remotes', '## worktrees', '## stash', '## last commits']) {
      const header = lines.findIndex((line) => line.includes(title));
      assert.ok(header >= 0, `${title} is on screen`);
      const inColumn = lines[header].indexOf(title) >= rendered.columnStart;
      const part = (index: number): string => (inColumn ? lines[index].slice(rendered.columnStart) : lines[index]);
      assert.ok(part(header + 1).trim().length > 0, `${title}: the hint line is there`);
      assert.ok(part(header + 2).trimStart().startsWith('─'), `${title}: one hint line, then the hairline`);
      assert.equal(part(header + 3).trimStart().startsWith('─'), false, `${title}: the hairline is a single row`);
    }
  });

  it('stands the stash block in the column under the worktrees', () => {
    const rendered = renderStatus('/repo', STATUS, layoutExtras);
    const lines = rendered.text.split('\n');
    const worktreesLine = lines.findIndex((line) => line.includes('## worktrees'));
    const stashLine = lines.findIndex((line) => line.includes('## stash'));
    assert.ok(worktreesLine >= 0 && stashLine > worktreesLine, 'the stash block follows the worktrees');
    assert.ok(lines[worktreesLine].indexOf('## worktrees') >= rendered.columnStart, 'worktrees live in the column');
    assert.ok(lines[stashLine].indexOf('## stash') >= rendered.columnStart, 'so does the stash');
    assert.equal(
      lines.filter((line) => line.includes('## stash')).length,
      1,
      'the stash is drawn once: the block moved into the column, it was not copied'
    );
    assert.equal(targetAtCell(rendered, stashLine + 4, rendered.columnStart + 4)?.kind, 'stash');
  });

  it('keeps the stash block in the column when there is no stash', () => {
    const rendered = renderStatus('/repo', STATUS, { ...layoutExtras, stashes: [] });
    const lines = rendered.text.split('\n');
    const stashLine = lines.findIndex((line) => line.includes('## stash (0)'));
    assert.ok(stashLine >= 0, 'the empty stash block is in the column');
    assert.ok(lines[stashLine].indexOf('## stash') >= rendered.columnStart, 'and it is the column that holds it');
    assert.ok(rendered.text.includes('no stashes yet'), 'the block says why it is empty');
    assert.equal(
      [...rendered.targets.values()].filter((target) => target.kind === 'stash').length,
      0,
      'an empty block has no rows to act on'
    );
  });

  it('does not let a file answer for a cursor inside the column', () => {
    const rendered = renderStatus('/repo', STATUS, layoutExtras);
    const lines = rendered.text.split('\n');
    const shared = lines.findIndex(
      (line) =>
        line.slice(0, rendered.columnStart).trim().length > 0 &&
        line.slice(rendered.columnStart).includes('* main')
    );
    assert.ok(shared >= 0, 'the fixture draws a file row and a worktree row on one line');
    const left = resolveTargets(rendered, shared + 1, shared + 1, 3).targets.map((target) => target.kind);
    const right = resolveTargets(rendered, shared + 1, shared + 1, rendered.columnStart + 4).targets.map((target) => target.kind);
    assert.deepEqual(left, ['file'], 'the cursor on the path picks the file');
    assert.deepEqual(right, ['worktree'], 'the cursor in the column picks the worktree');
  });
});

describe('section headers and the right-hand column', () => {
  /** A status screen whose column can be made to land on any file-section line. */
  function layout(staged: number, unstaged: number, untracked: number, worktrees: number): RenderedStatus {
    const entries: RepoStatus['entries'] = [];
    for (let index = 0; index < staged; index++) {
      entries.push({ section: 'staged', xy: 'M ', path: `staged-${index}.ts` });
    }
    for (let index = 0; index < unstaged; index++) {
      entries.push({ section: 'unstaged', xy: ' M', path: `unstaged-${index}.ts` });
    }
    for (let index = 0; index < untracked; index++) {
      entries.push({ section: 'untracked', xy: '??', path: `untracked-${index}.ts` });
    }
    const trees: WorktreeEntry[] = [];
    for (let index = 0; index < worktrees; index++) {
      trees.push({
        path: `/worktree-${index}`,
        head: 'abc1234',
        branch: `branch-${index}`,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      });
    }
    return renderStatus('/repo', { branch: 'main', ahead: 0, behind: 0, head: 'abc1234', headSubject: 'x', entries }, {
      stashes: [{ ref: 'stash@{0}', subject: 'wip' }],
      remotes: [{ name: 'origin', url: 'git@github.com:u/r.git' }],
      worktrees: trees,
    });
  }

  it('resolves every section title in every layout the column can produce', () => {
    // The column pushes a row or a title onto the line of any file section, and a
    // cursor at the left edge of a title has to mean that section — otherwise `s`
    // on `## untracked` stages nothing because a worktree row shares the line.
    for (let staged = 0; staged <= 2; staged++) {
      for (let unstaged = 0; unstaged <= 2; unstaged++) {
        for (let untracked = 1; untracked <= 2; untracked++) {
          for (let worktrees = 0; worktrees <= 2; worktrees++) {
            const rendered = layout(staged, unstaged, untracked, worktrees);
            const shape = `${staged}/${unstaged}/${untracked}/${worktrees}`;
            const expected: Array<[string, number]> = [
              ['staged', staged],
              ['unstaged', unstaged],
              ['untracked', untracked],
            ];
            for (const [title, count] of expected) {
              const line = lineIndexOf(rendered.text, `## ${title} (`);
              const resolved = resolveTargets(rendered, line, line, 0);
              assert.equal(resolved.kind, 'section', `${title} in ${shape}`);
              assert.equal(resolved.section, title, `${title} in ${shape}`);
              assert.equal(resolved.targets.length, count, `${title} in ${shape} carries its files`);
            }
            // The other half of the rule: a cursor inside the column on a line
            // that carries a block title means that block, whatever the file side
            // has on the same line. An empty worktree list draws no block at all.
            for (const title of ['remotes', 'worktrees', 'stash']) {
              const index = rendered.text.split('\n').findIndex((line) => line.includes(`## ${title} (`));
              if (index < 0) {
                continue;
              }
              const resolved = resolveTargets(rendered, index + 1, index + 1, rendered.columnStart + 3);
              assert.equal(resolved.kind, 'section', `${title} from the column in ${shape}`);
              assert.equal(resolved.section, title, `${title} from the column in ${shape}`);
            }
          }
        }
      }
    }
  });

  it('answers with the file when a block title shares the row', () => {
    // The reported case: the last row of `unstaged` shares its line with the
    // `## stash` title of the column, and `d` has to diff that file rather than
    // report that the cursor is not on anything.
    const rendered = layout(1, 3, 0, 1);
    const lines = rendered.text.split('\n');
    const index = lines.findIndex((line) => line.includes('unstaged-2.ts'));
    assert.ok(index >= 0, 'the last unstaged row is on screen');
    const line = index + 1;
    assert.equal(rendered.sectionLines.get(line), 'stash', 'the stash block title shares the row');
    assert.equal(rendered.columnSections.get(line), 'stash', 'and it is the column that owns the title');

    const onTheRow = resolveTargets(rendered, line, line, 5);
    assert.equal(onTheRow.kind, 'files', 'a cursor on the row means the row');
    assert.deepEqual(
      onTheRow.targets.map((target) => (target.kind === 'file' ? target.path : target.kind)),
      ['unstaged-2.ts'],
      'so `d` diffs the file under the cursor'
    );

    const onTheTitle = resolveTargets(rendered, line, line, rendered.columnStart + 3);
    assert.equal(onTheTitle.section, 'stash', 'a cursor on the title in the column means the block');
  });

  it('resolves every file row in every layout the column can produce', () => {
    // A row can share its line with a column row or with a block title; the file
    // under the cursor answers in both cases.
    for (let staged = 0; staged <= 2; staged++) {
      for (let unstaged = 1; unstaged <= 3; unstaged++) {
        for (let untracked = 0; untracked <= 2; untracked++) {
          for (let worktrees = 0; worktrees <= 2; worktrees++) {
            const rendered = layout(staged, unstaged, untracked, worktrees);
            const lines = rendered.text.split('\n');
            const shape = `${staged}/${unstaged}/${untracked}/${worktrees}`;
            const rows: Array<[string, number]> = [
              ['staged', staged],
              ['unstaged', unstaged],
              ['untracked', untracked],
            ];
            for (const [section, count] of rows) {
              for (let row = 0; row < count; row++) {
                const path = `${section}-${row}.ts`;
                const index = lines.findIndex((line) => line.includes(path));
                assert.ok(index >= 0, `${path} is on screen in ${shape}`);
                for (const at of [0, 5]) {
                  const resolved = resolveTargets(rendered, index + 1, index + 1, at);
                  assert.equal(resolved.kind, 'files', `${path} at ${at} in ${shape}`);
                  assert.deepEqual(
                    resolved.targets.map((target) => (target.kind === 'file' ? target.path : target.kind)),
                    [path],
                    `${path} at ${at} in ${shape}`
                  );
                }
              }
            }
          }
        }
      }
    }
  });

  it('lets the cursor half decide when a column row shares a section line', () => {
    // This layout puts a worktree row on the `## untracked` line.
    const rendered = layout(0, 0, 1, 1);
    const line = lineIndexOf(rendered.text, '## untracked (1)');
    const cells = rendered.cells.get(line) ?? [];
    assert.deepEqual(cells.map((cell) => cell.target.kind), ['worktree'], 'the worktree row shares the line');

    const onTheTitle = resolveTargets(rendered, line, line, 0);
    assert.equal(onTheTitle.section, 'untracked', 'a cursor on the title means the section');
    assert.deepEqual(
      onTheTitle.targets.map((target) => (target.kind === 'file' ? target.path : target.kind)),
      ['untracked-0.ts'],
      'and it carries the files of that section, so `s` stages them'
    );

    const inTheColumn = resolveTargets(rendered, line, line, rendered.columnStart + 3);
    assert.deepEqual(inTheColumn.targets.map((target) => target.kind), ['worktree'], 'a cursor in the column means the row');
  });
});

describe('renderUninitialized', () => {
  it('shows the folder and a git init row instead of an error', () => {
    const rendered = renderUninitialized('D:/work/plain');
    assert.ok(rendered.text.includes('REPO: D:/work/plain'));
    assert.ok(rendered.text.includes('not a git repository yet'));
    assert.ok(rendered.text.includes('## init (1)'));
    assert.ok(rendered.text.includes('git init'), 'the action is visible in the buffer');
  });

  it('maps the action line to the init target', () => {
    const rendered = renderUninitialized('D:/work/plain');
    const actionLine = lineIndexOf(rendered.text, 'git init  —');
    const target = rendered.targets.get(actionLine);
    assert.equal(target?.kind, 'init');
    assert.deepEqual(
      resolveTargets(rendered, actionLine, actionLine).targets.map((entry) => entry.kind),
      ['init']
    );
    assert.equal(rendered.sectionLines.get(lineIndexOf(rendered.text, '## init')), 'init');
  });

  it('keeps the hint column and does not offer file actions', () => {
    const rendered = renderUninitialized('D:/work/plain');
    assert.ok(rendered.text.includes('keys'), 'the right column header is present');
    assert.equal([...rendered.targets.values()].filter((target) => target.kind === 'file').length, 0);
  });
});

describe('column integrity', () => {
  it('keeps a long line whole and moves only its own hint', () => {
    const longStatus: RepoStatus = {
      ...STATUS,
      headSubject: 'refactor(bot): isolate WireGuard instance state across calls and much more text that definitely overflows the configured hint column width',
    };
    const rendered = renderStatus('/repo', longStatus, EXTRAS);
    const lines = rendered.text.split('\n');
    const column = lines[0].indexOf('keys');
    assert.ok(column > 0);
    assert.ok(lines[1].includes('definitely overflows'), 'the long line is shown in full');
    assert.ok(!rendered.text.includes('…'), 'nothing is hidden behind an ellipsis');
    assert.ok(lines[1].indexOf('c commit') > column, 'the long line carries its hint further right');
    assert.equal(lines[2].indexOf('R reset'), lines[3].indexOf('t tags'), 'the other lines keep the column');
  });
});
function lineOfFile(rendered: RenderedStatus, section: string, path: string): number {
  for (const [line, target] of rendered.targets) {
    if (target.kind === 'file' && target.section === section && target.path === path) {
      return line;
    }
  }
  throw new Error(`no ${section} row for ${path}`);
}

describe('resolveSelections', () => {
  it('behaves exactly like resolveTargets for a single cursor', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const header = lineIndexOf(rendered.text, '## unstaged');
    assert.deepEqual(
      resolveSelections(rendered, [{ fromLine: header, toLine: header }]),
      resolveTargets(rendered, header, header)
    );
  });

  it('merges several cursors into one file list', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const app = lineOfFile(rendered, 'unstaged', 'src/app.ts');
    const readme = lineOfFile(rendered, 'untracked', 'README.md');
    const resolved = resolveSelections(rendered, [
      { fromLine: app, toLine: app },
      { fromLine: readme, toLine: readme },
    ]);
    assert.equal(resolved.kind, 'files');
    assert.deepEqual(
      resolved.targets.map((target) => (target.kind === 'file' ? `${target.section}:${target.path}` : target.kind)),
      ['unstaged:src/app.ts', 'untracked:README.md']
    );
    assert.equal(resolved.section, undefined, 'a mixed selection has no single section');
  });

  it('counts a target once when cursors overlap', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const header = lineIndexOf(rendered.text, '## unstaged');
    const app = lineOfFile(rendered, 'unstaged', 'src/app.ts');
    const resolved = resolveSelections(rendered, [
      { fromLine: header, toLine: header },
      { fromLine: app, toLine: app },
    ]);
    assert.deepEqual(
      resolved.targets.map((target) => (target.kind === 'file' ? target.path : target.kind)),
      ['src/app.ts', 'src/second.ts']
    );
  });

  it('reports none for a cursor on a blank line', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const blank = rendered.text.split('\n').findIndex((line) => line.trim() === '') + 1;
    const resolved = resolveSelections(rendered, [{ fromLine: blank, toLine: blank }]);
    assert.equal(resolved.kind, 'none');
    assert.deepEqual(resolved.targets, []);
  });

  it('covers a section when one of its headers is hit', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    const header = lineIndexOf(rendered.text, '## staged');
    const second = lineOfFile(rendered, 'unstaged', 'src/second.ts');
    const resolved = resolveSelections(rendered, [
      { fromLine: header, toLine: header },
      // The cursor sits on the path, left of the column: a line can carry a row
      // of the column too, and the column must not answer for it.
      { fromLine: second, toLine: second, character: 3 },
    ]);
    assert.deepEqual(
      resolved.targets.map((target) => (target.kind === 'file' ? `${target.section}:${target.path}` : target.kind)),
      ['staged:src/app.ts', 'unstaged:src/second.ts']
    );
  });
});
describe('status badges', () => {
  const BADGED: StatusExtras = {
    ...EXTRAS,
    lfs: [{ path: 'src/second.ts', oid: '4d7a214' }],
    submodules: [
      { path: 'src/app.ts', sha: 'abc1234', state: 'ok' },
      { path: 'README.md', sha: 'abc1234', state: 'modified' },
    ],
  };

  it('marks an LFS-tracked file and leaves the others alone', () => {
    const rendered = renderStatus('/repo', STATUS, BADGED);
    const lfsLine = leftOf(rendered, lineOfFile(rendered, 'unstaged', 'src/second.ts')).trimEnd();
    assert.ok(lfsLine.endsWith('  lfs'), lfsLine);
    const plainLine = rendered.text.split('\n')[lineOfFile(rendered, 'untracked', 'README.md') - 1];
    assert.ok(!plainLine.includes('lfs'));
  });

  it('tells an up-to-date submodule from one that moved', () => {
    const rendered = renderStatus('/repo', STATUS, BADGED);
    const okLine = leftOf(rendered, lineOfFile(rendered, 'staged', 'src/app.ts')).trimEnd();
    const movedLine = leftOf(rendered, lineOfFile(rendered, 'untracked', 'README.md')).trimEnd();
    assert.ok(okLine.endsWith('  sub'), okLine);
    assert.ok(movedLine.endsWith('  sub+'), movedLine);
  });

  it('shows no badges when the extras say nothing about them', () => {
    const rendered = renderStatus('/repo', STATUS, EXTRAS);
    assert.ok(!rendered.text.includes('  lfs'));
    assert.ok(!rendered.text.includes('  sub'));
  });

  it('keeps the file target addressable regardless of the badges', () => {
    const rendered = renderStatus('/repo', STATUS, BADGED);
    const line = lineOfFile(rendered, 'unstaged', 'src/second.ts');
    assert.equal(filePathAt(rendered, line), 'src/second.ts');
    assert.deepEqual(pathsOf(rendered, line), ['src/second.ts']);
  });
});