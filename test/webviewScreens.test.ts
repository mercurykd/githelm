import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { BranchEntry } from '../src/git/actions';
import { logRows, parseLog } from '../src/git/log';
import type { ParsedLog } from '../src/git/log';
import type { TagEntry } from '../src/git/tags';
import { t } from '../src/i18n';
import { FILTER_FIELDS, fieldLabel } from '../src/views/logFilters';
import { buildBranchesModel } from '../src/webview/model/branches';
import { buildLogModel, highlightUnpushedTags, segmentsOf } from '../src/webview/model/log';
import { buildTagsModel } from '../src/webview/model/tags';
import { CAROUSEL, nextScreen } from '../src/webview/carousel';
import { resolveCommonKey, resolveScreenKey, SCREEN_KEYS, SCREEN_NEEDS_ROW } from '../src/webview/keys';

/**
 * The branches, tags and history screens as panels. Each model is built from the same git
 * data and the same strings the text buffer renders, so the two screens cannot say
 * different things about a branch or a tag; the keys are the buffer's keys, which is
 * what the panel sends to the host.
 */
const branch = (name: string, extra: Partial<BranchEntry> = {}): BranchEntry => ({
  name,
  current: false,
  upstream: '',
  ahead: 0,
  behind: 0,
  subject: '',
  isRemote: false,
  ...extra,
});

const tag = (name: string, extra: Partial<TagEntry> = {}): TagEntry => ({
  name,
  sha: 'abc1234',
  date: '2024-01-01',
  author: 'Ada',
  subject: 'a commit',
  ...extra,
});

const cached = [branch('main', { current: true, upstream: 'origin/main', subject: 'first' }), branch('topic')];
const remotes = [branch('origin/main', { isRemote: true, subject: 'first' }), branch('origin/topic', { isRemote: true })];

/**
 * A line of `git log --graph --format=…`, which is what the log parser reads: the graph
 * prefix, then the fields `%H %h %P %an %ad %s %D` separated by the field marker.
 */
const logLine = (
  graph: string,
  shortSha: string,
  author: string,
  date: string,
  subject: string,
  refs: string[] = []
): string => `${graph}\x1f${shortSha}${shortSha}\x1f${shortSha}\x1f\x1f${author}\x1f${date}\x1f${subject}\x1f${refs.join(', ')}`;

/** Two commits, the first one carrying the branch, exactly as `git log` prints them. */
const history = (): ParsedLog =>
  parseLog(
    [
      logLine('* ', 'abc1234', 'Ada', '2024-01-01 10:00', 'first commit', ['HEAD -> main', 'tag: v1']),
      logLine('* ', 'def5678', 'Bob', '2024-01-02 11:00', 'second commit'),
    ].join('\n')
  );

const logModel = (parsed: ParsedLog = history(), limit = 200): ReturnType<typeof buildLogModel> =>
  buildLogModel({ repoPath: '/repo', parsed, all: false, filter: {}, sort: 'topo', limit });

describe('branches screen as a panel', () => {
  it('shows the local branches first, with the current one marked', () => {
    const model = buildBranchesModel('/repo', [...cached, ...remotes], false);
    assert.equal(model.kind, 'branches');
    assert.equal(model.blocks.length, 1, 'remotes are hidden until a');
    const rows = model.blocks[0].rows;
    assert.deepEqual(
      rows.map((row) => row.text),
      ['main', 'topic']
    );
    assert.equal(rows[0].marker, '*', 'the current branch carries the same marker as the buffer');
    assert.equal(rows[1].marker, ' ');
    assert.equal(rows[0].role, 'branch');
    assert.equal(rows[1].role, 'modified');
  });

  it('groups the remote branches by remote, in name order', () => {
    const model = buildBranchesModel('/repo', [...cached, ...remotes], true);
    assert.equal(model.blocks.length, 2);
    assert.match(model.blocks[1].title, /origin/, 'the remote block names the remote');
    assert.equal(model.blocks[1].rows.length, 2);
    assert.deepEqual(model.facts, [], 'no count line: the block heading carries the count');
    assert.ok(model.title.includes(t('log.titleAll')), 'the title says remotes are shown, like the buffer');
  });

  it('prints the tracking label after the name and the subject underneath', () => {
    const model = buildBranchesModel('/repo', cached, false);
    const row = model.blocks[0].rows[0];
    assert.equal(row.parts?.[0].role, 'hunk', 'the tracking column is the buffer’s hunk colour');
    assert.match(row.parts?.[0].text ?? '', /origin\/main/);
    assert.equal(row.note, 'first');
    assert.equal(row.noteRole, 'meta');
    assert.equal(model.blocks[0].rows[1].note, undefined, 'a branch with no commit yet has no subject');
  });

  it('says what an unborn branch is, as the buffer does', () => {
    const model = buildBranchesModel('/repo', [branch('main', { current: true, unborn: true })], false);
    assert.equal(model.blocks[0].rows[0].note, t('branches.unborn'));
  });

  it('names each row by the branch, so the host can look it up again', () => {
    const model = buildBranchesModel('/repo', [...cached, ...remotes], true);
    const ids = model.blocks.flatMap((block) => block.rows.map((row) => row.id));
    assert.deepEqual(ids, ['branch:main', 'branch:topic', 'branch:origin/main', 'branch:origin/topic']);
  });

  it('keeps the buffer’s key hints as the single source of the hint line', () => {
    const model = buildBranchesModel('/repo', cached, false);
    const keys = t('branches.keys');
    assert.ok(model.hints.length >= 5, `the hint line is parsed (${model.hints.length})`);
    assert.equal(model.hints[0].keys, 'n', 'create comes first in the buffer’s hint line');
    for (const hint of model.hints) {
      assert.ok(keys.includes(hint.keys), `${hint.keys} comes from the buffer’s hint line`);
      assert.ok(hint.label.length > 0, `${hint.keys} has a label`);
    }
    assert.equal(model.title, '/repo — branches', 'the header is the repository and the screen');
  });
});

describe('tags screen as a panel', () => {
  it('draws one row per tag, in the order the screen lists them', () => {
    const model = buildTagsModel('/repo', [
      tag('v1.0.0', { annotation: 'first release' }),
      tag('nightly', { sha: 'def5678', date: '2024-02-02', author: 'Bob' }),
    ]);
    assert.equal(model.kind, 'tags');
    assert.deepEqual(
      model.blocks[0].rows.map((row) => row.text),
      ['v1.0.0', 'nightly']
    );
    assert.deepEqual(model.facts, [], 'no count line: the rows are the count');
  });

  it('carries the annotation, the sha, the date and the author of each tag', () => {
    const model = buildTagsModel('/repo', [tag('v1.0.0', { annotation: 'first release' })]);
    const parts = model.blocks[0].rows[0].parts ?? [];
    assert.deepEqual(
      parts.map((part) => part.role),
      ['meta', 'hash', 'date', 'author', 'plain']
    );
    assert.deepEqual(
      parts.map((part) => part.text.trim()),
      ['first release', 'abc1234', '2024-01-01', 'Ada', 'a commit']
    );
  });

  it('lines the columns up, as the buffer pads them', () => {
    const model = buildTagsModel('/repo', [
      tag('v1.0.0', { annotation: 'first release', author: 'Ada' }),
      tag('nightly', { sha: 'def5678', date: '2024-02-02', author: 'Bob', subject: 'and another' }),
    ]);
    const [first, second] = model.blocks[0].rows;
    assert.equal(first.aligned, true, 'the row is a table row');
    assert.equal(second.aligned, true);
    const flat = (row: typeof first): string => row.text + (row.parts ?? []).map((part) => part.text).join('');
    const at = (row: typeof first, text: string): number => {
      const index = flat(row).indexOf(text);
      assert.ok(index >= 0, `${text} is on the row`);
      return index;
    };
    // The sha, the date and the author start at the same offset in both rows: that is
    // what the buffer's padEnd() columns do, and the panel must not drift from it.
    assert.equal(at(first, 'abc1234'), at(second, 'def5678'), 'the sha column');
    assert.equal(at(first, '2024-01-01'), at(second, '2024-02-02'), 'the date column');
    assert.equal(at(first, 'Ada'), at(second, 'Bob'), 'the author column');
    assert.ok(at(second, 'and another') > at(second, 'Bob'), 'the subject comes last');
  });

  it('shortens a long annotation the way the buffer’s column does', () => {
    const model = buildTagsModel('/repo', [tag('v1', { annotation: 'x'.repeat(80) })]);
    const annotation = model.blocks[0].rows[0].parts?.[0].text.trim() ?? '';
    assert.ok(annotation.length <= 40, `the annotation is truncated (${annotation.length})`);
    assert.ok(annotation.endsWith('…'), 'and says it was truncated');
  });

  it('names each row by the tag', () => {
    const model = buildTagsModel('/repo', [tag('v1.0.0')]);
    assert.equal(model.blocks[0].rows[0].id, 'tag:v1.0.0');
  });

  it('marks a tag the remote does not have, and says which remote', () => {
    const model = buildTagsModel(
      '/repo',
      [tag('pushed', { pushed: true }), tag('local', { pushed: false })],
      'origin'
    );
    assert.equal(model.blocks[0].rows[0].role, 'branch', 'a pushed tag keeps the branch colour');
    assert.equal(model.blocks[0].rows[1].role, 'untracked', 'a missing tag takes the coral of "untracked"');
    assert.deepEqual(
      model.facts.map((fact) => fact.value),
      [t('tags.unpushed', { count: 1, remote: 'origin' })],
      'the line names the count and the remote it was checked against'
    );
  });
});

describe('the history screen as a panel', () => {
  it('draws the rows of the buffer, character for character', () => {
    const parsed = history();
    const model = logModel(parsed);
    // The panel does not render history a second way: the line on screen is the line the
    // text buffer prints, graph spacing included.
    assert.deepEqual(
      model.rows.map((row) => row.segments.map((segment) => segment.text).join('')),
      logRows(parsed).map((row) => row.text)
    );
    assert.equal(model.kind, 'log');
    assert.ok(model.title.includes(t('log.title', { repo: 'repo' })), 'the title names the repository');
  });

  it('colours each column with the role the buffer decorates it with', () => {
    const model = logModel();
    const roles = model.rows[0].segments.filter((segment) => segment.role !== 'plain').map((segment) => segment.role);
    assert.deepEqual(roles, ['graph', 'hash', 'date', 'author', 'refs']);
    assert.equal(model.rows[1].segments.some((segment) => segment.role === 'refs'), false, 'a commit with no ref has none');
  });

  it('splits a line at the buffer’s spans and leaves the gaps plain', () => {
    const text = '*  abc1234  2024-01-01  Ada';
    const segments = segmentsOf(text, [
      { line: 0, start: 3, end: 10, kind: 'hash' },
      { line: 0, start: 12, end: 22, kind: 'date' },
      { line: 0, start: 24, end: 27, kind: 'author' },
    ]);
    assert.deepEqual(segments, [
      { text: '*  ', role: 'plain' },
      { text: 'abc1234', role: 'hash' },
      { text: '  ', role: 'plain' },
      { text: '2024-01-01', role: 'date' },
      { text: '  ', role: 'plain' },
      { text: 'Ada', role: 'author' },
    ]);
    assert.equal(
      segments.map((segment) => segment.text).join(''),
      text,
      'nothing is lost and nothing is drawn twice'
    );
  });

  it('marks a tag the remote does not have inside the refs label', () => {
    const segments = highlightUnpushedTags(
      [{ text: '[HEAD -> main tag: v1 tag: v2]', role: 'refs' }],
      new Set(['v1'])
    );
    assert.deepEqual(segments, [
      { text: '[HEAD -> main tag: v1 ', role: 'refs' },
      { text: 'tag: v2', role: 'untracked' },
      { text: ']', role: 'refs' },
    ]);
    assert.equal(
      segments.map((segment) => segment.text).join(''),
      '[HEAD -> main tag: v1 tag: v2]',
      'the row text is unchanged'
    );
    assert.deepEqual(
      highlightUnpushedTags([{ text: '[tag: v1]', role: 'refs' }], new Set(['v1'])),
      [{ text: '[tag: v1]', role: 'refs' }],
      'a pushed tag keeps the refs colour'
    );
  });

  it('lets a marker inside the graph win its own character', () => {
    // `--left-right` puts `<`/`>` inside the graph prefix; the marker has a colour of
    // its own, and the rest of the prefix keeps the graph colour.
    const segments = segmentsOf('> * ', [
      { line: 0, start: 0, end: 3, kind: 'graph' },
      { line: 0, start: 0, end: 1, kind: 'add' },
    ]);
    assert.deepEqual(segments, [
      { text: '>', role: 'added' },
      { text: ' *', role: 'graph' },
      { text: ' ', role: 'plain' },
    ]);
    assert.equal(segments.map((segment) => segment.text).join(''), '> * ');
  });

  it('names each row by the commit, so the host can look it up again', () => {
    const model = logModel();
    assert.deepEqual(
      model.rows.map((row) => row.id),
      ['commit:abc1234abc1234', 'commit:def5678def5678']
    );
    assert.equal(model.rows[0].commit?.shortSha, 'abc1234');
    assert.deepEqual(model.rows[0].commit?.refs, ['HEAD -> main', 'tag: v1']);
  });

  it('tells the row where its message column starts, so a long message wraps under it', () => {
    // The row is one string, so the panel cannot wrap at the subject with an element: it
    // gets the column instead and hangs the continuation line there. The column is where
    // the message begins — a refs label in front of the subject is part of that message,
    // not a column of its own, so it does not move the column and the continuation line
    // starts under the tag rather than after it.
    const parsed = history();
    const model = logModel(parsed);
    const rows = logRows(parsed);
    const messages = ['[HEAD -> main tag: v1] first commit', 'second commit'];
    model.rows.forEach((row, index) => {
      const source = rows[index];
      assert.equal(typeof row.subjectColumn, 'number');
      assert.equal(
        source.text.slice(row.subjectColumn),
        messages[index],
        'the column is where the message begins, refs label and all'
      );
    });
    assert.equal(
      model.rows[0].subjectColumn,
      model.rows[1].subjectColumn,
      'a row with refs starts its message in the same column as one without'
    );
    assert.equal(
      rows[0].text.slice(model.rows[0].subjectColumn ?? 0),
      '[HEAD -> main tag: v1] first commit',
      'the refs label is the message’s first words'
    );
  });

  it('prints one filter field per row, filled where a filter is set', () => {
    const model = buildLogModel({
      repoPath: '/repo',
      parsed: history(),
      all: false,
      filter: { author: 'Ada', branch: 'origin/main' },
      sort: 'topo',
      limit: 200,
    });
    assert.equal(model.filters.length, FILTER_FIELDS.length);
    assert.deepEqual(
      model.filters.map((row) => row.id),
      FILTER_FIELDS.map((field) => `field:${field}`)
    );
    assert.deepEqual(
      model.filters.map((row) => row.field),
      [...FILTER_FIELDS],
      'each row names the field a typed value belongs to'
    );
    const author = model.filters.find((row) => row.id === 'field:author');
    assert.equal(author?.value, 'Ada');
    assert.equal(author?.filled, true, 'a set filter is drawn in the buffer’s hunk colour');
    const grep = model.filters.find((row) => row.id === 'field:grep');
    // The panel edits these in inputs, so an empty field is the raw empty value and the
    // label is what the input shows while it is empty.
    assert.equal(grep?.value, '');
    assert.equal(grep?.filled, false);
    assert.equal(grep?.label, fieldLabel('grep'));
    assert.equal(author?.label, fieldLabel('author'), 'the name stays even while a value is set');
    assert.equal(model.filters.find((row) => row.id === 'field:pickaxe')?.label, fieldLabel('pickaxe'));
    // A branch is a field like the others: the box says what it filters while it is empty,
    // and shows the branch it is filtering by once one is set.
    const branch = model.filters.find((row) => row.id === 'field:branch');
    assert.equal(branch?.field, 'branch', 'the host is told which field the value belongs to');
    assert.equal(branch?.value, 'origin/main');
    assert.equal(branch?.filled, true);
    assert.equal(branch?.label, fieldLabel('branch'));
    assert.ok(
      FILTER_FIELDS.indexOf('branch') > FILTER_FIELDS.indexOf('author') &&
        FILTER_FIELDS.indexOf('branch') < FILTER_FIELDS.indexOf('pickaxe'),
      'the branch sits with the identity filters, not among the content ones'
    );
  });

  it('drops the commit count and keeps only an order the reader chose', () => {
    // The block heading counts the commits, so the header does not. The graph order is the
    // buffer's silence and asks for no line either; a chosen order has nowhere else to be.
    assert.deepEqual(logModel().facts, [], 'the graph order says nothing');
    const byDate = buildLogModel({ repoPath: '/repo', parsed: history(), all: false, filter: {}, sort: 'date', limit: 200 });
    assert.deepEqual(
      byDate.facts.map((fact) => fact.value),
      [t('sort.date')]
    );
    const byAuthor = buildLogModel({
      repoPath: '/repo',
      parsed: history(),
      all: false,
      filter: {},
      sort: 'author-date',
      limit: 200,
    });
    assert.deepEqual(
      byAuthor.facts.map((fact) => fact.value),
      [t('sort.authorDate')]
    );
  });

  it('says so when the page is full, so the reader can ask for more', () => {
    const full = logModel(history(), 2);
    assert.equal(full.more, true, 'a full page means there may be another one');
    assert.equal(full.moreText, t('webview.moreLog'));
    assert.equal(logModel(history(), 200).more, false);
  });

  it('says there is no history instead of drawing an empty screen', () => {
    const model = logModel(parseLog(''));
    assert.deepEqual(model.rows, []);
    assert.equal(model.emptyText, t('webview.emptyLog'));
    assert.equal(model.more, false, 'nothing to load behind an empty page');
  });

  it('tells an empty history apart from a filter that matches nothing', () => {
    // Both screens are blank, but one is a filter to loosen and the other is a
    // repository without commits: the line under them says which is which.
    const filtered = buildLogModel({
      repoPath: '/repo',
      parsed: parseLog(''),
      all: false,
      filter: { author: 'Ada' },
      sort: 'topo',
      limit: 200,
    });
    assert.deepEqual(filtered.rows, []);
    assert.equal(filtered.emptyText, t('webview.emptyLogFiltered'));
  });

  it('keeps the buffer’s filter and key wording', () => {
    const model = logModel();
    assert.match(model.filterTitle, /./, 'the filter block is titled');
    assert.ok(model.hints.length > 0, 'the hint line is parsed from the buffer’s key line');
    assert.equal(model.title, '/repo — commit history', 'the header names the repository, as the other screens do');
    assert.equal(model.hints[0].keys, 'enter', 'the buffer’s first hint comes first');
  });
});

describe('the list screens keep the buffer’s keys', () => {
  it('checks out on enter and creates with n on the branches screen', () => {
    assert.equal(resolveScreenKey('branches', { code: 'Enter' }), 'checkout');
    assert.equal(resolveScreenKey('branches', { code: 'KeyC' }), 'checkout');
    assert.equal(resolveScreenKey('branches', { code: 'KeyN' }), 'create');
    assert.equal(resolveScreenKey('branches', { code: 'KeyE' }), 'rename');
    assert.equal(resolveScreenKey('branches', { code: 'KeyU' }), 'upstream');
    assert.equal(resolveScreenKey('branches', { code: 'KeyX' }), 'remove');
    assert.equal(resolveScreenKey('branches', { code: 'KeyM' }), 'merge');
    assert.equal(resolveScreenKey('branches', { code: 'KeyA' }), 'toggleRemote');
  });

  it('puts the bigger variants behind Shift, as the buffer does', () => {
    assert.equal(resolveScreenKey('branches', { code: 'KeyR' }), 'refresh');
    assert.equal(resolveScreenKey('branches', { code: 'KeyR', shiftKey: true }), 'reset');
    assert.equal(resolveScreenKey('branches', { code: 'KeyD', shiftKey: true }), 'removeRemote');
    assert.equal(resolveScreenKey('branches', { code: 'KeyS', shiftKey: true }), undefined, 'S is free again');
    assert.equal(resolveScreenKey('tags', { code: 'KeyU', shiftKey: true }), 'push');
    assert.equal(resolveScreenKey('tags', { code: 'KeyD', shiftKey: true }), 'removeRemote');
  });

  it('shows a tag on enter and moves it with e', () => {
    assert.equal(resolveScreenKey('tags', { code: 'Enter' }), 'show');
    assert.equal(resolveScreenKey('tags', { code: 'KeyT' }), 'create');
    assert.equal(resolveScreenKey('tags', { code: 'KeyE' }), 'move');
    assert.equal(resolveScreenKey('tags', { code: 'KeyX' }), 'remove');
    assert.equal(resolveScreenKey('tags', { code: 'KeyR' }), 'refresh');
  });

  it('matches the physical key on a Cyrillic layout too', () => {
    assert.equal(resolveScreenKey('branches', { code: 'KeyC', key: 'с' }), 'checkout');
    assert.equal(resolveScreenKey('tags', { code: 'KeyE', key: 'у' }), 'move');
  });

  it('gives the status screen no list keys at all', () => {
    assert.equal(resolveScreenKey('status', { code: 'Enter' }), undefined);
  });

  it('knows which keys need a row, so an empty selection says so instead of doing nothing', () => {
    for (const action of ['checkout', 'rename', 'upstream', 'remove', 'removeRemote', 'merge', 'reset'] as const) {
      assert.ok(SCREEN_NEEDS_ROW.branches.includes(action), `branches ${action} needs a row`);
    }
    for (const action of ['show', 'move', 'push', 'remove', 'removeRemote'] as const) {
      assert.ok(SCREEN_NEEDS_ROW.tags.includes(action), `tags ${action} needs a row`);
    }
    for (const action of [
      'show',
      'create',
      'checkout',
      'tag',
      'fixup',
      'cherryPick',
      'revert',
      'reset',
      'compare',
    ] as const) {
      assert.ok(SCREEN_NEEDS_ROW.log.includes(action), `log ${action} needs a row`);
    }
    // A new branch, a new tag, a refresh and the remote toggle work without one.
    for (const action of ['create', 'refresh', 'toggleRemote', 'close'] as const) {
      assert.ok(!SCREEN_NEEDS_ROW.branches.includes(action), `branches ${action} works with no row`);
    }
    assert.ok(!SCREEN_NEEDS_ROW.tags.includes('create'));
    // So do the keys of the history screen that change what it shows rather than act.
    for (const action of ['toggleAll', 'sort', 'resetFilters', 'filters', 'refresh', 'close'] as const) {
      assert.ok(!SCREEN_NEEDS_ROW.log.includes(action), `log ${action} works with no row`);
    }
    // Every key a screen has must be classified, or the panel would either block a
    // key that works or send one that cannot.
    for (const screen of ['branches', 'tags', 'submodules', 'log', 'actionlog'] as const) {
      for (const action of Object.values(SCREEN_KEYS[screen])) {
        assert.ok(
          SCREEN_NEEDS_ROW[screen].includes(action) ||
            [
              'create',
              'refresh',
              'toggleRemote',
              'close',
              'toggleAll',
              'sort',
              'resetFilters',
              'filters',
              'clearLog',
            ].includes(action),
          `${screen} ${action} is classified`
        );
      }
    }
  });

  it('falls back to the keys every panel has', () => {
    assert.deepEqual(resolveCommonKey({ code: 'KeyT', shiftKey: true }), {
      kind: 'opener',
      command: 'githelm.tags.open',
    });
    assert.deepEqual(resolveCommonKey({ code: 'KeyS', shiftKey: true }), {
      kind: 'opener',
      command: 'githelm.submodules.open',
    });
    assert.deepEqual(resolveCommonKey({ code: 'ArrowDown' }), { kind: 'move', direction: 'down', extend: false });
    assert.deepEqual(resolveCommonKey({ code: 'KeyC', ctrlKey: true }), { kind: 'copy' });
    assert.deepEqual(resolveCommonKey({ code: 'Escape' }), { kind: 'clear' });
    assert.equal(resolveCommonKey({ code: 'KeyN' }), undefined, 'a screen’s own key is not a common one');
  });
});

describe('the carousel and the focus of the screens', () => {
  const SOURCE = fs.readFileSync(path.join('src', 'extension.ts'), 'utf8');
  const PANEL = fs.readFileSync(path.join('src', 'webview', 'panel.ts'), 'utf8');
  const CLIENT = fs.readFileSync(path.join('src', 'webview', 'client', 'main.ts'), 'utf8');

  it('cycles the screens on Tab, in both directions', () => {
    assert.match(CLIENT, /event\.code === 'Tab'/, 'the client listens for Tab');
    assert.match(CLIENT, /post\(\{ type: 'cycle', direction: event\.shiftKey \? -1 : 1 \}\)/);
    // The panel's keys are matched by code, so Tab has to be caught before them.
    assert.ok(
      CLIENT.indexOf("event.code === 'Tab'") < CLIENT.indexOf("if (!model || model.kind === 'status')"),
      'Tab is handled before the keys of the screen'
    );
    assert.match(PANEL, /message\.type === 'cycle'/, 'the host takes the cycle message');
    assert.match(PANEL, /this\.deps\.cycle\(this\.kind, message\.direction, this\.repoPath \?\? ''\)/);
  });

  it('opens a commit on enter and keeps the buffer’s actions behind their letters', () => {
    assert.equal(resolveScreenKey('log', { code: 'Enter' }), 'show');
    assert.equal(resolveScreenKey('log', { code: 'KeyN' }), 'create');
    assert.equal(resolveScreenKey('log', { code: 'KeyC' }), 'checkout');
    assert.equal(resolveScreenKey('log', { code: 'KeyT' }), 'tag');
    assert.equal(resolveScreenKey('log', { code: 'KeyF' }), 'fixup');
    assert.equal(resolveScreenKey('log', { code: 'KeyQ' }), 'close');
    assert.equal(resolveScreenKey('log', { code: 'KeyR' }), 'refresh');
    assert.equal(resolveScreenKey('log', { code: 'KeyA' }), 'toggleAll');
    assert.equal(resolveScreenKey('log', { code: 'KeyS' }), 'sort');
    assert.equal(resolveScreenKey('log', { code: 'KeyD' }), 'compare');
    assert.equal(resolveScreenKey('log', { code: 'Slash' }), 'filters');
    assert.equal(resolveScreenKey('log', { code: 'KeyX' }), 'resetFilters');
    // The bigger variants stay behind Shift, as the buffer's key line prints them.
    assert.equal(resolveScreenKey('log', { code: 'KeyC', shiftKey: true }), 'cherryPick');
    assert.equal(resolveScreenKey('log', { code: 'KeyV', shiftKey: true }), 'revert');
    assert.equal(resolveScreenKey('log', { code: 'KeyR', shiftKey: true }), 'reset');
    // `d` is the buffer's compare key, so `Shift+D` must not claim it as well.
    assert.equal(resolveScreenKey('log', { code: 'KeyD', shiftKey: true }), undefined);
    assert.equal(resolveScreenKey('log', { code: 'KeyF', shiftKey: true }), undefined, 'nothing is invented');
  });

  it('keeps the keys of a screen inside the screen, not in the manifest', () => {
    // A screen's letters used to be manifest keybindings, because a text buffer had to be
    // told what a key means. A panel reads its own keys, so the manifest must not carry a
    // second copy that could drift from the keymap.
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      contributes: { keybindings: { command: string; key: string; when?: string }[] };
    };
    const screenKeys = manifest.contributes.keybindings.filter((entry) =>
      /githelm\.view|resourceScheme == 'githelm'/.test(entry.when ?? '')
    );
    assert.deepEqual(screenKeys, [], 'no manifest key belongs to a screen');
    // And what a screen does with a letter is the keymap's answer, not a command id.
    for (const screen of ['log', 'branches'] as const) {
      for (const action of new Set(Object.values(SCREEN_KEYS[screen]))) {
        assert.ok(typeof resolveScreenKey(screen, { code: 'KeyA' }) !== 'object', `${screen} ${action} is a key, not a command`);
      }
    }
  });

  it('gives Tab to every screen, carousel and hint alike', () => {
    // The key cannot be a manifest keybinding — from inside the panel the keymap does
    // not fire — so the client handles it for every model it draws.
    assert.match(CLIENT, /if \(event\.code === 'Tab'[\s\S]*?post\(\{ type: 'cycle'/);
    assert.match(PANEL, /model\.hints = \[\.\.\.model\.hints, \.\.\.this\.extraHints\(\)\]/);
    // Every screen adds it; a sub-screen, which is not in the carousel, does not.
    assert.match(PANEL, /protected extraHints\(\): HintModel\[\] \{\r?\n    return \[\{ keys: 'tab', label: t\('webview\.cycle'\) \}\];/);
  });

  it('has one `d` and no patch key, in any UI', () => {
    // `d` means one thing now: the editor's diff. There is no second reading of the same
    // file to advertise, so no chord, no hint and no words to translate.
    assert.ok(!PANEL.includes('openPatch'), 'the panel has no patch opener');
    assert.ok(!PANEL.includes('alt+d'), 'and advertises no patch chord');
    const keys = fs.readFileSync(path.join('src', 'webview', 'keys.ts'), 'utf8');
    assert.ok(!keys.includes("action: 'patch'"), 'no key resolves to a patch');
    assert.ok(!CLIENT.includes("'patch'"), 'the client never sends one');
    for (const locale of ['en', 'ru', 'zh']) {
      const words = fs.readFileSync(path.join('src', 'i18n', `${locale}.ts`), 'utf8');
      assert.ok(!words.includes("'webview.patch':"), `${locale} has no patch hint left`);
      assert.ok(words.includes("'commit.files':"), `${locale} names the files of a commit`);
    }
  });

  it('walks the four screens in a circle, both ways', () => {
    assert.deepEqual([...CAROUSEL], ['status', 'branches', 'tags', 'log']);
    assert.equal(nextScreen('status', 1), 'branches');
    assert.equal(nextScreen('branches', 1), 'tags');
    assert.equal(nextScreen('tags', 1), 'log');
    assert.equal(nextScreen('log', 1), 'status', 'Tab wraps around');
    assert.equal(nextScreen('status', -1), 'log', 'Shift+Tab wraps the other way');
    assert.equal(nextScreen('log', -1), 'tags');
    assert.equal(nextScreen('tags', -1), 'branches');
    assert.equal(nextScreen('branches', -1), 'status');
  });

  it('switches the screen in the tab it is in instead of adding a tab', () => {
    assert.match(SOURCE, /const kind = nextScreen\(from, direction\)/);
    assert.match(SOURCE, /nextScreen/);
    // The screen the user leaves closes first, so the next one takes its place.
    const body = SOURCE.slice(SOURCE.indexOf('const cycleScreens = async'), SOURCE.indexOf('const focusNeighbour'));
    const dispose = body.indexOf('panelOf(from).dispose()');
    const show = body.indexOf('await panelOf(kind).show(target)');
    assert.ok(dispose >= 0 && show > dispose, 'the old tab goes before the new screen is shown');
    // Nothing is closed until the repository of the next screen is known.
    assert.ok(body.indexOf('resolveRepo()') < dispose, 'the repository is resolved before closing anything');
  });

  it('closes the tab before it looks at the repository', () => {
    // A screen that has not read a repository yet must still be closable, so
    // the panel is the only thing the check may need.
    assert.match(PANEL, /if \(!this\.panel \|\| this\.repoPath === undefined\)/);
    assert.ok(PANEL.includes("action === 'close'"), 'the close key is on every screen');
    assert.match(PANEL, /await this\.closePanel\(\)/);
  });

  it('leaves the keys working after q closed a tab', () => {
    assert.match(PANEL, /protected async closePanel\(\): Promise<void> \{[\s\S]*?await this\.deps\.neighbour\(this\.kind\)/);
    assert.match(SOURCE, /const focusNeighbour = async/);
    assert.match(SOURCE, /workbench\.action\.focusActiveEditorGroup/, 'and the editor group when nothing is left');
  });
});

describe('the host routes the ported screens to their panels', () => {
  const SOURCE = fs.readFileSync(path.join('src', 'extension.ts'), 'utf8');
  const PANEL = fs.readFileSync(path.join('src', 'webview', 'panel.ts'), 'utf8');
  const CLIENT = fs.readFileSync(path.join('src', 'webview', 'client', 'main.ts'), 'utf8');
const KEYFILE = fs.readFileSync(path.join('src', 'webview', 'keys.ts'), 'utf8');
const STYLE = fs.readFileSync(path.join('media', 'webview', 'style.css'), 'utf8');
const GUTTER = fs.readFileSync(path.join('src', 'views', 'blameGutter.ts'), 'utf8');
const BUFFER = fs.readFileSync(path.join('src', 'views', 'historyDoc.ts'), 'utf8');

  it('opens branches, tags, the submodules and the history in their panels', () => {
    for (const screen of ['branches', 'tags', 'submodules', 'log']) {
      const at = SOURCE.indexOf(`register('githelm.${screen}.open'`);
      assert.ok(at >= 0, `${screen} is registered`);
      const body = SOURCE.slice(at, SOURCE.indexOf('});', at));
      assert.match(body, new RegExp(`${screen}Webview\\.show\\(repo\\)`), `${screen} opens in its panel`);
      assert.doesNotMatch(body, /Buffer\.open\(/, 'and has no other screen to fall back to');
    }
  });

  it('keeps one panel per screen, so the screens are tabs', () => {
    assert.match(SOURCE, /new ListWebview\(listDeps\('branches'\), 'branches'\)/);
    assert.match(SOURCE, /new ListWebview\(listDeps\('tags'\), 'tags', remoteTags\)/);
    assert.match(SOURCE, /new ListWebview\(listDeps\('submodules'\), 'submodules'\)/);
    assert.match(SOURCE, /new ActionLogWebview\(/);
    assert.match(SOURCE, /new LogWebview\(/);
    assert.match(PANEL, /return `githelm\.webview\.\$\{this\.list\}`/, 'each screen has its own view type');
    assert.match(PANEL, /'githelm\.webview\.log'/, 'and so does the history screen');
    assert.match(PANEL, /'githelm\.webview\.actionlog'/, 'and the log, which belongs to no repository');
    // The status bar and the carousel look panels up by kind, so a screen that is not
    // in either list is a tab nothing can reach.
    assert.match(SOURCE, /const ALL_SCREENS: ScreenKind\[\] = \['status', 'branches', 'tags', 'submodules', 'log', 'actionlog'\]/);
    assert.match(SOURCE, /case 'log':\s*\n\s*return logWebview;/);
  });

  it('reads the history a page at a time instead of walking the whole repository', () => {
    assert.match(PANEL, /private limit = LOG_PAGE/);
    assert.match(PANEL, /this\.limit \+= LOG_PAGE/, 'the next page raises the limit');
    assert.match(PANEL, /message\.type === 'more'/, 'the host hears the end of the page');
    assert.match(PANEL, /protected override async onMore\(\)/);
    assert.match(CLIENT, /post\(\{ type: 'more' \}\)/, 'the client asks once it reaches the end');
    assert.match(CLIENT, /moreIfAtEnd/, 'and asks on every scroll');
  });

  it('refreshes every panel that is on screen, not just the status one', () => {
    assert.match(SOURCE, /screenPanels\.map\(\(panel\) => panel\.refreshIfVisible\(\)\)/);
  });

  it('opens the action log without a repository, and clears it once for both UIs', () => {
    const at = SOURCE.indexOf("register('githelm.actionLog'");
    assert.ok(at >= 0, 'the log has an opener');
    const body = SOURCE.slice(at, SOURCE.indexOf('});', at));
    assert.match(body, /actionLogWebview\.show\(''\)/, 'the panel is opened with no repository');
    assert.doesNotMatch(body, /Buffer\.open\(\)/, 'and there is no text screen behind it');
    // The modal question and the emptying are one helper, so the log is emptied one way.
    assert.match(SOURCE, /const runClearActionLog = async/);
    assert.match(SOURCE, /t\('confirm\.clearLog'/, 'the question is asked');
    assert.match(SOURCE, /showWarningMessage\(/, 'in a modal warning');
    assert.match(SOURCE, /clearActions\(\)/, 'and it is the one that empties the log');
    assert.match(SOURCE, /clear: \(\) => runClearActionLog\(\)/, 'the panel asks the same helper');
  });

  it('answers `d` with the editor’s diff, never with a generated patch', () => {
    // The patch panel is gone. A hunk is still staged from the text buffer, whose patch
    // has line numbers; the panel reads every diff through the built-in editor instead
    // of drawing a second, patch-shaped one.
    assert.ok(!SOURCE.includes('openDiffDoc'), 'no patch document is prepared');
    assert.ok(!SOURCE.includes('openPatchDoc'), 'and none is opened');
    assert.doesNotMatch(PANEL, /case 'patch'/, 'the panel has no patch branch');
    // `d` on the status screen is the selected files in the editor.
    assert.match(SOURCE, /openDiff: \(repoPath, targets\) => openBuiltinDiff\(repoPath, targets\)/);
    assert.match(PANEL, /case 'diff':\r?\n\s+await this\.statusDeps\.openDiff\(repoPath, fileTargetsOf\(model, ids\)\)/);
    // An untracked file is adopted as intent-to-add first, or `git diff` has nothing to show.
    assert.match(SOURCE, /for \(const target of targets\)[\s\S]{0,300}addIntentToAdd\(repoPath, target\.path\)/);
  });

  it('reads a file in the built-in diff editor, in the pairs the SCM view uses', () => {
    // The editor's own diff is what a reader expects from `d`: real syntax highlighting,
    // folding, both sides. A generated patch only looks like a diff.
    assert.match(
      PANEL,
      /export async function openFileDiffs\(\r?\n  repoPath: string,\r?\n  targets: readonly FileTarget\[\]\r?\n\): Promise<OpenedDiff \| undefined>/
    );
    // Staged rows are HEAD against the index, so the staged half of a file is what shows…
    assert.match(PANEL, /target\.section === 'staged'[\s\S]{0,240}revisionUri\(repoPath, target\.path, 'HEAD'\)/);
    // …and unstaged rows are the index against the working tree, so only the edit shows.
    assert.match(PANEL, /target\.section === 'conflict'[\s\S]{0,140}revisionUri\(repoPath, target\.path, ':1'\)/);
    // A conflicted file is read against its base stage: the working copy holds the markers.
    assert.match(PANEL, /revisionUri\(repoPath, target\.path, ''\)/);
    // One multi-diff tab for the selection, as the built-in git extension opens it. The
    // record comes back so the diff it just opened can be walked commit by commit.
    assert.match(PANEL, /return openDiffEntries\(entries\);/);
    // And every tab says which pair it shows, in the built-in git's own words: the two
    // sides of a `git:` diff carry the same path, so the title is the only place that can
    // tell `a.ts (Index)` from `a.ts (Working Tree)`.
    assert.match(PANEL, /const title = `\$\{target\.path\} \(\$\{sectionName\(target\.section\)\}\)`/);
    assert.match(PANEL, /'diff\.side\.index'/);
    assert.match(PANEL, /'diff\.side\.worktree'/);
    assert.match(PANEL, /'diff\.side\.untracked'/);
    // A pair of revisions is titled the same way, on both sides, with a short sha.
    assert.match(PANEL, /const left = refName\(leftRef\)/);
    assert.match(PANEL, /title: `\$\{filePath\} \(\$\{left\}\) ↔ \$\{filePath\} \(\$\{right\}\)`/);
    assert.match(PANEL, /\/\^\[0-9a-f\]\{40,64\}\$\/i\.test\(ref\) \? ref\.slice\(0, 8\) : ref/);
    // The title is what the tab shows, so a single diff must use it, not the path alone.
    assert.match(PANEL, /'vscode\.diff', entry\.left, entry\.right, entry\.title/);
    // An untracked file has no index side at all until it is adopted…
    assert.match(SOURCE, /for \(const target of targets\)[\s\S]{0,300}addIntentToAdd\(repoPath, target\.path\)/);
    // …and no fallback: a file the editor cannot serve must not resurrect a patch panel.
    assert.match(SOURCE, /await openFileDiffs\(repoPath, targets\);\r?\n  \};/);
    // The two file lists answer `d` with the same editor: a stash against its parent, a
    // commit against the parent a root commit does not have.
    assert.match(
      PANEL,
      /export async function openRevisionDiffs\(\r?\n  repoPath: string,\r?\n  files: readonly string\[\],/
    );
    assert.match(SOURCE, /await openRevisionDiffs\(state\.repoPath, files, `\$\{state\.ref\}\^`, state\.ref, state\.ref\)/);
    assert.match(SOURCE, /const openCommitFileDiffs = async \(uri: vscode\.Uri, rows: readonly number\[\]\)/);
    assert.match(SOURCE, /const parent = await firstParent\(state\.repoPath, state\.sha\)/);
    assert.match(SOURCE, /await openFilesAtRef\(state\.repoPath, files, state\.sha\)/);
    // Every file of the selection is one entry, so a whole list is one multi-diff tab.
    assert.match(PANEL, /files\.map\(\(filePath\) => \(\{/);
  });

  it('diffs every file of a selection, and a click on the header selects the list', () => {
    // The header of a file list is a line of the document, so the panel cannot recognise
    // it by its text: the model says which rows it stands for.
    assert.match(
      SOURCE,
      /groupsOf: \(uri\) => \{[\s\S]{0,200}commitDoc\.fileListOf\(uri\) \?\? stashDoc\.fileListOf\(uri\)/
    );
    assert.match(PANEL, /groups: this\.docDeps\.groupsOf\?\.\(this\.uri\)/);
    assert.match(PANEL, /groupsOf\?: \(uri: vscode\.Uri\) => DocModelGroup\[\] \| undefined/);
    // A click on it takes the rows it stands for, exactly as a click on a section's title
    // takes the section.
    assert.match(CLIENT, /closest<HTMLElement>\('\.doc-group'\)/);
    assert.match(CLIENT, /const groupIds = docGroupIds\(groupHeader\?\.dataset\.id\)/);
    // The host reads every selected row as the file it names, and the header as all of
    // them — a row that names no file (the metadata) is skipped, not an error.
    assert.match(SOURCE, /const files = filesOf\(commitDoc\.fileListOf\(uri\), rows\)/);
    assert.match(SOURCE, /const files = filesOf\(stashDoc\.fileListOf\(uri\), rows\)/);
  });

  it('draws every sub-screen in the panel', () => {
    // Every sub-screen is a document of the panel, rendered by its own class: `prepare`
    // is the render, and the panel is the only host.
    for (const doc of ['commit', 'stash', 'compare', 'conflict', 'file', 'init']) {
      assert.match(KEYFILE, new RegExp(`^  ${doc}: \\{`, 'm'), `${doc} has a key table`);
    }
    for (const method of [
      'commitDoc.prepare(repoPath, sha)',
      'stashDoc.prepare(repoPath, ref)',
      'conflictDoc.prepare(repoPath, relativePath)',
      'historyDoc.prepare(kind, repoPath, relativePath)',
    ]) {
      assert.ok(SOURCE.includes(method), `${method} is the one render, for the panel`);
    }
    for (const name of ['openStashFiles', 'openConflictFile', 'openCommitView', 'openFileHistory']) {
      assert.ok(SOURCE.includes(`const ${name} = async`), `${name} is wired`);
    }
    assert.match(SOURCE, /await openStashFiles\(repo, target\.ref\)/);
    assert.match(SOURCE, /await openConflictFile\(repo, target\.path\)/);
    assert.match(SOURCE, /await openCommitView\(repo, commit\.sha\)/);
    assert.match(SOURCE, /await openFileHistory\('blame', repo, relative\)/);
    // A conflicted file answered by the document, not by whatever editor has the focus.
    assert.match(SOURCE, /const takeConflictSide = async \(uri: vscode\.Uri, side: 'ours' \| 'theirs' \| 'base'\)/);
    assert.match(SOURCE, /const resolveConflict = async \(uri: vscode\.Uri\)/);
    assert.match(SOURCE, /const openMergeEditor = async \(uri: vscode\.Uri\)/);
    assert.match(SOURCE, /await takeConflictSide\(uri, action\)/);
    // A stash's `d` is the diff of every file the selection names.
    assert.match(SOURCE, /const openStashFileDiffs = async \(uri: vscode\.Uri, rows: readonly number\[\]\)/);
    assert.match(SOURCE, /await openStashFileDiffs\(uri, rows\)/);
  });

  it('draws the git init screen in the panel, not in a buffer', () => {
    // A folder that is not a repository has no `git status`, so the status model cannot be
    // built for it; the panel draws the buffer's `renderUninitialized()` document instead,
    // and `Enter` on its one row runs the same `git init` the buffer runs.
    assert.match(SOURCE, /const openInitDoc = async \(folderPath: string\): Promise<void> => \{/);
    assert.match(SOURCE, /const rendered = renderInit\(folderPath\);/);
    assert.ok(!/renderUninitialized\(folderPath\)/.test(SOURCE), 'the host does not build the text itself');
    // The key of the status screen opens the panel for a folder without a repository.
    const at = SOURCE.indexOf(`register('githelm.status.open'`);
    const body = SOURCE.slice(at, SOURCE.indexOf('});', at));
    assert.match(body, /await openInitDoc\(folder\);/, 'the panel draws the init screen');
    assert.doesNotMatch(body, /Buffer\.open\(folder\)/, 'and no text screen is opened instead');
    // `Enter` acts on the `git init` row and on no other line.
    assert.match(SOURCE, /const init = parseInit\(uri\);/);
    assert.match(SOURCE, /const onRow = rows\.length === 0 \|\| rows\.some\(\(row\) => isInitRow\(init\.folderPath, row\)\);/);
    assert.match(SOURCE, /if \(action === 'open' && onRow\) \{/);
    assert.match(SOURCE, /await initRepo\(init\.folderPath\)/);
    // The panel that asked gives way to the status panel of the repository it created.
    assert.match(SOURCE, /const initPanel = docPanels\.get\(initUri\(folderPath\)\.toString\(\)\)/);
    assert.match(SOURCE, /if \(initPanel\) \{\r?\n\s+initPanel\.dispose\(\);\r?\n\s+\}\r?\n\s+await statusWebview\.show\(root\);/);

    // `r` on that screen re-reads the folder: it may have become a repository meanwhile.
    assert.match(SOURCE, /const root = await findRepoRoot\(init\.folderPath\);/);
    assert.match(SOURCE, /paintInit\(uri, init\.folderPath\);/);
  });

  it('opens a blame in the editor in both UIs, because only an editor can highlight it', () => {
    // A webview has no TextMate grammar, so a blame's code cannot be painted there: the
    // blame is the file itself in a real editor, while the log — which is text — keeps the
    // panel.
    assert.match(SOURCE, /const blameGutter = new BlameGutter\(\)/);
    assert.match(SOURCE, /new HistoryDoc\(docs, highlighter, blameGutter\)/);
    assert.match(SOURCE, /blameGutter\.repaint\(\)/, 'a re-created editor gets its gutter back');
    assert.ok(!/tipsOf/.test(SOURCE), 'a blame no longer hands the panel its rows');
    assert.ok(!/columnsOf/.test(SOURCE), 'nor where a table would split them');
  });

  it('draws a blame’s metadata in front of the code, as a decoration', () => {
    // The gutter is not text: the document is the file's code and nothing else, or the
    // grammar would see the metadata as part of the file.
    assert.match(GUTTER, /renderOptions: \{ before: this\.before\(line\) \}/);
    assert.match(GUTTER, /contentText: line\.gutter/);
    assert.match(GUTTER, /width = `\$\{BLAME_GUTTER_WIDTH\}ch`/, 'a column is a width');
    assert.match(GUTTER, /new vscode\.ThemeColor\(COLOR_OF\[line\.uncommitted \? 'unstaged' : 'meta'\]\)/, 'the same colours as a span');
    // The whole message is the line's hover, escaped: a commit message is not markdown.
    assert.match(GUTTER, /markdown\.appendText\(line\.message\)/);
    assert.match(BUFFER, /this\.docs\.set\(uri, view\.text\)/, 'the code is the file, not a rendering');
    assert.match(BUFFER, /this\.highlighter\.clear\(uri\)/, 'the gutter is not painted as spans');
    // A blame's language is the file's own, asked of VS Code rather than guessed.
    assert.match(BUFFER, /setTextDocumentLanguage\(document, language\)/);
    // What the panel used to draw is gone: no cell grid, no DOM popup of its own.
    assert.ok(!/line\.cells/.test(CLIENT), 'the client draws no table');
    assert.ok(!/doc-columns/.test(CLIENT), 'and has no column grid to put a row in');
    assert.ok(!/doc-tip/.test(STYLE), 'no popup box in the stylesheet either');
  });

  it('keeps a table row’s subject in its column instead of moving it to the row’s edge', () => {
    // A wrapping flex line breaks on the width an item asks for, and a text item asks for
    // its whole length — so a subject longer than the room left on the line moved to a
    // line of its own, where it started at the row's left edge, away from its column.
    // Asking for no width keeps it on the row's one line, and the text wraps inside the
    // box the model's columns left for it.
    const rule = STYLE.slice(STYLE.indexOf('.item-row > .item-part:last-child'));
    assert.ok(rule.length > 0, 'the free text of a row has a rule of its own');
    const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));
    assert.match(body, /flex: 1 1 0;/, 'the part asks for no width, so the line never breaks before it');
    assert.match(body, /min-width: 6ch;/, 'and it keeps a readable floor when the columns fill the panel');
    assert.match(body, /overflow-wrap: break-word;/, 'a word too long for the box breaks inside it');
    // The tag rows are the table: their columns come from the model's padding, and the row
    // must not add a gap of its own or start the columns at the row's edge.
    const table = STYLE.slice(STYLE.indexOf('.item-row.aligned {'));
    assert.match(table.slice(0, table.indexOf('}')), /padding-left: calc\(2ch \+ 4px\)/, 'the buffer’s two-space indent');
  });

  it('reads the refs of a commit as the first words of its message, not as a column', () => {
    // The refs used to be a flex item in front of the subject: it shrank to an ellipsis to
    // make room, and the subject — a second item — wrapped inside its own box, so the
    // continuation line started after the tag as if the tag were a column.
    const message = STYLE.slice(STYLE.indexOf('.commit-message {'));
    const messageBody = message.slice(message.indexOf('{'), message.indexOf('}'));
    assert.ok(!/display: flex/.test(messageBody), 'the message is one flow of text, not a row of items');
    assert.match(messageBody, /min-width: 0;/, 'it can shrink to the cell the table gave it');
    assert.match(messageBody, /overflow-wrap: anywhere;/, 'a long word breaks inside the cell');
    const refs = STYLE.slice(STYLE.indexOf('.commit-refs {'));
    const refsBody = refs.slice(refs.indexOf('{'), refs.indexOf('}'));
    assert.ok(!/text-overflow: ellipsis/.test(refsBody), 'the refs are never cut short');
    assert.ok(!/overflow: hidden/.test(refsBody), 'and never clipped');
    assert.match(refsBody, /margin-right: 1ch;/, 'a word space before the subject, as the buffer prints it');
    assert.ok(!/\.commit-subject \{/.test(STYLE), 'the subject needs no box of its own any more');
    assert.match(CLIENT, /const refs = element\('span', 'commit-refs'\)/, 'the refs come first in that flow');
    assert.match(CLIENT, /refs\.append\(element\('span', `role-\$\{segment\.role\}`, segment\.text\)\)/, 'painted piece by piece');
    assert.match(CLIENT, /message\.append\(refs\)/);
    assert.match(CLIENT, /message\.append\(element\('span', 'commit-subject', commit\.subject\)\)/, 'then the subject, in the same element');
  });

  it('diffs a whole stash from its row, without planning a range git cannot read', () => {
    // `d` on a stash row used to ask for `git diff --name-only ^..`, which git answers with
    // `fatal: bad revision '^..'` — exit 128, an error notification and no diff at all.
    // The row means the stash, so the diff is every file it touched.
    // A comment may still name the range it explains; no call may plan it.
    assert.ok(!/openCompareInEditor\([^;]*\^\.\./.test(SOURCE), 'no `^..` range is planned');
    assert.ok(!/openCompareInEditor\([^)]*`\^`/.test(SOURCE), '`^` is not a revision');
    assert.match(SOURCE, /const openStashDiffInEditor = async \(repoPath: string, ref: string\)/);
    const helper = SOURCE.slice(SOURCE.indexOf('const openStashDiffInEditor'), SOURCE.indexOf('const runOpenTarget'));
    assert.match(helper, /const files = await stashFiles\(repoPath, ref\)/);
    assert.match(helper, /files\.map\(\(file\) => file\.path\)/, 'every file of the stash, one tab');
    assert.match(helper, /`\$\{ref\}\^`/, 'the parent of the stash is its left side');
    assert.match(helper, /warn\(t\('compare\.noChanges', \{ range: ref \}\)\)/, 'an empty stash says so');
    // Both doors to a stash's diff in the panel go through it: the status row and the row
    // the panel names for itself.
    // Both doors to a stash's diff go through it: the status row and the file list.
    assert.match(SOURCE, /const runStashDiff = async \(repo: string, ref: string\): Promise<void> => \{\r?\n    await openStashDiffInEditor\(repo, ref\);/);
    assert.match(SOURCE, /return runStashDiff\(repo, resolved\.ref\);/);
  });

  it('runs a list key through the host, so the questions are the buffer’s', () => {
    assert.match(PANEL, /await this\.listDeps\.run\(action, repoPath, ids\)/);
    // `a` is display state of the screen, not a git action, so the panel keeps
    // it and redraws instead of asking the host.
    assert.match(PANEL, /this\.showRemote = !this\.showRemote/);
    assert.match(PANEL, /await this\.refresh\(\)/);
  });

  it('puts the local branches beside the last commits and routes their keys', () => {
    // The status screen's bottom half is two columns: the branches on the left, the
    // commits on the right with 60% of the width.
    assert.match(CLIENT, /element\('div', 'bottom'\)/);
    assert.match(CLIENT, /renderRowBlock\(bottom, model\.branches, selectedSet\(selection\)\)/);
    assert.match(CLIENT, /renderCommits\(bottom, model\.commits, selectedSet\(selection\)\)/);
    assert.match(STYLE, /\.bottom \{[\s\S]*?grid-template-columns: minmax\(0, 4fr\) minmax\(0, 6fr\)/);
    // A branch row keeps the branches screen's keys, and the host runs the one
    // implementation the branches screen runs.
    assert.match(CLIENT, /resolveStatusKey\(selection\.ids\[0\], event\)/);
    assert.match(PANEL, /ids\[0\]\?\.startsWith\('branch:'\)/);
    assert.match(PANEL, /action === 'graph'/);
    assert.match(PANEL, /action === 'reset'/);
    assert.match(PANEL, /await this\.statusDeps\.runBranch\(action, repoPath, ids\)/);
    assert.match(SOURCE, /runBranch: \(action, repoPath, ids\) =>/);
    assert.match(SOURCE, /await logWebview\.showBranch\(repo, entry\.name\)/, 'G opens the branch graph');
    assert.match(PANEL, /listBranchEntries\(repoPath, false\)/, 'the block reads local branches only');
  });

  it('makes the last commits selectable rows with the history screen’s keys', () => {
    // A commit row is a box of its own, so it can be selected and hovered; the author
    // column is a measured CSS variable rather than a shared grid track.
    assert.match(CLIENT, /item\.dataset\.id = commit\.id/);
    assert.match(CLIENT, /--commit-author-width/);
    assert.match(CLIENT, /model\.commits\.rows\.map\(\(row\) => row\.id\)/, 'the rows are in the arrow order');
    assert.match(STYLE, /\.commit-row \{[\s\S]*?grid-template-columns: 8ch 17ch var\(--commit-author-width/);
    assert.match(PANEL, /ids\[0\]\?\.startsWith\('commit:'\)/);
    assert.match(PANEL, /await this\.statusDeps\.runLog\(action(?: as ScreenAction)?, repoPath, ids\)/);
    assert.match(SOURCE, /runLog: \(action, repoPath, ids\) =>/);
  });

  it('looks the row up again in the repository instead of trusting the id', () => {
    assert.match(SOURCE, /const runBranch = async \(action: ScreenAction, repo: string, ids: readonly string\[\]\)/);
    assert.match(SOURCE, /branchFromIds/);
    assert.match(SOURCE, /const runTag = async \(action: ScreenAction, repo: string, ids: readonly string\[\]\)/);
    assert.match(SOURCE, /tagFromIds/);
    // A commit is re-read from the object store: an id is a name, not the commit.
    assert.match(SOURCE, /const runLog = async \(action: ScreenAction, repo: string, ids: readonly string\[\]\)/);
    assert.match(SOURCE, /const commitFromIds = async/);
    assert.match(SOURCE, /commitBySha\(repo, sha\)/);
  });

  it('types a filter into the history instead of asking for it in a prompt', () => {
    // The filters are inputs above the rows: no filter row is selectable any more, so a
    // value is typed where it is shown and Enter sends that one field.
    assert.match(CLIENT, /function renderLogFilters\(history: LogModel\): HTMLElement/);
    assert.match(CLIENT, /const input = element\('input'/);
    assert.match(CLIENT, /input\.dataset\.field = row\.field/);
    // The field's name is the placeholder, so the row is one line of compact inputs and
    // no label sits above each box.
    assert.match(CLIENT, /input\.placeholder = row\.label/);
    assert.ok(!CLIENT.includes("'filter-field'"), 'the label above the box is gone');
    assert.match(CLIENT, /post\(\{ type: 'filter', field, value \}\)/);
    // `/` walks to the filters in the buffer; here it puts the caret in the first input.
    assert.match(CLIENT, /function focusFirstFilter\(\): void/);
    // A focused input owns the keyboard: otherwise `s`, `c` and `d` would run actions
    // while the reader is spelling an author's name.
    assert.ok(
      CLIENT.indexOf('if (event.target instanceof HTMLInputElement)') <
        CLIENT.indexOf("event.code === 'Tab'"),
      'the input hands the keyboard back only when it is left'
    );
    // The host takes the value for a field it knows and re-reads; a name from the DOM
    // that is not a filter changes nothing.
    assert.match(PANEL, /message\.type === 'filter'/);
    assert.match(PANEL, /\(FILTER_FIELDS as readonly string\[\]\)\.includes\(field\)/);
    const body = PANEL.slice(PANEL.indexOf('protected override async onFilter('), PANEL.indexOf('protected override async onMore('));
    assert.match(body, /await this\.refresh\(\)/, 'the history is re-read with the new filter');
    assert.match(body, /delete writable\[field as FilterField\]/, 'an emptied input lifts the filter');
    // A branch is a revision, not a pattern: a name that resolves to nothing would make
    // `git log` fail instead of showing an empty history, so the host answers it first and
    // redraws the input from the filter that is still set.
    assert.match(body, /revisionExists\(this\.repo, trimmed\)/, 'the branch is checked before it is asked for');
    assert.match(body, /t\('log\.branchMissing'/, 'a typo is answered, not handed to git');
    // `a` and a branch are two answers to one question: the last one asked wins, so `a`
    // lifts the branch and a typed branch turns `a` off. Either way the title's claim about
    // the walk — `(all branches)` or nothing — is what `git log` was actually given.
    assert.match(body, /this\.all = false;/, 'a branch is the walk, so every-ref mode is off');
    assert.match(
      PANEL,
      /const \{ branch: _branch, \.\.\.rest \} = this\.filter;[\s\S]{0,160}this\.all = asked \? true : !this\.all;/,
      '`a` with a branch set turns every ref on instead of doing nothing'
    );
  });

  it('compares two commits without dropping into a text buffer', () => {
    // `d` in the buffer opens a compare window. The panel answers the same six questions
    // in place: a range is this screen over another slice of history, and a diff is the
    // built-in editor — neither is a githelm buffer, so the reader stays where they are.
    const screen = PANEL.slice(
      PANEL.indexOf('protected override async onScreen('),
      PANEL.indexOf('protected override async onFilter(')
    );
    assert.match(screen, /if \(action === 'compare'\) \{[\s\S]*?await this\.compare\(ids\);[\s\S]*?return;/);
    const compare = PANEL.slice(PANEL.indexOf('private async compare(ids'), PANEL.indexOf('protected override async onFilter('));
    assert.match(compare, /compareChoices\(\)/, 'the six choices come from the table the buffer reads');
    assert.match(compare, /planCompare\(repoPath, picked\.value/, 'one plan names the range both halves use');
    assert.match(compare, /this\.range = plan\.range/, 'a log range becomes the panel’s own range');
    assert.match(compare, /this\.leftRight = plan\.mode === 'three' \? true : undefined/);
    assert.match(compare, /this\.logDeps\.openCompareList\(repoPath, plan\)/, 'a diff opens the range file list');
    assert.match(SOURCE, /openCompareList: \(repoPath, plan\) =>\s*openCompareDoc/, 'the host owns the list');
    assert.match(SOURCE, /const openCompareDoc = async/, 'the range is a document');
    assert.match(SOURCE, /compareDoc\.prepare\(/, 'the document is the range file list');
    assert.match(SOURCE, /openCompareFileDiffs/, 'd inside the list opens the diff');
    assert.match(SOURCE, /plan\.diffLeft/, 'a ... diff starts at the merge base');
    assert.ok(!/openRangeDiff/.test(PANEL), 'a compare no longer opens the multi-diff directly');
    assert.ok(!/compareBuffer|logBuffer/.test(PANEL), 'the panel never opens a text buffer of its own');
    assert.match(SOURCE, /showQuickPick\(compareChoices\(\)/, 'the buffer lists them from the same table');
  });

  it('compares branches on the branches screen, and reads a range there', () => {
    // The same `d`: one branch is compared with HEAD, two with each other, and the six
    // answers are the history screen's six — a `log …` answer is read on the screen that
    // draws graphs, a `diff …` answer in the built-in editor.
    const screen = PANEL.slice(
      PANEL.indexOf('protected override async onScreen('),
      PANEL.indexOf('private async compareBranches(')
    );
    assert.match(screen, /this\.list === 'branches' && action === 'compare'[\s\S]*?await this\.compareBranches\(ids\)/);
    const branches = PANEL.slice(PANEL.indexOf('private async compareBranches('), PANEL.indexOf('protected override async onFilter('));
    assert.match(branches, /refTip\(repoPath, name\)/, 'a branch is looked up again, not trusted from the row');
    assert.match(branches, /compareChoices\(\)/, 'the same six choices as the history screen');
    assert.match(branches, /planCompare\(repoPath, picked\.value, left\.sha, rightSha, left\.name, rightLabel\)/);
    assert.match(branches, /this\.listDeps\.openLogRange\(repoPath, plan\.range, plan\.mode === 'three'\)/);
    assert.match(branches, /this\.listDeps\.openCompareList\(repoPath, plan\)/);
    // The host gives the panel the screen to hand a range to, and that screen is the log.
    assert.match(SOURCE, /openLogRange: \(repoPath, range, leftRight\) => logWebview\.showRange\(repoPath, range, leftRight\)/);
    assert.match(PANEL, /async showRange\(repoPath: string, range: string, leftRight: boolean\)/);
    assert.match(PANEL, /this\.range = range;[\s\S]*?this\.leftRight = leftRight \? true : undefined;[\s\S]*?this\.limit = LOG_PAGE;[\s\S]*?await this\.show\(repoPath\)/);
    // The key itself is the panel's: `d` on branches is a row key, not a view key.
    assert.equal(SCREEN_KEYS.branches.KeyD, 'compare');
    assert.ok(SCREEN_NEEDS_ROW.branches.includes('compare'), 'a compare needs a row to name');
  });

  it('opens the graph of the branch under the cursor with G', () => {
    // `G` on a branch is the history screen asked a question it already has a field for:
    // the name is handed over as the branch filter, so both screens read one history.
    const screen = PANEL.slice(
      PANEL.indexOf('protected override async onScreen('),
      PANEL.indexOf('private async compareBranches(')
    );
    assert.match(
      screen,
      /this\.list === 'branches' && action === 'graph'[\s\S]*?this\.listDeps\.openLogBranch\(repoPath, name\)/,
      'the key is the panel’s, and the host hands the name to the history screen'
    );
    assert.match(screen, /id\.startsWith\('branch:'\)[\s\S]*?id\.slice\('branch:'\.length\)/, 'the row names the branch');
    const show = PANEL.slice(PANEL.indexOf('async showBranch('), PANEL.indexOf('async showRange('));
    assert.match(show, /this\.filter = \{ \.\.\.this\.filter, branch \}/, 'the filter the history screen already reads');
    assert.match(show, /this\.all = false;/, 'a branch is the walk, so every-ref mode steps aside');
    assert.match(
      show,
      /this\.range = undefined;[\s\S]*?this\.leftRight = undefined;[\s\S]*?this\.limit = LOG_PAGE;[\s\S]*?await this\.show\(repoPath\)/,
      'a range steps aside too, and the branch is read from its first page'
    );
    assert.match(
      SOURCE,
      /openLogBranch: \(repoPath, branch\) => logWebview\.showBranch\(repoPath, branch\)/,
      'the host routes the key to the history screen'
    );
    // The key is a row key of the branches screen, and it is announced there.
    assert.equal(SCREEN_KEYS.branches['shift+KeyG'], 'graph');
    assert.ok(SCREEN_NEEDS_ROW.branches.includes('graph'), 'a branch is needed to name');
    assert.ok(t('branches.keys').includes('G graph of the branch'), 'the hint line says so');
  });

  it('gives every key of a screen something to do', () => {
    const body = (from: string, to: string): string => {
      const start = SOURCE.indexOf(from);
      const end = SOURCE.indexOf(to);
      assert.ok(start >= 0 && end > start, `${from} is where the test expects it`);
      return SOURCE.slice(start, end);
    };
    const branches = body('const runBranch = async', 'const runTag = async');
    const tags = body('const runTag = async', 'const commitFromIds = async');
    const log = body('const runLog = async', 'const pickRemote = async');
    // Panel-side keys: the panel closes its own tab and redraws itself; `a` is
    // display state, and the history screen keeps its filters, its order and its page.
    // `G` has no buffer equivalent at all: the branches screen hands it to the history
    // screen, so it never reaches the host's `run`.
    const panelOnly = ['close', 'refresh', 'toggleRemote', 'toggleAll', 'sort', 'resetFilters', 'filters', 'graph'];
    for (const [screen, host] of [
      ['branches', branches],
      ['tags', tags],
      ['log', log],
    ] as const) {
      for (const action of new Set(Object.values(SCREEN_KEYS[screen]))) {
        if (panelOnly.includes(action)) {
          continue;
        }
        assert.ok(host.includes(`case '${action}':`), `${screen} ${action} runs the buffer’s case`);
      }
    }
  });

  it('keeps the header the same on every screen and puts the status facts under it', () => {
    // The header is the screen's line and its keys, closed by the rule, on every screen;
    // what the status screen says about where it is looking is the column's first block.
    const body = CLIENT.slice(CLIENT.indexOf('function render(): void'), CLIENT.indexOf('function moreIfAtEnd'));
    assert.ok(
      body.indexOf('renderKeys(header, model.hints)') < body.indexOf('app.append(header)'),
      'the keys are part of the header'
    );
    assert.ok(!body.includes('renderFacts(header'), 'the header says the same thing on every screen');
    assert.ok(
      body.indexOf('app.append(header)') < body.indexOf('renderFacts(app, model.facts)'),
      'the facts come after the header, not inside it'
    );
    assert.ok(!CLIENT.includes('title-block'), 'the title is not wrapped in a block of its own');
  });
});
