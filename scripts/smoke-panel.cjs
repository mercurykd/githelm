// Loads the compiled panel against a stub `vscode` and the repository this script is
// run from, then prints what the panel would render. A quick way to see that the
// host half still works after a change: `node scripts/smoke-panel.cjs`.
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// The checkout this script lives in; it is the repository the panels are pointed at.
const root = path.join(__dirname, '..');
const repo = root;

const posted = [];
const created = [];
const revealed = [];
const cycled = [];
const neighbours = [];
const commands = [];

const stubPath = path.join(__dirname, 'vscode-panel-stub.js');
require('node:fs').writeFileSync(
  stubPath,
  `class Uri {
  constructor(scheme, fsPath) { this.scheme = scheme; this.fsPath = fsPath; this.path = fsPath; }
  toString() { return this.scheme + ':' + this.fsPath; }
  static file(p) { return new Uri('file', p); }
  static from(components) { const uri = new Uri(components.scheme, components.path ?? ''); uri.query = components.query ?? ''; return uri; }
  static joinPath(base, ...parts) { return new Uri(base.scheme, [base.fsPath, ...parts].join('/')); }
  with(change) { const next = new Uri(this.scheme, this.fsPath); next.query = change.query ?? this.query; return next; }
}
module.exports = {
  Uri,
  ViewColumn: { Active: -1 },
  window: {
    createWebviewPanel: (viewType) => {
      const onDispose = [];
      const panel = {
        viewType,
        visible: true,
        disposed: false,
        title: '',
        webview: {
          cspSource: 'stub:',
          html: '',
          asWebviewUri: (uri) => uri,
          postMessage: async (message) => { globalThis.__posted.push(message); return true; },
          // The smoke drives the panel through the very handler the host would call.
          onDidReceiveMessage: (handler) => { panel.__message = handler; return { dispose() {} }; },
        },
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: (handler) => { onDispose.push(handler); return { dispose() {} }; },
        reveal() { globalThis.__revealed.push(viewType); },
        dispose() {
          if (panel.disposed) { return; }
          panel.disposed = true;
          for (const handler of onDispose) { handler(); }
        },
      };
      globalThis.__panels.push(panel);
      return panel;
    },
  },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  env: { language: 'en' },
  // A quick pick is a dialog: the smoke answers it, the way a reader would.
  window: {
    createWebviewPanel: (viewType) => {
      const onDispose = [];
      const panel = {
        viewType,
        visible: true,
        disposed: false,
        title: '',
        webview: {
          cspSource: 'stub:',
          html: '',
          asWebviewUri: (uri) => uri,
          postMessage: async (message) => { globalThis.__posted.push(message); return true; },
          // The smoke drives the panel through the very handler the host would call.
          onDidReceiveMessage: (handler) => { panel.__message = handler; return { dispose() {} }; },
        },
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: (handler) => { onDispose.push(handler); return { dispose() {} }; },
        reveal() { globalThis.__revealed.push(viewType); },
        dispose() {
          if (panel.disposed) { return; }
          panel.disposed = true;
          for (const handler of onDispose) { handler(); }
        },
      };
      globalThis.__panels.push(panel);
      return panel;
    },
    showQuickPick: async (items) => {
      const answer = globalThis.__quickPick;
      return answer === undefined ? undefined : items.find((item) => item.value === answer);
    },
  },
  commands: { executeCommand: async (command, ...args) => { globalThis.__commands.push({ command, args }); } },
  Disposable: class { dispose() {} },
};`
);

globalThis.__posted = posted;
globalThis.__panels = created;
globalThis.__revealed = revealed;
globalThis.__commands = commands;
const originalResolve = Module._resolveFilename;
const stubId = require.resolve(stubPath);
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'vscode') {
    return stubId;
  }
  return originalResolve.call(this, request, ...rest);
};

const {
  ActionLogWebview,
  DocWebview,
  ListWebview,
  LogWebview,
  StatusWebview,
  openFileDiffs,
  openRevisionDiffs,
} = require(path.join(root, 'dist/webview/panel.js'));
const { renderCommitScreen } = require(path.join(root, 'dist/git/commitView.js'));
const { BLAME_GUTTER_WIDTH, blameLines, fileLog, parseBlame } = require(path.join(root, 'dist/git/fileHistory.js'));

const base = {
  extensionUri: { fsPath: root, scheme: 'file', path: root },
  notify: (message) => console.log(`  notify: ${message}`),
  warn: (message) => console.log(`  warn: ${message}`),
  statusBar: async () => {},
  cycle: async (from, direction, repoPath) => {
    cycled.push(`${from} -> ${direction === 1 ? 'next' : 'previous'} (${repoPath || 'no repo'})`);
  },
  neighbour: async (from) => {
    neighbours.push(from);
  },
};

const diffs = [];
const status = new StatusWebview({
  ...base,
  commit: async () => {},
  createTag: async () => {},
  stash: async () => {},
  runRepo: async () => {},
  runTarget: async () => {},
  // `d` is one key: the selected rows, in the built-in diff editor.
  openDiff: async (repoPath, targets) => {
    diffs.push(targets.map((target) => `${target.section}:${target.path}`).join(' | '));
  },
});

const branches = new ListWebview(
  {
    ...base,
    run: async () => {},
    // `d` on a branch reads its range on the history screen, exactly as the host wires it.
    openLogRange: (repoPath, range, leftRight) => log.showRange(repoPath, range, leftRight),
  },
  'branches'
);
const tags = new ListWebview({ ...base, run: async () => {} }, 'tags');
const submodules = new ListWebview({ ...base, run: async () => {} }, 'submodules');
const actionlog = new ActionLogWebview({ ...base, clear: async () => {} });
const log = new LogWebview({ ...base, run: async () => {} });

/** A one-line account of the model the panel last posted. */
const describe = (message) => {
  const model = message.model;
  if (model.kind === 'status') {
    const rows = model.sections.reduce((sum, section) => sum + section.rows.length, 0);
    const column = model.column.reduce((sum, block) => sum + block.rows.length, 0);
    return `${model.title} | ${rows} file rows, ${column} column rows`;
  }
  if (model.kind === 'log') {
    const graphs = model.rows.filter((row) => row.segments.some((segment) => segment.role === 'graph')).length;
    return `${model.title} | ${model.rows.length} rows, ${graphs} with a graph, ${model.filters.length} filters`;
  }
  if (model.kind === 'doc') {
    const painted = model.lines.filter((line) => line.segments.some((segment) => segment.role !== 'plain')).length;
    return `${model.title} | ${model.lines.length} lines, ${painted} painted, ${model.hints.length} hints`;
  }
  const rows = model.blocks.reduce((sum, block) => sum + block.rows.length, 0);
  return `${model.title} | ${model.blocks.length} blocks, ${rows} rows`;
};

const last = () => describe(posted[posted.length - 1]);

/**
 * The last model of one kind. Panels repaint on their own clock — a refresh started by an
 * earlier key can land after a later one — so "the last message" is not always "the answer
 * to the key I just sent".
 */
const lastOf = (kind) => {
  for (let index = posted.length - 1; index >= 0; index -= 1) {
    if (posted[index].model?.kind === kind) {
      return posted[index].model;
    }
  }
  throw new Error(`no ${kind} model was posted`);
};

/** Delivers a message to the panel of a screen, the way the webview would. */
const deliver = async (kind, message) => {
  const panel = created.find((entry) => entry.viewType === `githelm.webview.${kind}` && !entry.disposed);
  if (!panel) {
    throw new Error(`${kind} has no open panel`);
  }
  panel.__message(message);
  // The host's handler is fire-and-forget, so let its promise chain run.
  await new Promise((resolve) => setTimeout(resolve, 100));
};

/** Waits for something the handler does on its own clock — a git read, a diff to open. */
const waitFor = async (predicate, what, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) {
    throw new Error(`timed out waiting for ${what}`);
  }
};

(async () => {
  await status.show(repo);
  console.log(`  repo        ${repo}`);
  console.log(`  hidden?     repoIfVisible -> ${status.repoIfVisible()}`);
  console.log(`  status      ${last()}`);

  const before = posted.length;
  await status.refreshIfVisible();
  console.log(`  live redraw ${posted.length > before ? last() : 'NOTHING POSTED'}`);

  created[0].visible = false;
  const hiddenBefore = posted.length;
  await status.refreshIfVisible();
  console.log(`  hidden      ${posted.length === hiddenBefore ? 'skipped, as intended' : 'REFRESHED ANYWAY'}`);
  console.log(`  repoIfVisible while hidden -> ${status.repoIfVisible()}`);
  created[0].visible = true;

  // `d`: the rows the reader selected reach the built-in diff editor, and nothing else
  // asks for a patch — a row is what the panel has instead of a cursor.
  const statusModel = posted[posted.length - 1].model;
  const fileRow = statusModel.sections.flatMap((section) => section.rows)[0];
  if (!fileRow) {
    throw new Error('the status panel drew no files to diff');
  }
  await status.onAction('diff', [fileRow.id]);
  console.log(`  diff key    d -> ${diffs.join(' ; ') || 'NOTHING'}`);
  if (diffs.length !== 1) {
    throw new Error('`d` did not reach the built-in diff editor');
  }

  await branches.show(repo);
  console.log(`  branches    ${last()}`);
  // `shift+r` on the branches screen: the same key as the buffer, held by the panel.
  const toggleBefore = posted.length;
  await branches.onScreen('toggleRemote', []);
  const toggled = posted[posted.length - 1].model;
  console.log(
    `  shift+r     ${posted.length > toggleBefore ? `${toggled.blocks.length} blocks after the toggle` : 'NOTHING POSTED'}`
  );

  await tags.show(repo);
  console.log(`  tags        ${last()}`);

  await submodules.show(repo);
  console.log(`  submodules  ${last()}`);

  // The log is not a screen of a repository: the host opens it with the empty path.
  await actionlog.show('');
  console.log(`  actionlog   ${last()}`);

  // The key line is the buffer's, plus the one key only the panels have.
  const hints = posted[posted.length - 1].model.hints;
  const lastHint = hints[hints.length - 1];
  if (!lastHint || lastHint.keys !== 'tab') {
    throw new Error('the panel did not add its Tab hint to the key line');
  }
  console.log(`  hint        ${hints.length} entries, last: ${lastHint.keys} → ${lastHint.label}`);

  await log.show(repo);
  console.log(`  log         ${last()}`);
  const logModel = posted[posted.length - 1].model;
  const logHints = logModel.hints.map((hint) => hint.keys);
  console.log(`  log hints   ${logHints.slice(0, 3).join(', ')}, and tab: ${logHints.includes('tab')}`);
  // The first rows of the history carry the beginning of the graph: the panel draws the
  // buffer's character grid, so the first row of a non-empty repository starts with one.
  const first = logModel.rows.find((row) => row.commit);
  console.log(
    `  log first   ${first ? first.segments.map((segment) => segment.text).join('').slice(0, 40) : 'NO COMMITS'}`
  );

  // The end of the page asks for another one: the host re-reads with a bigger limit and
  // the reader keeps their place, because the client restores the scroll offset.
  if (logModel.more) {
    const before = logModel.rows.length;
    await deliver('log', { type: 'more' });
    const grown = posted[posted.length - 1].model;
    console.log(`  more        ${before} → ${grown.rows.length} rows`);
    if (grown.rows.length <= before) {
      throw new Error('the second page did not add any history');
    }
  } else {
    console.log(`  more        ${logModel.moreText}`);
  }
  // The paging path itself: the host re-reads with the next page when the reader
  // reaches the end. A repository this small has no second page, so the rows stay.
  await log.onMore();
  console.log(`  page 2      ${last()}`);

  // `s` and `a` are view state the panel keeps, and the summary line is where the
  // buffer says so: the order after `s`, the `--all` marker after `a`.
  const plain = posted[posted.length - 1].model.facts[0].value;
  await deliver('log', { type: 'screen', action: 'sort', ids: [] });
  const sorted = posted[posted.length - 1].model.facts[0].value;
  await deliver('log', { type: 'screen', action: 'toggleAll', ids: [] });
  const all = posted[posted.length - 1].model.facts[0].value;
  console.log(`  log s/a     ${plain} → ${sorted} → ${all}`);
  if (sorted === plain || all === sorted) {
    throw new Error('the history screen did not redraw its summary for `s` and `a`');
  }

  // The filters are inputs: a submitted field is a filter, and the panel re-reads with
  // it. Dates make the answer independent of what this checkout's history says: every
  // commit is after 2000 and none is before it.
  const fieldOf = (name) => posted[posted.length - 1].model.filters.find((row) => row.field === name);
  await deliver('log', { type: 'filter', field: 'since', value: '2000-01-01' });
  const matched = posted[posted.length - 1].model;
  const since = fieldOf('since');
  console.log(`  filter      since=${JSON.stringify(since?.value)} → ${matched.rows.length} rows, filled: ${since?.filled}`);
  if (!since?.filled || since.value !== '2000-01-01' || matched.rows.length === 0) {
    throw new Error('the submitted filter did not reach the model');
  }
  await deliver('log', { type: 'filter', field: 'since', value: '' });
  await deliver('log', { type: 'filter', field: 'until', value: '2000-01-01' });
  const none = posted[posted.length - 1].model;
  console.log(`  filter none ${none.rows.length} rows, ${JSON.stringify(none.emptyText)}`);
  if (none.rows.length !== 0) {
    throw new Error('a filter that cannot match still returned commits');
  }
  // An emptied input lifts its filter.
  await deliver('log', { type: 'filter', field: 'until', value: '' });
  const cleared = posted[posted.length - 1].model;
  if (cleared.filters.some((row) => row.filled) || cleared.rows.length === 0) {
    throw new Error('an emptied input left its filter set');
  }
  // A field name that is not a filter is ignored: the value came from the DOM.
  const unsafeBefore = posted[posted.length - 1].model.rows.length;
  await deliver('log', { type: 'filter', field: '--upload-pack=calc', value: 'x' });
  if (posted[posted.length - 1].model.rows.length !== unsafeBefore) {
    throw new Error('a field that is not a filter changed the history');
  }
  console.log(`  filter done ${cleared.rows.length} rows back, unknown field ignored`);

  // `d`: the buffer opens a compare window; the panel answers the same six questions in
  // place — a range is another read of this screen, and a diff is the built-in editor.
  // Nothing here may open a githelm text buffer.
  const rowsWithCommit = posted[posted.length - 1].model.rows.filter((row) => row.commit);
  const oldest = rowsWithCommit[rowsWithCommit.length - 1].commit.sha;
  const newest = rowsWithCommit[0].commit.sha;
  globalThis.__quickPick = 'log-two';
  const readBefore = posted.length;
  await deliver('log', { type: 'screen', action: 'compare', ids: [`commit:${oldest}`, `commit:${newest}`] });
  // A comparison is a git read, so give it its own clock instead of the one-shot delay.
  await waitFor(() => posted.length > readBefore, 'the comparison to be read');
  const ranged = posted[posted.length - 1].model;
  const range = `${oldest}..${newest}`;
  console.log(`  compare log ${JSON.stringify(ranged.title)} | ${ranged.rows.length} rows`);
  if (!ranged.title.includes(range) || ranged.rows.length === 0) {
    throw new Error(`the comparison did not become the panel's range: ${ranged.title}`);
  }
  // `x` clears the range, like it clears the filters.
  const clearBefore = posted.length;
  await deliver('log', { type: 'screen', action: 'resetFilters', ids: [] });
  await waitFor(() => posted.length > clearBefore, 'the range to be cleared');
  const unRanged = posted[posted.length - 1].model;
  console.log(`  compare x   ${unRanged.rows.length} rows, range gone: ${!unRanged.title.includes('..')}`);
  if (unRanged.rows.length === 0 || unRanged.title.includes('..')) {
    throw new Error('`x` left the comparison range in place');
  }
  // A `diff-*` choice goes to the built-in diff editor: one multi-diff tab, git URIs at
  // the two revisions, and no githelm buffer anywhere in the panel.
  globalThis.__quickPick = 'diff-two';
  const commandsBefore = commands.length;
  await deliver('log', { type: 'screen', action: 'compare', ids: [`commit:${oldest}`, `commit:${newest}`] });
  await waitFor(() => commands.length > commandsBefore, 'the diff to open');
  const diffCall = commands[commandsBefore];
  const resources = (diffCall.args[1] ?? []).flat().map((uri) => uri?.query ?? '');
  console.log(
    `  compare diff ${diffCall.command} | ${resources.length} sides, git URIs: ${resources.every((query) => query.includes('"ref"'))}`
  );
  if (
    (diffCall.command !== 'vscode.changes' && diffCall.command !== 'vscode.diff') ||
    resources.length === 0 ||
    !resources.every((query) => query.includes('"ref"'))
  ) {
    throw new Error('the diff comparison did not open the built-in editor at two revisions');
  }
  // The panel's own view is untouched by a diff: the reader is still on their history.
  const afterDiff = posted[posted.length - 1].model;
  if (afterDiff.title.includes('..')) {
    throw new Error('a diff comparison changed the panel’s range');
  }
  globalThis.__quickPick = undefined;

  // `d` on a branch: the same six questions as the history screen, answered in the same
  // two places — the range on the history screen, the diff in the built-in editor. Two
  // throwaway branches at different commits give the comparison something to show; they
  // are deleted again before the run ends.
  const smokeBranches = ['githelm-smoke-a', 'githelm-smoke-b'];
  // `stdio: 'ignore'`: the sandbox refuses a piped child, and this git writes nothing
  // the script needs — the panels read the repository through the git layer anyway.
  execFileSync('git', ['branch', smokeBranches[0], 'HEAD~4'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['branch', smokeBranches[1], 'HEAD~2'], { cwd: repo, stdio: 'ignore' });
  const dropSmokeBranches = () => {
    for (const name of smokeBranches) {
      try {
        execFileSync('git', ['branch', '-D', name], { cwd: repo, stdio: 'ignore' });
      } catch {
        // Already gone: the point of the cleanup is the state, not the exit code.
      }
    }
  };
  try {
    await branches.show(repo);
    const branchModel = posted[posted.length - 1].model;
    const ids = branchModel.blocks
      .flatMap((block) => block.rows)
      .map((row) => row.id)
      .filter((id) => smokeBranches.some((name) => id === `branch:${name}`));
    if (ids.length !== 2) {
      throw new Error(`the branches screen did not list the two smoke branches: ${JSON.stringify(ids)}`);
    }
    globalThis.__quickPick = 'log-two';
    const branchReadBefore = posted.length;
    await deliver('branches', { type: 'screen', action: 'compare', ids });
    await waitFor(() => posted.length > branchReadBefore, 'the branch comparison to be read');
    const branchRanged = posted[posted.length - 1].model;
    console.log(`  branches d  ${JSON.stringify(branchRanged.title)} | ${branchRanged.rows.length} rows, log tab: ${log.open}`);
    if (!branchRanged.title.includes('..') || branchRanged.rows.length === 0 || !log.open) {
      throw new Error('the branch comparison did not become the history screen’s range');
    }
    // A `diff-*` choice leaves the branch screen alone and opens the two tips side by side.
    globalThis.__quickPick = 'diff-two';
    const branchCommandsBefore = commands.length;
    await deliver('branches', { type: 'screen', action: 'compare', ids });
    await waitFor(() => commands.length > branchCommandsBefore, 'the branch diff to open');
    const branchDiff = commands[branchCommandsBefore];
    const branchQueries = (branchDiff.args[1] ?? []).flat().map((uri) => uri?.query ?? '');
    console.log(
      `  branches d  ${branchDiff.command} | ${branchQueries.length} sides, git URIs: ${branchQueries.every((query) => query.includes('"ref"'))}`
    );
    if (branchDiff.command !== 'vscode.changes' && branchDiff.command !== 'vscode.diff') {
      throw new Error('the branch diff did not go to the built-in editor');
    }
    if (branchQueries.length === 0 || !branchQueries.every((query) => query.includes('"ref"'))) {
      throw new Error('the branch diff did not open the two tips side by side');
    }
    // The branch screen keeps its own rows: the answer was the history screen's, not its own.
    const branchAfter = posted[posted.length - 1].model;
    console.log(`  branches    ${branchAfter.kind} model last, ${branchAfter.blocks.flatMap((b) => b.rows).length} rows`);
    // `x` on the history screen goes back to the whole history, as after `d` on a commit.
    const branchClearBefore = posted.length;
    await deliver('log', { type: 'screen', action: 'resetFilters', ids: [] });
    await waitFor(() => posted.length > branchClearBefore, 'the branch range to be cleared');
    if (lastOf('log').title.includes('..')) {
      throw new Error('`x` left the branch comparison range in place');
    }
    console.log(`  branches x  ${lastOf('log').rows.length} rows, range gone`);
  } finally {
    globalThis.__quickPick = undefined;
    dropSmokeBranches();
  }

  // A sub-screen: the panel draws the buffer's own text and spans, and its rows are the
  // document's lines, so `d` hands the host the line of the file under the cursor. A
  // commit is the template every file list follows — metadata, the files, `d` for one.
  const commitUri = {
    scheme: 'githelm',
    path: '/commit/repo/dc3ba5e1a2b3',
    query: '',
    toString() {
      return 'githelm:/commit/repo/dc3ba5e1a2b3';
    },
  };
  const commitScreen = renderCommitScreen(
    {
      sha: 'dc3ba5e1a2b3c4d5e6f708192a3b4c5d6e7f8091',
      shortSha: 'dc3ba5e',
      author: 'Test',
      email: 'test@example.com',
      date: '2026-11-21 12:00',
      subject: 'a commit',
      body: '',
    },
    [
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/b.ts' },
    ],
    'files',
    'd diff   r refresh   q close'
  );
  const ran = [];
  let commitReloads = 0;
  const commitDoc = new DocWebview(
    {
      ...base,
      textOf: (uri) => (uri === commitUri ? commitScreen.text : undefined),
      spansOf: () => commitScreen.spans,
      reload: async () => {
        commitReloads += 1;
      },
      titleOf: () => 'dc3ba5e',
      // The model's header, in 0-based lines: the panel hands a click on it the rows below.
      groupsOf: () => [
        { header: commitScreen.header - 1, lines: commitScreen.rows.map((row) => row.line - 1) },
      ],
      run: async (action, uri, lines) => {
        ran.push(`${action}:${lines.join(',')}`);
      },
      forget: () => {},
    },
    'commit',
    commitUri
  );
  await commitDoc.show(repo);
  console.log(`  commit      ${last()}`);
  const commitModel = posted[posted.length - 1].model;
  console.log(
    `  commit rows ${commitModel.lines.length} lines, files at ${commitScreen.rows.map((row) => row.line).join(',')}`
  );
  if (commitModel.kind !== 'doc' || commitModel.screen !== 'commit') {
    throw new Error('the commit panel did not draw the document it was given');
  }
  if (!commitScreen.text.includes('## files (2)')) {
    throw new Error('the commit screen did not list the files it touched');
  }
  // A sub-screen is not a stop of the carousel: `Tab` has nothing to add.
  if (commitModel.hints.length !== 0) {
    throw new Error('a sub-screen added the carousel hint');
  }
  // `d` is the file under the cursor: the panel sends the line, the host diffs that file.
  await deliver('commit', { type: 'screen', action: 'fileDiff', ids: [`line:${commitScreen.rows[0].line - 1}`] });
  await deliver('commit', { type: 'screen', action: 'refresh', ids: [] });
  console.log(`  commit keys ${ran.join(' | ') || 'NOTHING RAN'} | reloaded ${commitReloads > 0}`);
  if (ran.join(' | ') !== `fileDiff:${commitScreen.rows[0].line - 1}`) {
    throw new Error('the commit panel did not hand the selected file to the host');
  }
  if (commitReloads === 0) {
    throw new Error('`r` did not re-read the commit document');
  }
  // The header stands for the rows under it, so a click on it can select them all…
  const commitGroup = commitModel.groups[0];
  const allRows = commitScreen.rows.map((row) => row.line - 1);
  console.log(`  commit grp  ${commitGroup ? `${commitGroup.header} -> ${commitGroup.ids.join(',')}` : 'NONE'}`);
  if (!commitGroup || commitGroup.header !== `line:${commitScreen.header - 1}`) {
    throw new Error('the commit panel did not mark the file list header');
  }
  if (commitGroup.ids.join(',') !== allRows.map((line) => `line:${line}`).join(',')) {
    throw new Error('the commit header does not stand for the files under it');
  }
  // …and one `d` on that selection is every file, not only the first.
  await deliver('commit', { type: 'screen', action: 'fileDiff', ids: commitGroup.ids });
  console.log(`  commit all  ${ran[ran.length - 1]}`);
  if (ran[ran.length - 1] !== `fileDiff:${allRows.join(',')}`) {
    throw new Error('the commit panel did not hand the whole file list to the host');
  }
  // A conflicted file: the sides are the buffer's commands, run against this document
  // rather than against whatever editor happens to have the focus.
  const conflictUri = {
    scheme: 'githelm',
    path: '/conflict/repo/src/c.ts',
    query: '',
    toString() {
      return 'githelm:/conflict/repo/src/c.ts';
    },
  };
  const conflictText = [
    '## src/c.ts',
    '<<<<<<< ours',
    'ours line',
    '=======',
    'theirs line',
    '>>>>>>> theirs',
  ].join('\n');
  const conflictRan = [];
  let conflictReloads = 0;
  const conflict = new DocWebview(
    {
      ...base,
      textOf: (uri) => (uri === conflictUri ? conflictText : undefined),
      spansOf: () => [{ line: 1, start: 0, end: 13, kind: 'hunk' }],
      reload: async () => {
        conflictReloads += 1;
      },
      titleOf: () => 'src/c.ts',
      run: async (action, uri, lines) => {
        conflictRan.push(`${action}:${lines.join(',')}`);
      },
      forget: () => {},
    },
    'conflict',
    conflictUri
  );
  await conflict.show(repo);
  console.log(`  conflict    ${last()}`);
  const conflictModel = posted[posted.length - 1].model;
  if (conflictModel.kind !== 'doc' || conflictModel.screen !== 'conflict' || conflictModel.lines.length !== 6) {
    throw new Error('the conflict panel did not draw the document it was given');
  }
  await deliver('conflict', { type: 'screen', action: 'ours', ids: ['line:2'] });
  await deliver('conflict', { type: 'screen', action: 'theirs', ids: ['line:4'] });
  await deliver('conflict', { type: 'screen', action: 'mergeEditor', ids: [] });
  await deliver('conflict', { type: 'screen', action: 'resolve', ids: [] });
  // `r` re-reads the document from `git` and then redraws it.
  const conflictReadsBefore = conflictReloads;
  await deliver('conflict', { type: 'screen', action: 'refresh', ids: [] });
  console.log(`  conflict k  ${conflictRan.join(' | ') || 'NOTHING RAN'} | reloaded ${conflictReloads > conflictReadsBefore}`);
  if (conflictRan.join(' | ') !== 'ours:2 | theirs:4 | mergeEditor: | resolve:') {
    throw new Error('the conflict panel did not hand the sides to the host');
  }
  if (conflictReloads <= conflictReadsBefore) {
    throw new Error('`r` did not re-read the conflict document');
  }

  // A stash's file list has one key of its own: `d` is the patch of the file under it.
  const stashUri = {
    scheme: 'githelm',
    path: '/stash/repo/stash@{0}',
    query: '',
    toString() {
      return 'githelm:/stash/repo/stash@{0}';
    },
  };
  const stashRan = [];
  const stashDoc = new DocWebview(
    {
      ...base,
      textOf: (uri) => (uri === stashUri ? 'M src/a.ts\nM src/b.ts' : undefined),
      spansOf: () => [],
      reload: async () => {},
      titleOf: () => 'stash@{0}',
      run: async (action, uri, lines) => {
        stashRan.push(`${action}:${lines.join(',')}`);
      },
      forget: () => {},
    },
    'stash',
    stashUri
  );
  await stashDoc.show(repo);
  console.log(`  stash       ${last()}`);
  await deliver('stash', { type: 'screen', action: 'fileDiff', ids: ['line:1'] });
  console.log(`  stash d     ${stashRan.join(' | ') || 'NOTHING RAN'}`);
  if (stashRan.join(' | ') !== 'fileDiff:1') {
    throw new Error('the stash panel did not hand the selected file to the host');
  }
  // A document that is not a list has no groups: nothing there would answer a header click.
  const stashModel = posted.filter((entry) => entry.model?.screen === 'stash').pop()?.model;
  if ((stashModel?.groups ?? []).length !== 0) {
    throw new Error('the stash document invented a file list header');
  }

  // A file's log is still a panel: it *is* text, and the rows are the buffer's own lines,
  // each one already split into painted segments. A blame is not a panel any more — it is
  // the file's code in a real editor, where its metadata is drawn in front of the line by a
  // decoration. That gutter is checked here as data, because a decoration is not something
  // this script can paint.
  const logView = await fileLog(root, 'package.json');
  const logUri = {
    scheme: 'githelm',
    path: '/file/log/repo/package.json',
    query: '',
    toString() {
      return 'githelm:/file/log/repo/package.json';
    },
  };
  const logDoc = new DocWebview(
    {
      ...base,
      textOf: (uri) => (uri === logUri ? logView.text : undefined),
      spansOf: () => logView.spans,
      reload: async () => {},
      titleOf: () => 'package.json',
      run: async () => {},
      forget: () => {},
    },
    'file',
    logUri
  );
  await logDoc.show(repo);
  console.log(`  file log    ${last()}`);
  const historyModel = posted[posted.length - 1].model;
  const logRows = logView.text.endsWith('\n') ? logView.text.slice(0, -1).split('\n') : logView.text.split('\n');
  if (!historyModel.lines[1].text.startsWith('История файла: package.json')) {
    throw new Error(`the log panel did not take the buffer's header: ${JSON.stringify(historyModel.lines[1].text)}`);
  }
  if (historyModel.lines.length !== logRows.length) {
    throw new Error('the log panel is not one row per line of the buffer');
  }
  for (const [index, line] of historyModel.lines.entries()) {
    if (line.text !== logRows[index]) {
      throw new Error(`row ${index} is not the buffer's line`);
    }
    if (line.segments.map((segment) => segment.text).join('') !== line.text) {
      throw new Error(`row ${index} does not paint all of its characters`);
    }
  }

  const blameMessage = 'feat: a commit message that is much longer than the column';
  const blameSubject = 'feat: a commit message that…';
  const blameView = blameLines(
    'src/app.ts',
    parseBlame(['abc1234 (Ada 2026-11-20 1) first', '   abc1234 (Ada 2026-11-20 2) second'].join('\n')),
    3000,
    new Map([['abc1234', blameMessage]])
  );
  const [head, rest] = blameView.lines;
  console.log(`  blame       code ${JSON.stringify(blameView.text)}, gutter ${head.gutter.length} chars`);
  if (blameView.text !== 'first\nsecond') {
    throw new Error(`a blame is the file itself, not a rendering of it: ${JSON.stringify(blameView.text)}`);
  }
  if (head.gutter.length !== BLAME_GUTTER_WIDTH || rest.gutter.length !== BLAME_GUTTER_WIDTH) {
    throw new Error('the gutter is not one fixed width on every line');
  }
  if (!head.gutter.includes(`${blameSubject}  `)) {
    throw new Error(`the message cell is not the subject plus the gap: ${JSON.stringify(head.gutter)}`);
  }
  if (rest.gutter.trim() !== '') {
    throw new Error('the rest of a block left something in the gutter');
  }
  if (head.block !== true || rest.block !== false) {
    throw new Error('the block does not print its metadata once');
  }
  if (head.message !== blameMessage || rest.message !== blameMessage) {
    throw new Error('a line of a block does not carry the whole message of its commit');
  }
  // Every diff tab is titled the way the built-in git extension titles its own: the side
  // a file is read from, or the two revisions being compared. Both sides of a `git:` diff
  // carry the same path, so the title is the only thing that can tell `a.ts (Index)` from
  // `a.ts (Working Tree)` — an untitled diff leaves two identical tabs.
  const titles = [];
  const titlesBefore = commands.length;
  const titleOf = (call) => (call.command === 'vscode.diff' ? call.args[2] : call.args[0]);
  await openFileDiffs(repo, [{ section: 'staged', path: 'src/a.ts', entry: { xy: 'M ' } }]);
  await openFileDiffs(repo, [{ section: 'unstaged', path: 'src/b.ts', entry: { xy: ' M' } }]);
  await openFileDiffs(repo, [
    { section: 'staged', path: 'src/a.ts', entry: { xy: 'M ' } },
    { section: 'untracked', path: 'src/c.ts', entry: { xy: '??' } },
  ]);
  await openFileDiffs(repo, [{ section: 'untracked', path: 'src/c.ts', entry: { xy: '??' } }]);
  await openRevisionDiffs(repo, ['src/a.ts'], 'stash@{0}^', 'stash@{0}', 'stash@{0}');
  await openRevisionDiffs(repo, ['src/a.ts'], 'a'.repeat(40), 'b'.repeat(40), 'main..feature');
  await openRevisionDiffs(repo, ['src/a.ts', 'src/b.ts'], 'stash@{0}^', 'stash@{0}', 'stash@{0}');
  for (const call of commands.slice(titlesBefore)) {
    titles.push(titleOf(call));
  }
  console.log(`  diff titles ${titles.join(' | ')}`);
  const expectedTitles = [
    'src/a.ts (Index)',
    'src/b.ts (Working Tree)',
    'Git Helm — 2',
    'src/c.ts (Untracked)',
    'src/a.ts (stash@{0}^) ↔ src/a.ts (stash@{0})',
    'src/a.ts (aaaaaaaa) ↔ src/a.ts (bbbbbbbb)',
    'stash@{0} — 2',
  ];
  if (JSON.stringify(titles) !== JSON.stringify(expectedTitles)) {
    throw new Error(`diff titles changed: ${JSON.stringify(titles)}`);
  }

  // `Tab`: the client posts a cycle, the host hands it the carousel.
  await deliver('branches', { type: 'cycle', direction: 1 });
  await deliver('branches', { type: 'cycle', direction: -1 });
  console.log(`  tab         ${cycled.join(' | ') || 'NOTHING SENT'}`);

  await deliver('tags', { type: 'screen', action: 'close', ids: [] });
  console.log(`  tags q      ${tags.open ? 'STILL OPEN' : 'closed'}`);

  await deliver('log', { type: 'screen', action: 'close', ids: [] });
  console.log(`  log q       ${log.open ? 'STILL OPEN' : 'closed'}`);

  console.log(`  panels      ${created.map((panel) => panel.viewType).join(', ')}`);
  console.log(`  revealed    ${revealed.join(', ') || 'none'}`);

  await deliver('commit', { type: 'screen', action: 'close', ids: [] });
  console.log(`  commit q    ${commitDoc.open ? 'STILL OPEN' : 'closed'}`);

  for (const panel of [status, branches, tags, submodules, actionlog, log, commitDoc, logDoc]) {
    panel.dispose();
  }
  Module._resolveFilename = originalResolve;
  require('node:fs').rmSync(stubPath, { force: true });
})().catch((error) => {
  console.error(`  FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
