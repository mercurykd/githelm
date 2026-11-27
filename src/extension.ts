import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { EditableDocuments, EDIT_SCHEME } from './fs/editableDocs';
import { getLanguage, isLanguage, Language, LANGUAGES, setLanguage, t } from './i18n';
import { cherryPick, checkoutBranch, createBranch, deleteBranch, listBranchEntries, renameBranch, setUpstream } from './git/actions';
import type { BranchEntry } from './git/actions';
import { clearActions } from './git/actionLog';
import { buildCommitTemplate, cleanCommitMessage } from './git/commitMessage';
import { git } from './git/exec';
import { firstParent } from './git/commitView';
import { repoRelativePath } from './git/fileHistory';
import { choiceShowsDiff, compareChoices, headSha, planCompare, refTip } from './git/compare';
import type { CompareChoice } from './git/compare';
import { markResolved, takeSide } from './git/conflicts';
import { checkoutableRefs, commitBySha } from './git/log';
import type { LogCommit } from './git/log';
import { addRemote, listRemotes, removeRemote, setRemoteUrl } from './git/remotes';
import {
  abortPendingOperation,
  deleteRemoteBranch,
  fetchRemote,
  mergeRef,
  pendingOperation,
  pullRemote,
  pushRemote,
  resetTo,
  revertCommit,
} from './git/ops';
import type { ResetMode } from './git/ops';
import { findRepoRoot, initRepository } from './git/repo';
import { amendCommit, createFixupCommit, hasStagedChanges, headMessage, parentOf } from './git/rewrite';
import { addIntentToAdd } from './git/stage';
import {
  applyStash,
  dropStash,
  planStash,
  popStash,
  pushStash,
  stashFiles,
  stashRefsForFiles,
  StashOptions,
} from './git/stash';
import type { StashCandidate } from './git/stash';
import { entriesOf, readStatus } from './git/status';
import { createTag, deleteRemoteTag, deleteTag, listTags, moveTag, pushTag, remoteTag } from './git/tags';
import type { TagEntry } from './git/tags';
import { addWorktree, isLinkedWorktree, listWorktrees, pruneWorktrees, removeWorktree, samePath } from './git/worktree';
import { readSubmoduleStatus, updateSubmodule } from './git/submodules';
import { fetchForgeItems, ForgeItem, newPullUrl } from './forge/api';
import { ForgeKind, ForgeRemote, parseForgeRemote } from './forge/remote';
import { runInteractiveRebase, RebaseAbortedError } from './rebase/bridge';
import { createReporter } from './util/notifier';
import { ConflictDoc } from './views/conflictDoc';
import { CompareDoc } from './views/compareDoc';
import { StashDoc } from './views/stashDoc';
import { CommitDoc } from './views/commitDoc';
import { formatError } from './util/format';
import { createDiffWalk } from './views/diffWalk';
import { BlameGutter } from './views/blameGutter';
import { HistoryDoc } from './views/historyDoc';
import { filesOf } from './views/fileList';
import type { FileHistoryKind } from './views/historyDoc';
import { Highlighter } from './views/highlight';
import { isInitRow, renderInit } from './views/initRender';
import { initUri, parseInit } from './views/initScreen';
import {
  ActionLogWebview,
  DocWebview,
  ListWebview,
  LogWebview,
  ScreenPanel,
  StatusWebview,
  openFileDiffs,
  openFilesAtRef,
  openRevisionDiffs,
} from './webview/panel';
import type { DocWebviewDeps, ListWebviewDeps, TargetAction } from './webview/panel';
import type { PanelTarget } from './webview/targets';
import { nextScreen } from './webview/carousel';
import type { DocKind, RepoAction, ScreenAction, ScreenKind } from './webview/protocol';
import type { StatusTarget } from './views/statusTarget';
import { SCHEME, VirtualDocuments } from './views/virtualDocs';

/** A file row of the status screen: the target of staging, diffing and ignoring. */
type FileTarget = Extract<StatusTarget, { kind: 'file' }>;

export function activate(context: vscode.ExtensionContext): void {
  const storedLanguage = context.globalState.get<string>('githelm.language');
  if (isLanguage(storedLanguage)) {
    setLanguage(storedLanguage);
  }

  const output = vscode.window.createOutputChannel('Git Helm');
  const docs = new VirtualDocuments();
  const editable = new EditableDocuments();
  const highlighter = new Highlighter();
  const commitDoc = new CommitDoc(docs, highlighter);
  const blameGutter = new BlameGutter();
  const historyDoc = new HistoryDoc(docs, highlighter, blameGutter);
  const stashDoc = new StashDoc(docs, highlighter);
  const compareDoc = new CompareDoc(docs, highlighter);
  const conflictDoc = new ConflictDoc(docs, highlighter);

  context.subscriptions.push(
    output,
    docs,
    editable,
    highlighter,
    blameGutter,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, docs),
    vscode.workspace.registerFileSystemProvider(EDIT_SCHEME, editable, { isCaseSensitive: true })
  );

  const reporter = createReporter(
    {
      status: (message, ttlMs) => void vscode.window.setStatusBarMessage(message, ttlMs),
      popup: (message) => void vscode.window.showErrorMessage(message),
    },
    formatError
  );
  const notify = (message: string): void => reporter.info(message);
  // A refused action gets the status bar and a notification: the status bar line
  // is gone in four seconds, and the user is looking at the buffer.
  const refuse = (message: string): void => reporter.refuse(message);
  const warn = (message: string): void => void vscode.window.showWarningMessage(message);

  // `←`/`→` in the diff editor: step the diff on screen to the neighbouring commit. A
  // single-file diff says what it compares by itself (its two `git:` revision URIs), so a
  // tab reopened after a reload is walkable again the moment it is read; a multi-diff is
  // remembered by its label, because VS Code reports no input for it at this API version.
  const diffWalk = createDiffWalk({ notice: refuse });

  // The webview status screen. The text buffers stay as they are, so the old screen
  // keeps working while the new one grows screen by screen.
  const statusWebview = new StatusWebview({
    extensionUri: context.extensionUri,
    notify,
    warn,
    commit: (repoPath) => runWithProgress(progressFor('githelm.status.commit'), () => commitFromBuffer(repoPath)),
    // `t` has no progress entry in the buffer either: it asks for a name and a
    // message, and the questions are the whole of the wait.
    createTag: async (repoPath) => {
      await createTagAt(repoPath);
      await updateStatusBar();
    },
    stash: (repoPath, files) => runWithProgress(progressFor('githelm.status.stash'), () => runStash(repoPath, files)),
    // The panel's keys stand for buffer commands, so they report through the same
    // table: `f` spins `fetching` and ends with `$(check) fetched` in either UI.
    runRepo: (action, repoPath) =>
      runWithProgress(progressFor(PROGRESS_FOR_REPO[action]), () => runRepo(action, repoPath)),
    runTarget: (action, repoPath, target) =>
      runWithProgress(progressFor(PROGRESS_FOR_TARGET[action]), () => runTarget(action, repoPath, target)),
    // The branches block under the status files runs the branches screen's keys, so `n`
    // asks the same question and `m` refuses the current branch in one implementation.
    runBranch: (action, repoPath, ids) =>
      runWithProgress(progressFor(SCREEN_COMMAND.branches[action]), () => runBranch(action, repoPath, ids)),
    // The last-commits rows under the status files run the history screen's keys, so the
    // commit is named on both screens by the same `runLog` and the same guards.
    runLog: (action, repoPath, ids) =>
      runWithProgress(progressFor(LOG_COMMAND[action]), () => runLog(action, repoPath, ids)),
    // `d`: the selected files in the built-in diff editor — the editor's own diff, in
    // both UIs, because a generated patch only looks like one.
    openDiff: (repoPath, targets) => openBuiltinDiff(repoPath, targets),
    statusBar: () => updateStatusBar(),
    // `Tab` walks the screens; `q` hands the keyboard to another screen that is open.
    cycle: (from, direction, repoPath) => cycleScreens(from, direction, repoPath),
    neighbour: (from) => focusNeighbour(from),
  });
  context.subscriptions.push(statusWebview);

  /**
   * The command each key of a list screen stands for, so the panel's progress line is
   * the buffer command's own (`reset` spins and ends with `$(check) updated`, the rest
   * have no entry and only re-read the screen).
   */
  const SCREEN_COMMAND: Record<'branches' | 'tags' | 'submodules', Partial<Record<ScreenAction, string>>> = {
    branches: {
      checkout: 'githelm.branches.checkout',
      create: 'githelm.branches.create',
      rename: 'githelm.branches.rename',
      upstream: 'githelm.branches.upstream',
      remove: 'githelm.branches.delete',
      removeRemote: 'githelm.branches.deleteRemote',
      merge: 'githelm.branches.merge',
      reset: 'githelm.branches.reset',
    },
    tags: {
      show: 'githelm.tags.show',
      create: 'githelm.tags.create',
      move: 'githelm.tags.move',
      push: 'githelm.tags.push',
      remove: 'githelm.tags.delete',
      removeRemote: 'githelm.tags.deleteRemote',
    },
    submodules: {
      update: 'githelm.submodules.update',
      updateRemote: 'githelm.submodules.updateRemote',
    },
  };

  const listDeps = (kind: 'branches' | 'tags' | 'submodules'): ListWebviewDeps => ({
    extensionUri: context.extensionUri,
    notify,
    warn,
    statusBar: () => updateStatusBar(),
    cycle: (from, direction, repoPath) => cycleScreens(from, direction, repoPath),
    neighbour: (from) => focusNeighbour(from),
    // The panel's keys stand for buffer commands, so they report through the same
    // table: `shift+s` on a branch spins `resetting` and ends with `$(check) updated`.
    run: (action, repoPath, ids) =>
      runWithProgress(progressFor(SCREEN_COMMAND[kind][action]), () =>
        kind === 'branches' ? runBranch(action, repoPath, ids) : kind === 'tags' ? runTag(action, repoPath, ids) : runSubmodule(action, repoPath, ids)
      ),
    // `d` on a branch reads its `log …` answer on the history screen, which is the one
    // place a range is drawn as a graph.
    openLogRange: (repoPath, range, leftRight) => logWebview.showRange(repoPath, range, leftRight),
    // `G` on a branch opens that branch's graph: the history screen's branch filter is the
    // one implementation of `git log <branch>`, so the key hands it the name.
    openLogBranch: (repoPath, branch) => logWebview.showBranch(repoPath, branch),
    // A `diff …` answer lands on the range's file list; `d` inside it opens the editor.
    openCompareList: (repoPath, plan) =>
      openCompareDoc(repoPath, plan.range, plan.diffLeft, plan.diffRight, plan.label),
  });

  /** The same table for the history screen: only the keys that wait for git have a line. */
  const LOG_COMMAND: Partial<Record<ScreenAction, string>> = {
    reset: 'githelm.log.reset',
    fixup: 'githelm.log.fixup',
  };

  const branchesWebview = new ListWebview(listDeps('branches'), 'branches');
  const tagsWebview = new ListWebview(listDeps('tags'), 'tags');
  const submodulesWebview = new ListWebview(listDeps('submodules'), 'submodules');
  const actionLogWebview = new ActionLogWebview({
    extensionUri: context.extensionUri,
    notify,
    warn,
    statusBar: () => updateStatusBar(),
    cycle: (from, direction, repoPath) => cycleScreens(from, direction, repoPath),
    neighbour: (from) => focusNeighbour(from),
    clear: () => runClearActionLog(),
  });
  context.subscriptions.push(branchesWebview, tagsWebview, submodulesWebview, actionLogWebview);

  /**
   * The history screen. Its keys run through `runLog` — the buffer's own implementation
   * — and it keeps what it shows (the filters, the order, how much history has been
   * read) to itself, so the panel and the buffer are two readings of one repository.
   */
  const logWebview = new LogWebview({
    extensionUri: context.extensionUri,
    notify,
    warn,
    statusBar: () => updateStatusBar(),
    cycle: (from, direction, repoPath) => cycleScreens(from, direction, repoPath),
    neighbour: (from) => focusNeighbour(from),
    run: (action, repoPath, ids) =>
      runWithProgress(progressFor(LOG_COMMAND[action]), () => runLog(action, repoPath, ids)),
    openCompareList: (repoPath, plan) =>
      openCompareDoc(repoPath, plan.range, plan.diffLeft, plan.diffRight, plan.label),
  });
  context.subscriptions.push(logWebview);

  /** Every panel, in the order the status bar and `resolveRepo()` follow them. */
  /**
   * The sub-screens — a commit's files, a stash's files, a conflict, a file's history —
   * are documents, and several can be open at once, so they are panels of their own
   * rather than stops of the carousel. One panel per document: opening the same commit
   * again reveals the tab that is already showing it.
   */
  const docPanels = new Map<string, DocWebview>();

  /** The name a sub-screen's tab shows: the commit, the conflict, the file of a history. */
  const docTitleOf = (uri: vscode.Uri): string => {
    const compare = compareDoc.stateFor(uri);
    if (compare) {
      return compare.label;
    }
    const parts = decodeURIComponent(uri.path).split('/').filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? t('app.name');
  };

  /**
   * Re-reads a sub-screen's document from `git` without opening a tab: what `r` does,
   * and what every action ends with, so the panel never shows a stale patch.
   */
  const reloadDoc = async (uri: vscode.Uri): Promise<void> => {
    const init = parseInit(uri);
    if (init) {
      // `r` on the screen that says "not a repository": the folder may have become one in a
      // terminal since the screen was painted, in which case the screen has nothing left to
      // say and the status panel takes its place; otherwise it is painted again, so the path
      // and the row it offers are still the truth.
      const root = await findRepoRoot(init.folderPath);
      if (root) {
        docPanels.get(uri.toString())?.dispose();
        await statusWebview.show(root);
        return;
      }
      paintInit(uri, init.folderPath);
      return;
    }
    if (stashDoc.stateFor(uri)) {
      await stashDoc.reload(uri);
      return;
    }
    if (compareDoc.stateFor(uri)) {
      await compareDoc.reload(uri);
      return;
    }
    const conflict = conflictDoc.stateFor(uri);
    if (conflict) {
      await conflictDoc.prepare(conflict.repoPath, conflict.relativePath);
      return;
    }
    const commit = CommitDoc.parse(uri);
    if (commit) {
      await commitDoc.prepare(commit.repoPath, commit.sha);
      return;
    }
    const history = HistoryDoc.parse(uri);
    if (history) {
      await historyDoc.prepare(history.kind, history.repoPath, history.relativePath);
    }
  };

  const docDeps = (): DocWebviewDeps => ({
    extensionUri: context.extensionUri,
    notify,
    warn,
    statusBar: () => updateStatusBar(),
    cycle: (from, direction, repoPath) => cycleScreens(from, direction, repoPath),
    neighbour: (from) => focusNeighbour(from),
    textOf: (uri) => docs.get(uri),
    spansOf: (uri) => highlighter.spansOf(uri),
    reload: (uri) => reloadDoc(uri),
    titleOf: (uri) => docTitleOf(uri),
    groupsOf: (uri) => {
      const list = commitDoc.fileListOf(uri) ?? stashDoc.fileListOf(uri) ?? compareDoc.fileListOf(uri);
      if (!list) {
        return undefined;
      }
      // The buffers count lines from 1, the way an editor does; the model counts them from 0.
      return [{ header: list.header - 1, lines: list.lines.map((line) => line - 1) }];
    },

    run: (action, uri, lines) => runDoc(action, uri, lines),
    forget: (uri) => docPanels.delete(uri.toString()),
  });

  /**
   * Opens a sub-screen on a document: `prepare` renders it into the virtual document
   * (the same code the buffer runs), then the panel reads it back.
   */
  const openDoc = async (
    doc: DocKind,
    uri: vscode.Uri,
    repoPath: string,
    prepare: () => Promise<unknown>
  ): Promise<void> => {
    await prepare();
    const key = uri.toString();
    let panel = docPanels.get(key);
    if (!panel || !panel.open) {
      panel = new DocWebview(docDeps(), doc, uri);
      docPanels.set(key, panel);
      context.subscriptions.push(panel);
    }
    await panel.show(repoPath);
  };

  /**
   * `d` in the status panel: the selection in the built-in multi-diff editor — the
   * editor's own diff, which is the same pair the SCM view would show, with folding,
   * syntax highlighting and both sides side by side. Untracked files are adopted as
   * intent-to-add first, or the index has nothing to compare them with.
   */
  const openBuiltinDiff = async (repoPath: string, targets: readonly FileTarget[]): Promise<void> => {
    for (const target of targets) {
      if (target.section === 'untracked') {
        await addIntentToAdd(repoPath, target.path);
      }
    }
    await openFileDiffs(repoPath, targets);
  };
  /**
   * The other sub-screens. Each one is the buffer's own renderer with the tab left out,
   * so in webview mode `enter` on a commit, a stash, a conflict or a file opens a panel
   * that draws exactly the text the buffer would have drawn.
   */
  const openCommitDoc = async (repoPath: string, sha: string): Promise<void> => {
    await openDoc('commit', CommitDoc.uriFor(repoPath, sha), repoPath, () => commitDoc.prepare(repoPath, sha));
  };

  const openStashDoc = async (repoPath: string, ref: string): Promise<void> => {
    await openDoc('stash', StashDoc.uriFor(repoPath, ref), repoPath, () => stashDoc.prepare(repoPath, ref));
  };

  const openConflictDoc = async (repoPath: string, relativePath: string): Promise<void> => {
    await openDoc('conflict', ConflictDoc.uriFor(repoPath, relativePath), repoPath, () =>
      conflictDoc.prepare(repoPath, relativePath)
    );
  };

  const openFileHistoryDoc = async (kind: FileHistoryKind, repoPath: string, relativePath: string): Promise<void> => {
    await openDoc('file', HistoryDoc.uriFor(repoPath, kind, relativePath), repoPath, () =>
      historyDoc.prepare(kind, repoPath, relativePath)
    );
  };

  /**
   * The status screen of a folder that is not a repository yet. The screen cannot be built
   * from `git status` — git refuses the folder — so the panel draws the buffer's own
   * `renderUninitialized()` text: the folder, the line saying it is not a repository, and
   * the one row that fixes it. `Enter` on that row runs `git init` and the tab gives way to
   * the status panel of the repository it created.
   */
  const paintInit = (uri: vscode.Uri, folderPath: string): void => {
    const rendered = renderInit(folderPath);
    docs.set(uri, rendered.text);
    highlighter.setSpans(uri, rendered.spans);
  };

  const openInitDoc = async (folderPath: string): Promise<void> => {
    const uri = initUri(folderPath);
    await openDoc('init', uri, folderPath, async () => paintInit(uri, folderPath));
  };

  /**
   * A compare ends in a file list, as a commit and a stash do: the range's files are the
   * screen, and `d` inside it opens one or all of them in the editor. The list is the same
   * document machinery the other sub-screens use, so a click on `## files` selects the
   * whole list and the notice for an empty range is the compare's own.
   */
  const openCompareDoc = async (
    repoPath: string,
    range: string,
    leftRef: string,
    rightRef: string,
    label: string
  ): Promise<void> => {
    const uri = await compareDoc.prepare(repoPath, range, leftRef, rightRef, label);
    if ((compareDoc.fileListOf(uri)?.lines.length ?? 0) === 0) {
      warn(t('compare.noChanges', { range: label }));
      return;
    }
    await openDoc('compare', uri, repoPath, async () => undefined);
  };
  const openStashFiles = async (repoPath: string, ref: string): Promise<void> => {
    await openStashDoc(repoPath, ref);
  };

  const openConflictFile = async (repoPath: string, relativePath: string): Promise<void> => {
    await openConflictDoc(repoPath, relativePath);
  };

  const openCommitView = async (repoPath: string, sha: string): Promise<void> => {
    await openCommitDoc(repoPath, sha);
  };

  /**
   * A file's history: its log is text and the panel draws it; its blame is code and only an
   * editor can highlight it — a webview has no grammar for it — so the blame is the one screen
   * that opens in the editor.
   */
  const openFileHistory = async (kind: FileHistoryKind, repoPath: string, relativePath: string): Promise<void> => {
    if (kind === 'log') {
      await openFileHistoryDoc(kind, repoPath, relativePath);
      return;
    }
    await historyDoc.openBlame(repoPath, relativePath);
  };

  /**
   * The keys of a sub-screen, run against its document. A file list's `d` is the diff of
   * every selected file in the editor — one multi-diff tab, not the first file only; the
   * conflict screen has the sides, the merge editor and the resolved marker.
   */
  const runDoc = async (action: ScreenAction, uri: vscode.Uri, lines: number[]): Promise<void> => {
    // The document's lines are 0-based ids; the buffers count rows from 1.
    const rows = lines.map((line) => line + 1);

    // The `git init` screen: one row, one key. With nothing selected — which is how the
    // screen opens — `Enter` means that row; on any other line it is a no-op, as it is in
    // the buffer, where only that row carries a target.
    const init = parseInit(uri);
    if (init) {
      const onRow = rows.length === 0 || rows.some((row) => isInitRow(init.folderPath, row));
      if (action === 'open' && onRow) {
        await initRepo(init.folderPath);
      }
      return;
    }

    // A stash's file list: `d` is the change of every selected file, the stash against its parent;
    // `t` opens those files as they were inside the stash.
    if (stashDoc.stateFor(uri)) {
      if (action === 'fileDiff') {
        await openStashFileDiffs(uri, rows);
      } else if (action === 'filesAtRef') {
        await openStashFilesAtRef(uri, rows);
      }
      return;
    }

    // A compare's file list: `d` is the diff of the selected files, the range's two
    // sides at their own revisions; the same `filesAtRef` action opens files at a commit.
    if (compareDoc.stateFor(uri)) {
      if (action === 'fileDiff') {
        await openCompareFileDiffs(uri, rows);
      }
      return;
    }

    // A commit's file list: `d` is the change of every selected file, the parent against the
    // commit; `t` opens those files as the commit left them.
    if (commitDoc.stateFor(uri)) {
      if (action === 'fileDiff') {
        await openCommitFileDiffs(uri, rows);
      } else if (action === 'filesAtRef') {
        await openCommitFilesAtRef(uri, rows);
      }
      return;
    }

    // A conflicted file: the sides, the merge editor and the resolved marker.
    if (conflictDoc.stateFor(uri)) {
      if (action === 'ours' || action === 'theirs' || action === 'base') {
        await takeConflictSide(uri, action);
      } else if (action === 'resolve') {
        await resolveConflict(uri);
      } else if (action === 'mergeEditor') {
        await openMergeEditor(uri);
      }
      return;
    }
  };
  const screenPanels: ScreenPanel[] = [statusWebview, branchesWebview, tagsWebview, submodulesWebview, logWebview, actionLogWebview];

  /** The repository of the panel the user is looking at, if any panel is on screen. */
  const visiblePanelRepo = (): string | undefined => {
    for (const panel of screenPanels) {
      const repo = panel.repoIfVisible();
      if (repo) {
        return repo;
      }
    }
    return undefined;
  };

  /** Every screen that has a panel, for lookups: the carousel in `carousel.ts` is a subset. */
  const ALL_SCREENS: ScreenKind[] = ['status', 'branches', 'tags', 'submodules', 'log', 'actionlog'];

  /** Whether a panel is one of the carousel's screens, and not one of the sub-screens. */
  const isScreenKind = (kind: ScreenKind | DocKind): kind is ScreenKind =>
    (ALL_SCREENS as readonly string[]).includes(kind);

  const panelOf = (kind: ScreenKind): ScreenPanel => {
    switch (kind) {
      case 'branches':
        return branchesWebview;
      case 'tags':
        return tagsWebview;
      case 'submodules':
        return submodulesWebview;
      case 'log':
        return logWebview;
      case 'actionlog':
        return actionLogWebview;
      default:
        return statusWebview;
    }
  };

  /**
   * `Tab`: the next screen *in the tab you are in*. The screen you leave closes first, so
   * the carousel never adds a tab — the next screen takes the place of the one that went
   * away, which is what a carousel means inside one editor group.
   */
  const cycleScreens = async (from: ScreenKind | DocKind, direction: 1 | -1, repo: string): Promise<void> => {
    // A sub-screen is a document, not a stop of the carousel: `Tab` there does nothing.
    if (!isScreenKind(from)) {
      return;
    }
    const kind = nextScreen(from, direction);
    if (!kind) {
      return;
    }
    // The repository is found *before* anything is closed: a `Tab` that cannot open the
    // next screen must not leave the user without the screen they were reading. The
    // panel's own repository wins, so walking from the branches of repo A opens the tags
    // of repo A and not of the first workspace folder.
    const target = repo || (await resolveRepo());
    if (!target) {
      warn(t('msg.noRepo'));
      return;
    }
    panelOf(from).dispose();
    await panelOf(kind).show(target);
  };

  /** After `q`: an open screen takes the focus, so the keys keep working. */
  const focusNeighbour = async (from: ScreenKind | DocKind): Promise<void> => {
    // A sub-screen has no place in the carousel: nothing to walk on from it.
    const at = isScreenKind(from) ? ALL_SCREENS.indexOf(from) : -1;
    for (let step = 1; at >= 0 && step < ALL_SCREENS.length; step++) {
      const index = (at + step) % ALL_SCREENS.length;
      const panel = panelOf(ALL_SCREENS[index]);
      if (panel.open) {
        panel.reveal();
        return;
      }
    }
    // No other panel: put the focus back in the editor group, where a text editor (and
    // with it the buffer keys) can take it.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  };

  /**
   * The panel re-reads the repository on the same quarter-second debounce the
   * buffers use. Two things call it: the file watcher below (a `git` run in a
   * terminal, a saved document) and every command this extension runs.
   */
  let panelTimer: NodeJS.Timeout | undefined;
  const schedulePanelRefresh = (): void => {
    if (panelTimer) {
      clearTimeout(panelTimer);
    }
    panelTimer = setTimeout(() => {
      panelTimer = undefined;
      // Every panel that is on screen follows the same events the buffers do, so a
      // `git` run in a terminal is visible in whichever screen the user has open.
      void Promise.all(screenPanels.map((panel) => panel.refreshIfVisible())).catch((error: unknown) =>
        output.appendLine(`[refresh] ${formatError(error)}`)
      );
    }, 250);
  };
  context.subscriptions.push({
    dispose: () => {
      if (panelTimer) {
        clearTimeout(panelTimer);
      }
    },
  });

  const activityItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  activityItem.name = 'Git Helm';
  let activityTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(activityItem, {
    dispose: () => {
      if (activityTimer) {
        clearTimeout(activityTimer);
      }
    },
  });

  const showActivity = (text: string, tooltip: string, ttlMs?: number): void => {
    if (activityTimer) {
      clearTimeout(activityTimer);
      activityTimer = undefined;
    }
    activityItem.text = text;
    activityItem.tooltip = tooltip;
    activityItem.command = 'githelm.actionLog';
    activityItem.show();
    if (ttlMs) {
      activityTimer = setTimeout(() => activityItem.hide(), ttlMs);
    }
  };

  const showProgress = (label: string, update: { text: string; percent?: number }): void => {
    const suffix = update.percent === undefined ? '' : ` ${update.percent}%`;
    showActivity(`$(sync~spin) ${label}${suffix}`, update.text);
  };

  const showTransientError = (message: string): void => {
    const short = message.length > 60 ? `${message.slice(0, 59)}…` : message;
    showActivity(`$(error) ${short}`, message, 12_000);
  };

  const fail = (error: unknown): void => {
    reporter.fail(error, (line) => output.appendLine(line), showTransientError);
  };

  const PROGRESS: Record<string, { spin: string; done?: string }> = {
    'githelm.status.fetch': { spin: t('progress.fetch'), done: t('msg.fetched') },
    'githelm.status.pull': { spin: t('progress.pull'), done: t('msg.pulled') },
    'githelm.status.push': { spin: t('progress.push'), done: t('msg.pushed') },
    'githelm.status.reset': { spin: t('progress.reset'), done: t('msg.updated') },
    'githelm.log.reset': { spin: t('progress.reset'), done: t('msg.updated') },
    'githelm.branches.reset': { spin: t('progress.reset'), done: t('msg.updated') },
    'githelm.branches.merge': { spin: t('progress.merge'), done: t('msg.updated') },
    'githelm.status.abortMerge': { spin: t('progress.reset'), done: t('msg.mergeAborted') },
    'githelm.status.commit': { spin: t('progress.commit'), done: t('msg.committed') },
    'githelm.status.amend': { spin: t('progress.commit'), done: t('msg.amendDone') },
    'githelm.status.stash': { spin: t('progress.stash'), done: t('msg.stashCreated') },
    'githelm.rebase.interactive': { spin: t('progress.rebase') },
    'githelm.log.fixup': { spin: t('progress.rebase') },
    'githelm.tags.create': { spin: t('progress.tags'), done: t('msg.updated') },
    'githelm.tags.move': { spin: t('progress.tags'), done: t('msg.updated') },
    'githelm.tags.delete': { spin: t('progress.tags'), done: t('msg.deleted') },
    'githelm.submodules.update': { spin: t('progress.submoduleUpdate'), done: t('msg.updated') },
    'githelm.submodules.updateRemote': { spin: t('progress.submoduleUpdate'), done: t('msg.updated') },
    'githelm.forge.pulls': { spin: t('progress.forge') },
  };

  /** The progress line of one command, if that command has one. */
  const progressFor = (id: string | undefined): { spin: string; done?: string } | undefined =>
    id ? PROGRESS[id] : undefined;

  /**
   * Which command each panel key stands for, so its spinner and its `$(check) line`
   * are the ones the buffer shows for the same key. Keys without an entry here are
   * instant in the buffer too, and stay silent in the panel.
   */
  const PROGRESS_FOR_REPO: Partial<Record<RepoAction, string>> = {
    amend: 'githelm.status.amend',
    fetch: 'githelm.status.fetch',
    pull: 'githelm.status.pull',
    push: 'githelm.status.push',
    reset: 'githelm.status.reset',
    abort: 'githelm.status.abortMerge',
    pulls: 'githelm.forge.pulls',
  };

  const PROGRESS_FOR_TARGET: Partial<Record<TargetAction, string>> = {
    fetch: 'githelm.status.fetch',
    pull: 'githelm.status.pull',
    push: 'githelm.status.push',
  };

  /**
   * One action, reported the way the status bar reports a command: a spinner with
   * the progress line while it runs, then `$(check) done` for four seconds, a hidden
   * item when it has nothing to say, and a logged failure with a popup when it
   * throws. Registered commands and the panel's keys both go through here, which is
   * why `f` spins `fetching` in both UIs.
   */
  const runWithProgress = async (
    progress: { spin: string; done?: string } | undefined,
    handler: () => Promise<void>
  ): Promise<void> => {
    if (progress) {
      showActivity(`$(sync~spin) ${progress.spin}`, progress.spin);
    }
    try {
      await handler();
      if (progress?.done) {
        showActivity(`$(check) ${progress.done}`, progress.done, 4000);
      } else if (progress) {
        activityItem.hide();
      }
    } catch (error) {
      fail(error);
    } finally {
      // A command may have moved the repository without touching the index (a tag,
      // a fetch that changed the ahead/behind counters) and the panel is not one of
      // the buffers the handlers re-render, so it re-reads on its own timer.
      schedulePanelRefresh();
    }
  };

  const guarded =
    (handler: () => Promise<void>, progress?: { spin: string; done?: string }) =>
    async (): Promise<void> =>
      runWithProgress(progress, handler);

  const viewOf = (uri: vscode.Uri | undefined): string => {
    if (!uri || uri.scheme !== SCHEME) {
      return '';
    }
    if (uri.path.startsWith('/diff/unstaged/')) {
      return 'diff-unstaged';
    }
    if (uri.path.startsWith('/diff/staged/')) {
      return 'diff-staged';
    }
    if (uri.path.startsWith('/log/')) {
      return 'log';
    }
    if (uri.path.startsWith('/branches/')) {
      return 'branches';
    }
    if (uri.path.startsWith('/tags/')) {
      return 'tags';
    }
    if (uri.path.startsWith('/submodules/')) {
      return 'submodules';
    }
    if (uri.path.startsWith('/file/')) {
      return 'text';
    }
    if (uri.path.startsWith('/actionlog')) {
      return 'actionlog';
    }
    if (uri.path.startsWith('/commit/')) {
      return 'commit';
    }
    if (uri.path.startsWith('/stashfiles/')) {
      return 'stashfiles';
    }
    if (uri.path.startsWith('/compare/')) {
      return 'compare';
    }
    if (uri.path.startsWith('/conflict/')) {
      return 'conflict';
    }
    if (uri.path.startsWith('/status/')) {
      return 'status';
    }
    return '';
  };

  const syncContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'githelm.view',
      viewOf(vscode.window.activeTextEditor?.document.uri)
    );
  };

  const resolveRepo = async (): Promise<string | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      // An editor of ours is the blame, the only screen that is text: it names its repository.
      const uri = editor.document.uri;
      const fromDoc =
        HistoryDoc.parse(uri)?.repoPath ??
        CommitDoc.parse(uri)?.repoPath ??
        StashDoc.parse(uri)?.repoPath ??
        ConflictDoc.parse(uri)?.repoPath;
      if (fromDoc) {
        return fromDoc;
      }
      if (uri.scheme === 'file') {
        const root = await findRepoRoot(path.dirname(uri.fsPath));
        if (root) {
          return root;
        }
      }
    }
    // The panel is a screen of its own: with the focus in it no text editor is
    // active, and the repository it shows is the one the user means.
    const fromPanel = visiblePanelRepo();
    if (fromPanel) {
      return fromPanel;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = await findRepoRoot(folder.uri.fsPath);
      if (root) {
        return root;
      }
    }
    return undefined;
  };

  /**
   * Folder the user is working in, even when it has no repository yet: the
   * status screen still opens there and offers `git init`.
   */
  const resolveFolder = (): string | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      const owner = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      return owner ? owner.uri.fsPath : path.dirname(editor.document.uri.fsPath);
    }
    return visiblePanelRepo() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  };

  /** Runs `git init` and opens the status panel of the repository it made. */
  const initRepo = async (folderPath: string): Promise<void> => {
    const root = await initRepository(folderPath);
    // The screen that asked is the one that gives way: its panel closes and the status panel
    // of the new repository takes its place.
    const initPanel = docPanels.get(initUri(folderPath).toString());
    await updateStatusBar();
    if (initPanel) {
      initPanel.dispose();
    }
    await statusWebview.show(root);
    notify(t('msg.repoInitialized', { path: root }));
  };

  const closeIfActive = async (uri: vscode.Uri): Promise<void> => {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === uri.toString()) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  };

  const shimsDir = (): string => {
    const dir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'shims').fsPath;
    if (!fs.existsSync(path.join(dir, 'git-editor.sh'))) {
      throw new Error(`Editor shim not found: ${dir}. Run npm run build.`);
    }
    return dir;
  };

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Git Helm';
  statusItem.command = 'githelm.status.open';
  context.subscriptions.push(statusItem);

  const updateStatusBar = async (): Promise<void> => {
    try {
      const repo = await resolveRepo();
      if (!repo) {
        // No repository: the status bar item becomes the `git init` button.
        const folder = resolveFolder();
        if (!folder) {
          statusItem.hide();
          return;
        }
        statusItem.text = '$(git-branch) git init';
        statusItem.tooltip = `${folder}\n${t('msg.notRepoInit')}`;
        statusItem.command = 'githelm.repo.init';
        statusItem.show();
        return;
      }
      const status = await readStatus(repo);
      const staged = status.entries.filter((entry) => entry.section === 'staged').length;
      const dirty = status.entries.filter((entry) => entry.section !== 'staged').length;
      const linked = isLinkedWorktree(repo);
      const parts = [`$(git-branch) ${status.branch ?? t('status.detached')}`];
      if (staged > 0) {
        parts.push(`$(check) ${staged}`);
      }
      if (dirty > 0) {
        parts.push(`$(pencil) ${dirty}`);
      }
      if (linked) {
        // Same branch names live in several folders: name the checkout.
        parts.push(`$(folder) ${path.basename(repo)}`);
      }
      statusItem.text = parts.join(' ');
      statusItem.tooltip = `${repo}${linked ? `\n${t('msg.worktreeBadge')}` : ''}\nstaged: ${staged}, other changes: ${dirty}\nClick to open Git Helm status`;
      statusItem.command = 'githelm.status.open';
      statusItem.show();
    } catch {
      statusItem.hide();
    }
  };

  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      // The panel follows the same events the screens always followed, in the same
      // tick, so one screen never lags behind another.
      void statusWebview
        .refreshIfVisible()
        .catch((error: unknown) => output.appendLine(`[refresh] ${formatError(error)}`));
      void updateStatusBar();
    }, 250);
  };
  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    },
  });

  const indexWatcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
  context.subscriptions.push(
    indexWatcher,
    indexWatcher.onDidChange(scheduleRefresh),
    indexWatcher.onDidCreate(scheduleRefresh)
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      syncContext();
      highlighter.applyVisible();
      blameGutter.repaint();
      void updateStatusBar();
      void diffWalk.sync();
    }),
    // A diff is a tab, not always the active editor: switching to one by its tab, or
    // closed by us after a step, is only reported here.
    vscode.window.tabGroups.onDidChangeTabs(() => void diffWalk.sync()),
    // The arrows are gated on a key of ours, which every group's title toolbar can see, so
    // it has to follow the group too: focusing another group makes its own tab the active
    // one without a tab event.
    vscode.window.tabGroups.onDidChangeTabGroups(() => void diffWalk.sync()),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      highlighter.applyVisible();
      blameGutter.repaint();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === event.document);
      if (editor) {
        highlighter.apply(editor);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh())
  );

  const register = (id: string, handler: () => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded(handler, PROGRESS[id])));
  };

  register('githelm.status.open', async () => {
    const repo = await resolveRepo();
    if (repo) {
      await statusWebview.show(repo);
      // The status bar follows the screen it belongs to.
      await updateStatusBar();
      return;
    }
    const folder = resolveFolder();
    if (!folder) {
      warn(t('msg.noRepo'));
      return;
    }
    // No repository yet: show the status screen with a `git init` row instead of
    // failing, and put the same action on a notification button. The panel draws that
    // screen too — it is the buffer's own text — so the key never falls back to a buffer.
    await openInitDoc(folder);
    const choice = await vscode.window.showInformationMessage(t('msg.notRepoInit'), t('action.initGit'));
    if (choice === t('action.initGit')) {
      await initRepo(folder);
    }
  });

  register('githelm.repo.init', async () => {
    const folder = resolveFolder();
    if (!folder) {
      warn(t('msg.noRepo'));
      return;
    }
    const existing = await findRepoRoot(folder);
    if (existing) {
      await statusWebview.show(existing);
      return;
    }
    await initRepo(folder);
  });

  // `alt+s` and `alt+u` are the same two operations for the whole screen, without
  // caring where the cursor is: the pair `s`/`u` next to them stays per file.
  /**
   * A stash's whole diff in the built-in editor: every file it touched, its first parent
   * against the stash itself — the pairs `git stash show -p` prints, one multi-diff tab.
   *
   * Not a `^..` range: `^` alone is not a revision, so `git diff --name-only ^..` exits
   * 128 and the key died with git's own error. The file list is the stash's, read the way
   * its own screen reads it, so `d` on a stash row and `d` on its file list agree.
   */
  const openStashDiffInEditor = async (repoPath: string, ref: string): Promise<void> => {
    const files = await stashFiles(repoPath, ref);
    if (files.length === 0) {
      warn(t('compare.noChanges', { range: ref }));
      return;
    }
    await openRevisionDiffs(
      repoPath,
      files.map((file) => file.path),
      `${ref}^`,
      ref,
      ref
    );
  };

  /**
   * The commands that act on one row of the status screen, with the row passed in
   * instead of read from the caret. The status buffer resolves the row under its
   * cursor; the webview passes the row the user selected. Both run the same code,
   * so they ask the same questions and delete the same things.
   */
  type WorktreeTarget = Extract<StatusTarget, { kind: 'worktree' }>;

  const runOpenTarget = async (repo: string, target: StatusTarget): Promise<void> => {
    if (target.kind === 'init') {
      await initRepo(repo);
      return;
    }
    if (target.kind === 'stash') {
      await openStashFiles(repo, target.ref);
      return;
    }
    if (target.kind === 'worktree') {
      // Another worktree is another checkout: show its own status screen.
      await openRepoStatus(target.path);
      return;
    }
    if (target.kind === 'file' && target.section === 'conflict') {
      await openConflictFile(repo, target.path);
      return;
    }
    if (target.kind !== 'file') {
      notify(t('msg.forFiles'));
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo, target.path)), { preview: false });
  };

  const runDeleteTarget = async (repo: string, target: StatusTarget): Promise<void> => {
    if (target.kind === 'stash') {
      // A dropped stash is gone: the reflog of `stash` is not a place users look.
      const confirmed = await vscode.window.showWarningMessage(
        t('confirm.dropStash', { ref: target.ref }),
        { modal: true },
        t('action.delete')
      );
      if (confirmed !== t('action.delete')) {
        return;
      }
      await dropStash(repo, target.ref);
    } else if (target.kind === 'remote') {
      const confirmed = await vscode.window.showWarningMessage(
        t('confirm.deleteRemote', { name: target.name }),
        { modal: true },
        t('action.delete')
      );
      if (confirmed !== t('action.delete')) {
        return;
      }
      await removeRemote(repo, target.name);
    } else if (target.kind === 'worktree') {
      if (target.current) {
        warn(t('msg.worktreeCurrent'));
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        t('confirm.removeWorktree', { path: target.path }),
        { modal: true },
        t('action.removeWorktree')
      );
      if (confirmed !== t('action.removeWorktree')) {
        return;
      }
      try {
        await removeWorktree(repo, target.path);
      } catch (error) {
        // `git worktree remove` refuses a dirty worktree; offer --force instead.
        const forced = await vscode.window.showWarningMessage(
          t('confirm.removeWorktreeForce'),
          { modal: true },
          t('action.forceRemove')
        );
        if (forced !== t('action.forceRemove')) {
          throw error;
        }
        await removeWorktree(repo, target.path, { force: true });
      }
      await updateStatusBar();
      notify(t('msg.worktreeRemoved', { path: target.path }));
      return;
    } else {
      notify(t('msg.forFiles'));
      return;
    }
    await updateStatusBar();
    notify(t('msg.deleted'));
  };

  const runEditTarget = async (repo: string, target: StatusTarget): Promise<void> => {
    if (target.kind === 'remote') {
      const url = await vscode.window.showInputBox({
        prompt: t('prompt.remoteUrl', { name: target.name }),
        value: target.url,
        ignoreFocusOut: true,
      });
      if (!url || !url.trim() || url.trim() === target.url) {
        return;
      }
      await setRemoteUrl(repo, target.name, url.trim());
    } else {
      notify(t('msg.notEditable'));
      return;
    }
    notify(t('msg.updated'));
  };

  const runStashApply = async (repo: string, ref: string): Promise<void> => {
    await applyStash(repo, ref);
    await updateStatusBar();
    notify(t('msg.stashApplied', { ref }));
  };

  const runStashPop = async (repo: string, ref: string): Promise<void> => {
    await popStash(repo, ref);
    await updateStatusBar();
    notify(t('msg.stashPopped', { ref }));
  };

  const runStashDiff = async (repo: string, ref: string): Promise<void> => {
    await openStashDiffInEditor(repo, ref);
  };

  const runWorktreeWindow = async (target: WorktreeTarget): Promise<void> => {
    if (!fs.existsSync(target.path)) {
      warn(t('msg.worktreeMissing', { path: target.path }));
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.path), {
      forceNewWindow: true,
    });
  };

  const runWorktreeHere = async (target: WorktreeTarget): Promise<void> => {
    if (!fs.existsSync(target.path)) {
      warn(t('msg.worktreeMissing', { path: target.path }));
      return;
    }
    if (target.current) {
      notify(t('msg.worktreeAlreadyHere'));
      return;
    }
    // Reloading the window drops its layout and any unsaved editors, so ask first.
    const confirmed = await vscode.window.showWarningMessage(
      t('confirm.openWorktreeHere', { path: target.path }),
      { modal: true },
      t('action.openHere')
    );
    if (confirmed !== t('action.openHere')) {
      return;
    }
    // `forceReuseWindow` reopens this window on that folder instead of a new one.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.path), {
      forceReuseWindow: true,
    });
  };

  const runRemoteAdd = async (repo: string): Promise<void> => {
    const name = await vscode.window.showInputBox({ prompt: t('prompt.remoteName'), value: 'origin', ignoreFocusOut: true });
    if (!name || !name.trim()) {
      return;
    }
    const url = await vscode.window.showInputBox({
      prompt: t('prompt.remoteUrl', { name: name.trim() }),
      placeHolder: 'git@github.com:user/repo.git',
      ignoreFocusOut: true,
    });
    if (!url || !url.trim()) {
      return;
    }
    await addRemote(repo, name.trim(), url.trim());
    notify(t('msg.remoteAdded', { name: name.trim() }));
  };

  const runWorktreeAdd = async (repo: string): Promise<void> => {
    const suggestedPath = path.resolve(repo, '..', `${path.basename(repo)}-worktree`);
    const worktreePath = await vscode.window.showInputBox({
      prompt: t('prompt.worktreePath'),
      value: suggestedPath,
      ignoreFocusOut: true,
    });
    if (!worktreePath || !worktreePath.trim()) {
      return;
    }
    const target = worktreePath.trim();
    const ref = await vscode.window.showInputBox({
      prompt: t('prompt.worktreeBranch'),
      value: path.basename(target),
      ignoreFocusOut: true,
    });
    if (!ref || !ref.trim()) {
      return;
    }
    await addWorktree(repo, target, ref.trim());
    await updateStatusBar();
    notify(t('msg.worktreeAdded', { path: target }));
  };

  const runWorktreePrune = async (repo: string): Promise<void> => {
    const removed = await pruneWorktrees(repo);
    notify(removed > 0 ? t('msg.worktreePruned', { count: removed }) : t('msg.worktreeNothingToPrune'));
  };

  const commitFromBuffer = async (repo: string): Promise<void> => {
    const status = await readStatus(repo);
    const staged = entriesOf(status, 'staged');
    if (staged.length === 0) {
      warn(t('msg.noStaged'));
      return;
    }

    const uri = editable.createUri('commit-message', repo);
    const content = await editable.edit(uri, buildCommitTemplate(staged));
    await closeIfActive(uri);
    if (content === undefined) {
      notify(t('msg.commitCanceled'));
      return;
    }
    const message = cleanCommitMessage(content);
    if (!message) {
      warn(t('msg.emptyMessage'));
      return;
    }

    const tmp = path.join(os.tmpdir(), `githelm-commit-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, `${message}\n`, 'utf8');
    try {
      const result = await git(repo, ['commit', '-F', tmp]);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `git commit exited ${result.code}`);
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    await updateStatusBar();
    void vscode.window.showInformationMessage(t('msg.committed'));
  };

  register('githelm.rebase.interactive', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    const base = await vscode.window.showInputBox({
      prompt: t('prompt.searchMode'),
      value: 'HEAD~3',
      ignoreFocusOut: true,
    });
    if (!base) {
      return;
    }
    notify(t('msg.updated'));
    const result = await runInteractiveRebase({
      repoPath: repo,
      base,
      shimsDir: shimsDir(),
      onEdit: async (request) => {
        const name = path.basename(request.path).includes('git-rebase-todo') ? 'rebase-todo' : 'commit-message';
        const uri = editable.createUri(name, repo);
        const edited = await editable.edit(uri, request.content);
        await closeIfActive(uri);
        return edited;
      },
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git rebase exited ${result.code}`);
    }
    await updateStatusBar();
    void vscode.window.showInformationMessage(t('msg.updated'));
  });

  register('githelm.log.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await logWebview.show(repo);
    await updateStatusBar();
  });

  const runAmend = async (repo: string): Promise<void> => {
    const message = await headMessage(repo);
    if (message === undefined) {
      warn(t('msg.cursorNotCommit'));
      return;
    }

    const uri = editable.createUri('amend-message', repo);
    const edited = await editable.edit(uri, `${message}\n`);
    await closeIfActive(uri);
    if (edited === undefined) {
      notify(t('msg.amendCanceled'));
      return;
    }
    const trimmed = edited.trim();
    if (!trimmed) {
      warn(t('msg.emptyMessage'));
      return;
    }

    await amendCommit(repo, trimmed);
    await updateStatusBar();
    void vscode.window.showInformationMessage(t('msg.amendDone'));
  };

  /**
   * The stash options of `z`, when the cursors picked no file: `--staged` or
   * `-u`, at most one of them. Nothing picked and Enter means a plain stash;
   * Esc cancels. The list is a checkbox list because that is the only shape VS
   * Code offers for "choose some of these"; a second pick replaces the first,
   * so the pair can never be combined.
   */
  const askStashOptions = (): Promise<StashOptions | undefined> =>
    new Promise((resolve) => {
      const pick = vscode.window.createQuickPick();
      pick.title = t('prompt.stashOptions');
      pick.placeholder = t('prompt.stashOptionsHint');
      pick.canSelectMany = true;
      pick.items = [
        { label: '--staged', description: t('stash.option.staged') },
        { label: '-u', description: t('stash.option.untracked') },
      ];
      let accepted = false;
      let previous: string[] = [];
      pick.onDidChangeSelection((items) => {
        const labels = items.map((item) => item.label);
        if (labels.length > 1) {
          const added = labels.find((label) => !previous.includes(label));
          pick.selectedItems = pick.items.filter((item) => item.label === added);
        }
        previous = pick.selectedItems.map((item) => item.label);
      });
      pick.onDidAccept(() => {
        accepted = true;
        const labels = pick.selectedItems.map((item) => item.label);
        resolve({
          ...(labels.includes('--staged') ? { staged: true } : {}),
          ...(labels.includes('-u') ? { includeUntracked: true } : {}),
        });
        pick.hide();
      });
      pick.onDidHide(() => {
        if (!accepted) {
          resolve(undefined);
        }
        pick.dispose();
      });
      pick.show();
    });

  /**
   * `z`: stash the files the caller names, or — with none — ask for the options and
   * stash the whole working tree. The buffer passes the files under its cursors, the
   * panel the rows it has selected, so both screens ask the same questions in the
   * same order and report in the same place.
   */
  const runStash = async (repo: string, selected: readonly StashCandidate[]): Promise<void> => {
    const options = selected.length > 0 ? {} : await askStashOptions();
    if (options === undefined) {
      return;
    }
    const message = await vscode.window.showInputBox({
      prompt: t('prompt.stashMessage'),
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      return;
    }
    await pushStash(repo, message, planStash(selected, options));
    await updateStatusBar();
    notify(t('msg.stashCreated'));
  };

  /**
   * Asks for a tag name and puts the tag on `target`, or on HEAD when there is
   * none. Both screens share it: `t` on the status screen tags the commit under
   * the cursor when the cursor is on one of the last commits, and `t` in the
   * graph tags the commit the graph shows.
   */
  /**
   * Asks for a name, then for a message: git makes a tag annotated as soon as it
   * has a message, and an annotated tag is what a release tag has to be — a
   * lightweight one is what `git push --follow-tags` silently ignores.
   */
  const createTagAt = async (repo: string, target?: { ref: string; shortSha: string }): Promise<void> => {
    const name = await vscode.window.showInputBox({
      prompt: target ? t('prompt.tagNameOn', { ref: target.shortSha }) : t('prompt.tagName'),
      ignoreFocusOut: true,
    });
    if (!name || !name.trim()) {
      return;
    }
    const message = await vscode.window.showInputBox({
      prompt: t('prompt.tagMessage'),
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      // Escape on the second prompt cancels the tag instead of quietly making a
      // lightweight one the user did not ask for.
      return;
    }
    await createTag(repo, name.trim(), message.trim() || undefined, target?.ref);
    notify(t('msg.tagCreated', { name: name.trim() }));
  };

  register('githelm.branches.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await branchesWebview.show(repo);
    await updateStatusBar();
  });

  // ---------- branches: the keys, run from the cursor or from the panel ----------

  /** Re-reads an open screen buffer without moving its cursor. */
  /** Re-reads every screen that is on screen: the panels follow the same events. */
  const refreshScreens = async (): Promise<void> => {
    await Promise.all(screenPanels.map((panel) => panel.refreshIfVisible()));
  };

  /** The branch a panel row names, looked up again in the repository. */
  const branchFromIds = async (repo: string, ids: readonly string[]): Promise<BranchEntry | undefined> => {
    const id = ids[0];
    const name = id?.startsWith('branch:') ? id.slice('branch:'.length) : undefined;
    if (!name) {
      return undefined;
    }
    return (await listBranchEntries(repo, true)).find((entry) => entry.name === name);
  };

  /** The tag a panel row names, looked up again in the repository. */
  const tagFromIds = async (repo: string, ids: readonly string[]): Promise<TagEntry | undefined> => {
    const id = ids[0];
    const name = id?.startsWith('tag:') ? id.slice('tag:'.length) : undefined;
    if (!name) {
      return undefined;
    }
    return (await listTags(repo)).find((tag) => tag.name === name);
  };

  /**
   * The branches a compare names, the first two distinct ones, looked up in the
   * repository again. `d` takes one row (against HEAD) or two (against each other), the
   * same way the history screen does.
   */
  const branchesFromIds = async (repo: string, ids: readonly string[]): Promise<BranchEntry[]> => {
    const names = [
      ...new Set(ids.filter((id) => id.startsWith('branch:')).map((id) => id.slice('branch:'.length))),
    ].slice(0, 2);
    if (names.length === 0) {
      return [];
    }
    const entries = await listBranchEntries(repo, true);
    return names.map((name) => entries.find((entry) => entry.name === name)).filter((entry): entry is BranchEntry => !!entry);
  };

  /**
   * The six ways to compare two commits or branches, asked the way the buffer asks it.
   * The list itself lives in `git/compare.ts`, so the panels offer the same six in the
   * same order and with the same wording.
   */
  const pickCompare = async (a: string, b: string): Promise<CompareChoice | undefined> => {
    const picked = await vscode.window.showQuickPick(compareChoices(), {
      placeHolder: t('compare.pick', { a, b }),
    });
    return picked?.value;
  };

  /**
   * A compare asked by a screen: `diff …` opens the files of the range in the editor's
   * diff, `log …` opens the history buffer on the range. Both screens ask the questions
   * and then hand the answer here, so the history and the branches screens cannot answer
   * `d` differently.
   */
  const openCompareBuffers = async (
    repo: string,
    sides: { a: string; b: string; aLabel: string; bLabel: string },
    choice: CompareChoice
  ): Promise<void> => {
    const plan = await planCompare(repo, choice, sides.a, sides.b, sides.aLabel, sides.bLabel);
    if (choiceShowsDiff(choice)) {
      await openCompareDoc(repo, plan.range, plan.diffLeft, plan.diffRight, plan.label);
      return;
    }
    notify(t('compare.noChanges', { range: plan.label }));
  };

  /**
   * One key of the branches screen, with the branch named instead of found under the
   * cursor. This is the buffer command: the same guards, the same questions and the
   * same notices, so the panel cannot drift from the text screen.
   */
  const runBranch = async (action: ScreenAction, repo: string, ids: readonly string[]): Promise<void> => {
    const entry = await branchFromIds(repo, ids);
    // `n` names a new branch and works with no row at all, `d` compares one row or two;
    // the rest act on the row under the cursor.
    if (action !== 'create' && action !== 'compare' && !entry) {
      notify(t('msg.cursorNotBranch'));
      return;
    }
    switch (action) {
      case 'checkout': {
        if (!entry) {
          return;
        }
        await checkoutBranch(repo, entry.name);
        await refreshScreens();
        await updateStatusBar();
        notify(t('msg.checkout', { name: entry.name }));
        return;
      }
      case 'create': {
        const from = entry?.name;
        const name = await vscode.window.showInputBox({
          prompt: t('prompt.branchFrom', { ref: from ?? 'HEAD' }),
          placeHolder: 'feature/x',
          ignoreFocusOut: true,
        });
        if (!name || !name.trim()) {
          return;
        }
        await createBranch(repo, name.trim(), from);
        await refreshScreens();
        await updateStatusBar();
        notify(t('msg.branchCreated', { name: name.trim() }));
        return;
      }
      case 'rename': {
        if (!entry) {
          return;
        }
        if (entry.isRemote) {
          refuse(t('msg.branchRenamedRemote'));
          return;
        }
        const name = await vscode.window.showInputBox({ prompt: t('prompt.branchRename'), value: entry.name, ignoreFocusOut: true });
        if (!name || !name.trim() || name.trim() === entry.name) {
          return;
        }
        await renameBranch(repo, entry.name, name.trim());
        await refreshScreens();
        notify(t('msg.branchRenamed', { name: name.trim() }));
        return;
      }
      case 'upstream': {
        if (!entry) {
          return;
        }
        const value = await vscode.window.showInputBox({
          prompt: t('prompt.upstream', { name: entry.name }),
          value: `origin/${entry.name}`,
          ignoreFocusOut: true,
        });
        if (!value || !value.trim()) {
          return;
        }
        await setUpstream(repo, entry.name, value.trim());
        await refreshScreens();
        notify(`Upstream: ${value.trim()}`);
        return;
      }
      case 'remove': {
        if (!entry) {
          return;
        }
        if (entry.current) {
          refuse(t('msg.branchDeleteCurrent'));
          return;
        }
        if (entry.isRemote) {
          notify(t('msg.branchDeleteRemoteHint'));
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          t('confirm.deleteBranch', { name: entry.name }),
          { modal: true },
          t('action.delete')
        );
        if (confirmed !== t('action.delete')) {
          return;
        }
        try {
          await deleteBranch(repo, entry.name, false);
        } catch {
          const forced = await vscode.window.showWarningMessage(
            t('msg.branchNotMerged', { name: entry.name }),
            { modal: true },
            t('msg.forceDelete')
          );
          if (forced !== t('msg.forceDelete')) {
            return;
          }
          await deleteBranch(repo, entry.name, true);
        }
        await refreshScreens();
        notify(t('msg.branchDeleted', { name: entry.name }));
        return;
      }
      case 'removeRemote': {
        if (!entry) {
          return;
        }
        const slash = entry.name.indexOf('/');
        const remote = entry.isRemote && slash > 0 ? entry.name.slice(0, slash) : await pickRemote(repo);
        const branch = entry.isRemote && slash > 0 ? entry.name.slice(slash + 1) : entry.name;
        if (!remote) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          t('confirm.deleteRemoteBranch', { name: entry.name }),
          { modal: true },
          t('action.delete')
        );
        if (confirmed !== t('action.delete')) {
          return;
        }
        await deleteRemoteBranch(repo, remote, branch);
        await refreshScreens();
        notify(t('msg.deleted'));
        return;
      }
      case 'merge': {
        if (!entry) {
          return;
        }
        if (entry.current) {
          notify(t('msg.branchMergeCurrent'));
          return;
        }
        try {
          await mergeRef(repo, entry.name);
          notify(t('msg.merged', { name: entry.name }));
        } catch (error) {
          throw error;
        }
        await refreshScreens();
        await updateStatusBar();
        return;
      }
      case 'reset': {
        if (!entry) {
          return;
        }
        const mode = await pickResetMode(t('reset.toBranch', { name: entry.name }));
        if (!mode || !(await confirmReset(mode))) {
          return;
        }
        await resetTo(repo, mode, entry.name);
        await refreshScreens();
        await updateStatusBar();
        notify(t('msg.resetDone', { mode, target: entry.name }));
        return;
      }
      case 'graph': {
        if (!entry) {
          return;
        }
        // `G` on a branch, from the branches screen or the status block: the history
        // screen's `branch` filter already reads `git log <branch>`, so the name is
        // handed there instead of copying the graph into a second view.
        await logWebview.showBranch(repo, entry.name);
        return;
      }
      case 'compare': {
        // `d`: one row is compared with HEAD, two rows with each other — the same two
        // sides the history screen compares, only named by branch instead of by commit.
        const branches = await branchesFromIds(repo, ids);
        if (branches.length === 0) {
          notify(t('compare.needRefs'));
          return;
        }
        const head = await headSha(repo);
        const left = await refTip(repo, branches[0].name);
        const right = branches[1] ? await refTip(repo, branches[1].name) : head;
        if (!left || !right) {
          notify(t('compare.needRefs'));
          return;
        }
        const rightLabel = branches[1] ? branches[1].name : 'HEAD';
        const picked = await pickCompare(branches[0].name, rightLabel);
        if (!picked) {
          return;
        }
        await openCompareBuffers(repo, { a: left, b: right, aLabel: branches[0].name, bLabel: rightLabel }, picked);
        return;
      }
      default:
        return;
    }
  };

  /**
   * One key of the tags screen, the same way: `enter` opens the tagged commit in the
   * commit buffer, `e` still confirms before moving a tag, `U`/`D` still pick a remote.
   */
  const runTag = async (action: ScreenAction, repo: string, ids: readonly string[]): Promise<void> => {
    const tag = await tagFromIds(repo, ids);
    if (action !== 'create' && !tag) {
      notify(t('msg.cursorNotTag'));
      return;
    }
    switch (action) {
      case 'show': {
        if (!tag) {
          return;
        }
        await openCommitView(repo, tag.name);
        return;
      }
      case 'create': {
        await createTagAt(repo);
        await refreshScreens();
        return;
      }
      case 'move': {
        if (!tag) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          t('confirm.moveTag', { name: tag.name }),
          { modal: true },
          t('action.move')
        );
        if (confirmed !== t('action.move')) {
          return;
        }
        await moveTag(repo, tag.name);
        await refreshScreens();
        notify(t('msg.updated'));
        return;
      }
      case 'push': {
        if (!tag) {
          return;
        }
        const remote = await pickRemote(repo);
        if (!remote) {
          return;
        }
        // Asked before the confirmation so the question can say what is about to be
        // overwritten — and so the push can lease against exactly that value.
        const onRemote = await remoteTag(repo, remote, tag.name);
        const moved = onRemote !== undefined && !onRemote.commit.startsWith(tag.sha);
        const confirmed = await vscode.window.showWarningMessage(
          moved
            ? t('confirm.pushTagMoved', {
                name: tag.name,
                remote,
                remoteSha: onRemote.commit.slice(0, 7),
                localSha: tag.sha,
              })
            : t('confirm.pushTag', { name: tag.name, remote }),
          { modal: true },
          t('action.push')
        );
        if (confirmed !== t('action.push')) {
          return;
        }
        await pushTag(repo, remote, tag.name);
        await refreshScreens();
        notify(t('msg.tagPushed', { name: tag.name, remote }));
        return;
      }
      case 'remove': {
        if (!tag) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          t('confirm.deleteTag', { name: tag.name }),
          { modal: true },
          t('action.delete')
        );
        if (confirmed !== t('action.delete')) {
          return;
        }
        await deleteTag(repo, tag.name);
        await refreshScreens();
        notify(t('msg.deleted'));
        return;
      }
      case 'removeRemote': {
        if (!tag) {
          return;
        }
        const remote = await pickRemote(repo);
        if (!remote) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          t('confirm.deleteRemoteTag', { name: tag.name, remote }),
          { modal: true },
          t('action.delete')
        );
        if (confirmed !== t('action.delete')) {
          return;
        }
        await deleteRemoteTag(repo, remote, tag.name);
        await refreshScreens();
        notify(t('msg.tagDeletedRemote', { name: tag.name, remote }));
        return;
      }
      default:
        return;
    }
  };

  /** The commit a panel row names, looked up again in the repository. */
  const commitFromIds = async (repo: string, ids: readonly string[]): Promise<LogCommit | undefined> => {
    const id = ids[0];
    const sha = id?.startsWith('commit:') ? id.slice('commit:'.length) : undefined;
    return sha ? commitBySha(repo, sha) : undefined;
  };

  /**
   * One key of the history screen, with the commits named instead of found under the
   * cursor. This is the buffer command: the same guards, the same questions and the same
   * notices, so the panel cannot drift from the text screen.
   *
   * The keys that only change what the screen shows (`a`, `s`, `x`, and the filters) are
   * not here: each reading of the history keeps its own, which is why the buffer's `a`
   * and the panel's `a` do not fight over one flag.
   */
  const runLog = async (action: ScreenAction, repo: string, ids: readonly string[]): Promise<void> => {
    const commit = await commitFromIds(repo, ids);
    if (action !== 'compare' && !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    if (!commit) {
      return;
    }
    /** The status screen after a history action: every command ends the same way. */
    const afterChange = async (): Promise<void> => {
      await updateStatusBar();
    };

    switch (action) {
      case 'show': {
        await openCommitView(repo, commit.sha);
        return;
      }
      case 'create': {
        const name = await vscode.window.showInputBox({
          prompt: t('prompt.branchFrom', { ref: commit.shortSha }),
          placeHolder: 'feature/x',
          ignoreFocusOut: true,
        });
        if (!name || !name.trim()) {
          return;
        }
        const branch = name.trim();
        await createBranch(repo, branch, commit.sha);
        await afterChange();
        notify(t('msg.branchCreated', { name: branch }));
        return;
      }
      case 'tag': {
        await createTagAt(repo, { ref: commit.sha, shortSha: commit.shortSha });
        // The graph prints the refs of each row, so the new tag appears on it.
        await afterChange();
        return;
      }
      case 'checkout': {
        const refs = checkoutableRefs(commit.refs);
        if (refs.length === 0) {
          // A commit that no branch points at is still a commit: `c` checks it out in
          // detached HEAD, which is what the row names. The old answer was a notice
          // about the branches screen even though the reader asked for this commit.
          await checkoutBranch(repo, commit.sha);
          await afterChange();
          notify(t('msg.checkoutDetached', { name: commit.shortSha }));
          return;
        }
        const target = refs.length === 1 ? refs[0] : await vscode.window.showQuickPick(refs, { placeHolder: t('branch.pick') });
        if (!target) {
          return;
        }
        await checkoutBranch(repo, target);
        await afterChange();
        notify(t('msg.checkout', { name: target }));
        return;
      }
      case 'cherryPick': {
        await cherryPick(repo, commit.sha);
        await afterChange();
        notify(`Cherry-pick ${commit.shortSha}`);
        return;
      }
      case 'revert': {
        // A revert is a new commit: quote what is being undone before doing it.
        // A merge commit has no single inverse, so git needs the mainline parent.
        let mainline: number | undefined;
        if (commit.parents.length > 1) {
          const picked = await vscode.window.showQuickPick(
            commit.parents.map((parent, index) => ({
              label: `-m ${index + 1}  ${parent.slice(0, 7)}`,
              description: index === 0 ? t('revert.firstParent') : t('revert.otherParent'),
              value: index + 1,
            })),
            { placeHolder: t('revert.pickMainline', { sha: commit.shortSha }) }
          );
          if (!picked) {
            return;
          }
          mainline = picked.value;
        }
        const confirmed = await vscode.window.showWarningMessage(
          t('confirm.revert', { sha: commit.shortSha, subject: commit.subject }),
          { modal: true },
          t('action.revert')
        );
        if (!confirmed) {
          return;
        }
        try {
          await revertCommit(repo, commit.sha, mainline);
        } catch (error) {
          // A conflict leaves the revert half-done: show the files, keep the error.
          await afterChange();
          throw error;
        }
        await afterChange();
        notify(t('msg.reverted', { sha: commit.shortSha }));
        return;
      }
      case 'fixup': {
        if (!(await hasStagedChanges(repo))) {
          warn(t('msg.noStaged'));
          return;
        }
        await createFixupCommit(repo, commit.sha);
        notify(t('msg.updated'));
        const base = await parentOf(repo, commit.sha);
        try {
          const result = await runInteractiveRebase({
            repoPath: repo,
            base,
            extraArgs: ['--autosquash'],
            shimsDir: shimsDir(),
            onEdit: async (request) => {
              const name = path.basename(request.path);
              const uri = editable.createUri(
                name.includes('git-rebase-todo') ? 'rebase-todo' : 'commit-message',
                repo
              );
              const edited = await editable.edit(uri, request.content);
              await closeIfActive(uri);
              return edited;
            },
          });
          if (result.code !== 0) {
            throw new Error(result.stderr.trim() || `git rebase exited ${result.code}`);
          }
        } catch (error) {
          if (error instanceof RebaseAbortedError) {
            notify(t('msg.commitCanceled'));
            await afterChange();
            return;
          }
          throw error;
        }
        await afterChange();
        void vscode.window.showInformationMessage(t('msg.committed'));
        return;
      }
      case 'reset': {
        const mode = await pickResetMode(t('reset.toCommit', { sha: commit.shortSha }));
        if (!mode || !(await confirmReset(mode))) {
          return;
        }
        await resetTo(repo, mode, commit.sha);
        await afterChange();
        notify(t('msg.resetDone', { mode, target: commit.shortSha }));
        return;
      }
      case 'compare': {
        // One row compares the commit with HEAD, two rows compare with each other.
        const commits = (
          await Promise.all(ids.map((id) => commitFromIds(repo, [id])))
        ).filter((entry): entry is LogCommit => entry !== undefined);
        if (commits.length === 0) {
          notify(t('compare.needCommits'));
          return;
        }
        const head = await headSha(repo);
        const left = commits[0].sha;
        const right = commits.length > 1 ? commits[1].sha : head;
        const rightLabel = commits.length > 1 ? commits[1].shortSha : 'HEAD';
        const picked = await pickCompare(commits[0].shortSha, rightLabel);
        if (!picked) {
          return;
        }
        await openCompareBuffers(
          repo,
          { a: left, b: right, aLabel: commits[0].shortSha, bLabel: rightLabel },
          picked
        );
        return;
      }
      default:
        return;
    }
  };

  // `n` in the branches buffer works from HEAD too, so it needs the repository rather
  // than a row: the branch under the cursor is the starting point when there is one.
  // `shift+r` and `r` are the buffer's own display state, so they stay here: the
  // panel keeps the same two keys and redraws itself instead.
  // `/` is navigation, not a second filter UI: the filter rows live in the
  // buffer header and are edited in place, so `/` just jumps to them.
  register('githelm.file.actions', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      warn(t('msg.notFile'));
      return;
    }
    const repo = await findRepoRoot(path.dirname(editor.document.uri.fsPath));
    if (!repo) {
      warn(t('msg.notFile'));
      return;
    }
    const relative = repoRelativePath(repo, editor.document.uri.fsPath);
    const picked = await vscode.window.showQuickPick(
      [
        { label: t('fileHistory.log'), description: 'git log --follow', value: 'log' },
        { label: 'Blame', description: 'git blame', value: 'blame' },
      ],
      { placeHolder: relative }
    );
    if (!picked) {
      return;
    }
    if (picked.value === 'log') {
      // The history screen, scoped to the file: one screen for a path and for a branch.
      await logWebview.showPath(repo, relative);
      return;
    }
    await openFileHistory('blame', repo, relative);
  });

  // ---------- remotes / sync ----------

  const pickRemote = async (repoPath: string): Promise<string | undefined> => {
    const remotes = await listRemotes(repoPath);
    if (remotes.length === 0) {
      warn(t('msg.noRepo'));
      return undefined;
    }
    if (remotes.length === 1) {
      return remotes[0].name;
    }
    const picked = await vscode.window.showQuickPick(
      remotes.map((remote) => ({ label: remote.name, description: remote.url })),
      { placeHolder: t('remote.pick') }
    );
    return picked?.label;
  };

  const multiPick = async (title: string, items: { label: string; value: string }[]): Promise<Set<string>> => {
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({ label: item.label, value: item.value })),
      { placeHolder: title, canPickMany: true }
    );
    return new Set((picked ?? []).map((item) => item.value));
  };

  /** `target` is the remote of a selected row: the picker is not asked again. */
  const runFetch = async (repo: string, target?: string): Promise<void> => {
    const remote = target ?? (await pickRemote(repo));
    if (!remote) {
      return;
    }
    const flags = await multiPick(t('fetch.options'), [
      { label: t('fetch.prune'), value: 'prune' },
      { label: t('fetch.tags'), value: 'tags' },
    ]);
    await fetchRemote(
      repo,
      remote,
      { prune: flags.has('prune'), tags: flags.has('tags') },
      (update) => showProgress(t('progress.fetch'), update)
    );
    await updateStatusBar();
    notify(t('msg.fetched'));
  };

  const runPull = async (repo: string, target?: string): Promise<void> => {
    const remote = target ?? (await pickRemote(repo));
    if (!remote) {
      return;
    }
    const flags = await multiPick(t('pull.options'), [
      { label: t('pull.rebase'), value: 'rebase' },
      { label: t('pull.ffOnly'), value: 'ffOnly' },
    ]);
    await pullRemote(
      repo,
      remote,
      { rebase: flags.has('rebase'), ffOnly: flags.has('ffOnly') },
      (update) => showProgress(t('progress.pull'), update)
    );
    await updateStatusBar();
    notify(t('msg.pulled'));
  };

  const runPush = async (repo: string, target?: string): Promise<void> => {
    const remote = target ?? (await pickRemote(repo));
    if (!remote) {
      return;
    }
    const flags = await multiPick(t('push.options'), [
      { label: t('push.force'), value: 'force' },
      { label: t('push.forceHard'), value: 'forceHard' },
      { label: t('push.tags'), value: 'tags' },
      { label: t('push.setUpstream'), value: 'setUpstream' },
    ]);
    if (flags.has('forceHard')) {
      // The docs are blunt about it: a hard force can lose whatever is on the
      // remote, so it is the one push that asks first.
      const confirmed = await vscode.window.showWarningMessage(
        t('confirm.forcePush', { remote }),
        { modal: true },
        t('action.forcePush')
      );
      if (confirmed !== t('action.forcePush')) {
        return;
      }
    }
    const branchResult = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
    await pushRemote(repo, remote, branch, {
      force: flags.has('force'),
      forceHard: flags.has('forceHard'),
      tags: flags.has('tags'),
      setUpstream: flags.has('setUpstream'),
    });
    await updateStatusBar();
    notify(t('msg.pushed'));
  };

  /**
   * The one reset question: the mode picker carries the target in its prompt — `Reset to
   * HEAD`, `Reset to main`, `Reset to commit 9a7e4eb` — so the mode is the only choice,
   * as a branch asks for its name in one box. The hard-reset confirmation stays after it.
   */
  const pickResetMode = async (prompt: string): Promise<ResetMode | undefined> => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: t('reset.soft'), value: 'soft' as ResetMode },
        { label: t('reset.mixed'), value: 'mixed' as ResetMode },
        { label: t('reset.hard'), value: 'hard' as ResetMode },
      ],
      { placeHolder: prompt }
    );
    return picked?.value;
  };

  const confirmReset = async (mode: ResetMode): Promise<boolean> => {
    if (mode !== 'hard') {
      return true;
    }
    const confirmed = await vscode.window.showWarningMessage(t('confirm.resetHard'), { modal: true }, t('action.reset'));
    return confirmed === t('action.reset');
  };

  const runReset = async (repo: string): Promise<void> => {
    const target = 'HEAD';
    const mode = await pickResetMode(t('reset.toHead'));
    if (!mode || !(await confirmReset(mode))) {
      return;
    }
    await resetTo(repo, mode, target);
    await updateStatusBar();
    notify(t('msg.resetDone', { mode, target }));
  };

  const runAbort = async (repo: string): Promise<void> => {
    const pending = await pendingOperation(repo);
    if (!pending) {
      notify(t('msg.noMerge'));
      return;
    }
    // Aborting throws away the resolutions of the conflicts in progress, so it
    // is asked before it happens — the `M` key is easy to hit by accident.
    const confirmed = await vscode.window.showWarningMessage(
      t('confirm.abortOperation'),
      { modal: true },
      t('action.discard')
    );
    if (confirmed !== t('action.discard')) {
      return;
    }
    const aborted = await abortPendingOperation(repo);
    if (!aborted) {
      notify(t('msg.noMerge'));
      return;
    }
    await updateStatusBar();
    notify(aborted === 'merge' ? t('msg.mergeAborted') : t('msg.opAborted', { kind: aborted }));
  };

  /** The submodule screen, re-read where it is shown. */
  const refreshSubmodules = (): Promise<void> => refreshScreens();

  /**
   * Opens a repository's status screen in the mode the user chose. The buffers have one
   * status screen per repository; the panel follows the screen it drives, so the same
   * call from a submodule row lands in the panel when the panel is the UI in use.
   */
  const openRepoStatus = async (repoPath: string): Promise<void> => {
    await statusWebview.show(repoPath);
  };

  /**
   * The submodules screen's keys, once for both UIs. The row is looked up in the
   * repository again rather than trusted from the message, so a submodule removed in
   * another window reports "Cursor is not on a submodule" instead of acting on nothing.
   */
  const runSubmodule = async (action: ScreenAction, repoPath: string, ids: readonly string[]): Promise<void> => {
    // `r` and `q` are the screen's own: the host re-reads or closes it, nothing to do here.
    if (action === 'refresh' || action === 'close') {
      return;
    }
    const wanted = ids
      .filter((id) => id.startsWith('submodule:'))
      .map((id) => id.slice('submodule:'.length))
      .slice(0, 1);
    const pathUnderRow = wanted[0];
    if (!pathUnderRow) {
      notify(t('msg.cursorNotSubmodule'));
      return;
    }
    const { submodules } = await readSubmoduleStatus(repoPath);
    const sub = submodules.find((candidate) => candidate.path === pathUnderRow);
    if (!sub) {
      notify(t('msg.cursorNotSubmodule'));
      return;
    }
    if (action === 'open') {
      if (sub.state === 'uninitialized') {
        notify(t('msg.submoduleNotInitialized', { path: sub.path }));
        return;
      }
      // A checked-out submodule is a repository of its own, so it gets its own status
      // screen — that is where its changes are actually staged or discarded.
      await openRepoStatus(path.join(repoPath, sub.path));
      return;
    }
    await updateSubmodule(repoPath, sub.path, action === 'updateRemote' ? { init: true, remote: true } : { init: true });
    await refreshSubmodules();
    await updateStatusBar();
    notify(t('msg.submoduleUpdated', { path: sub.path }));
  };

  register('githelm.submodules.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await submodulesWebview.show(repo);
  });

  // ---------- forge (GitHub / GitLab API) ----------

  const forgeKind = (): ForgeKind | undefined => {
    const configured = vscode.workspace.getConfiguration('githelm.forge').get<string>('kind', 'auto');
    return configured === 'github' || configured === 'gitlab' ? configured : undefined;
  };

  const forgeToken = (kind: ForgeKind): string | undefined => {
    const configured = vscode.workspace
      .getConfiguration('githelm.forge')
      .get<string>(kind === 'github' ? 'githubToken' : 'gitlabToken', '')
      .trim();
    if (configured.length > 0) {
      return configured;
    }
    const fromEnv = kind === 'github' ? process.env.GITHUB_TOKEN : process.env.GITLAB_TOKEN;
    return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
  };

  const forgeRemoteFor = async (repoPath: string): Promise<ForgeRemote | undefined> => {
    const remotes = await listRemotes(repoPath);
    const origin = remotes.find((entry) => entry.name === 'origin') ?? remotes[0];
    return origin ? parseForgeRemote(origin.url, forgeKind()) : undefined;
  };

  /** Where a new request should land: whatever origin/HEAD points at. */
  const defaultBase = async (repoPath: string): Promise<string> => {
    const result = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = result.code === 0 ? result.stdout.trim() : '';
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : 'main';
  };

  const openNewPull = async (knownRepo?: string): Promise<void> => {
    const repo = knownRepo ?? (await resolveRepo());
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    const remote = await forgeRemoteFor(repo);
    if (!remote) {
      warn(t('msg.forgeNoRemote'));
      return;
    }
    const status = await readStatus(repo);
    if (!status.branch) {
      warn(t('msg.forgeDetached'));
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(newPullUrl(remote, status.branch, await defaultBase(repo))));
  };

  register('githelm.forge.createPull', () => openNewPull());

  const runPulls = async (repo: string): Promise<void> => {
    const remote = await forgeRemoteFor(repo);
    if (!remote) {
      warn(t('msg.forgeNoRemote'));
      return;
    }
    const token = forgeToken(remote.kind);
    if (!token) {
      const settings = t('action.openSettings');
      const choice = await vscode.window.showWarningMessage(
        t('msg.forgeNoToken', { kind: remote.kind, env: remote.kind === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN' }),
        settings
      );
      if (choice === settings) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'githelm.forge');
      }
      return;
    }

    let items: ForgeItem[];
    try {
      items = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('forge.fetching') },
        () => fetchForgeItems(remote, token)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(t('msg.forgeFailed', { kind: remote.kind, message }));
      return;
    }

    type Pick = vscode.QuickPickItem & { url?: string; create?: boolean };
    const createLabel = remote.kind === 'github' ? t('forge.createPull') : t('forge.createMerge');
    const picks: Pick[] = [
      { label: `$(plus) ${createLabel}`, create: true },
      ...items.map((item) => ({
        label: `#${item.number}  ${item.title}${item.draft ? `  (${t('forge.draft')})` : ''}`,
        description: t('forge.itemDescription', { author: item.author, source: item.source, target: item.target }),
        url: item.url,
      })),
    ];
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: t('forge.pickPlaceholder', { count: items.length }),
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    if (picked.create) {
      await openNewPull(repo);
      return;
    }
    if (picked.url) {
      await vscode.env.openExternal(vscode.Uri.parse(picked.url));
    }
  };

  /** The repository-wide keys, implemented once for the buffer and the panel. */
  const runRepo = async (action: RepoAction, repo: string): Promise<void> => {
    switch (action) {
      case 'amend':
        return runAmend(repo);
      case 'fetch':
        return runFetch(repo);
      case 'pull':
        return runPull(repo);
      case 'push':
        return runPush(repo);
      case 'reset':
        return runReset(repo);
      case 'abort':
        return runAbort(repo);
      case 'pulls':
        return runPulls(repo);
      case 'remoteAdd':
        return runRemoteAdd(repo);
      case 'worktreeAdd':
        return runWorktreeAdd(repo);
      case 'worktreePrune':
        return runWorktreePrune(repo);
      default:
        return;
    }
  };

  /**
   * The row the panel had selected, looked up again: an id that no longer exists
   * must not act on a stale remote or worktree.
   */
  const resolvePanelTarget = async (repo: string, target: PanelTarget): Promise<StatusTarget | undefined> => {
    if (target.kind === 'remote') {
      const found = (await listRemotes(repo)).find((entry) => entry.name === target.value);
      return found ? { kind: 'remote', section: 'remotes', name: found.name, url: found.url } : undefined;
    }
    if (target.kind === 'worktree') {
      const found = (await listWorktrees(repo)).find((entry) => samePath(entry.path, target.value));
      return found
        ? {
            kind: 'worktree',
            section: 'worktrees',
            path: found.path,
            current: samePath(found.path, repo),
            prunable: found.prunable,
          }
        : undefined;
    }
    return { kind: 'stash', section: 'stash', ref: target.value, subject: '' };
  };

  /** The panel's half of the row commands: it names a row, the host acts on it. */
  const runTarget = async (action: TargetAction, repo: string, target: PanelTarget): Promise<void> => {
    if (action === 'fetch' || action === 'pull' || action === 'push') {
      // A remote row names the remote, so the picker is not asked again. Any other
      // row leaves the key with the buffer's meaning: the repository's own remote,
      // asked for.
      if (target.kind !== 'remote') {
        return runRepo(action, repo);
      }
      if (action === 'fetch') {
        await runFetch(repo, target.value);
      } else if (action === 'pull') {
        await runPull(repo, target.value);
      } else {
        await runPush(repo, target.value);
      }
      return;
    }

    const resolved = await resolvePanelTarget(repo, target);
    if (!resolved) {
      notify(t('msg.cursorNotEntry'));
      return;
    }

    switch (action) {
      case 'open':
        return runOpenTarget(repo, resolved);
      case 'diff':
        if (resolved.kind !== 'stash') {
          notify(t('msg.forFiles'));
          return;
        }
        return runStashDiff(repo, resolved.ref);
      case 'delete':
        return runDeleteTarget(repo, resolved);
      case 'edit':
        return runEditTarget(repo, resolved);
      case 'stashApply':
        if (resolved.kind !== 'stash') {
          notify(t('msg.cursorNotEntry'));
          return;
        }
        return runStashApply(repo, resolved.ref);
      case 'stashPop':
        if (resolved.kind !== 'stash') {
          notify(t('msg.cursorNotEntry'));
          return;
        }
        return runStashPop(repo, resolved.ref);
      case 'worktreeWindow':
        if (resolved.kind !== 'worktree') {
          // Not a worktree: the opening keys keep their meaning, as in the buffer.
          return runOpenTarget(repo, resolved);
        }
        return runWorktreeWindow(resolved);
      case 'worktreeHere':
        if (resolved.kind !== 'worktree') {
          return runOpenTarget(repo, resolved);
        }
        return runWorktreeHere(resolved);
      default:
        return;
    }
  };

  // ---------- tags screen ----------

  register('githelm.tags.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await tagsWebview.show(repo);
    await updateStatusBar();
  });

  register('githelm.language', async () => {
    const picked = await vscode.window.showQuickPick(
      LANGUAGES.map((language) => ({ label: language.label, value: language.id })),
      { placeHolder: t('msg.languageChanged', { language: getLanguage() }) }
    );
    if (!picked) {
      return;
    }
    setLanguage(picked.value as Language);
    await context.globalState.update('githelm.language', picked.value);
    notify(t('msg.languageChanged', { language: picked.label }));
  });

  /**
   * `c` on the action log, once for both UIs: the same modal question, the same emptied
   * log. The screen it runs from re-reads itself afterwards, and the buffer is re-read
   * here because a command can arrive while the buffer is the visible host.
   */
  const runClearActionLog = async (): Promise<void> => {
    const confirmed = await vscode.window.showWarningMessage(
      t('confirm.clearLog'),
      { modal: true },
      t('action.delete')
    );
    if (confirmed !== t('action.delete')) {
      return;
    }
    clearActions();
    notify(t('actionLog.empty'));
  };

  register('githelm.actionLog', async () => {
    // The log is not a screen of a repository, so the panel is opened with the empty
    // path: `repoIfVisible()` then reports nothing and no command acts on a repo the
    // log does not have.
    await actionLogWebview.show('');
  });

  // d compares the selected rows: one row against HEAD, two rows with each other.
  /**
   * The rows a cursor or a drag covers, 1-based: every line of every selection. `filesOf`
   * turns them into files, so a selection that walks across the metadata diffs the files
   * in it and a selection of the `## files` header diffs all of them.
   */
  const selectedLines = (editor: vscode.TextEditor): number[] => {
    const lines = new Set<number>();
    for (const selection of editor.selections) {
      for (let line = selection.start.line; line <= selection.end.line; line++) {
        lines.add(line + 1);
      }
    }
    return [...lines].sort((left, right) => left - right);
  };

  /**
   * `d` on a stash's file list: the files as the stash left them, against the commit the
   * stash was made on. That pair is exactly `git stash show -p -- <path>`, read in the
   * editor's own diff instead of a generated patch — one multi-diff tab for the whole
   * selection.
   */
  const openStashFileDiffs = async (uri: vscode.Uri, rows: readonly number[]): Promise<void> => {
    const state = stashDoc.stateFor(uri);
    const files = filesOf(stashDoc.fileListOf(uri), rows);
    if (!state || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    await openRevisionDiffs(state.repoPath, files, `${state.ref}^`, state.ref, state.ref);
  };

  /**
   * `d` on a compare's file list: one selected file or the whole header, as the two
   * revisions the compare named them. The plan already resolved `...` to its merge base
   * for `diffLeft`, so the document and this opener cannot disagree about the sides.
   */
  const openCompareFileDiffs = async (uri: vscode.Uri, rows: readonly number[]): Promise<void> => {
    const state = compareDoc.stateFor(uri);
    const files = filesOf(compareDoc.fileListOf(uri), rows);
    if (!state || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    await openRevisionDiffs(state.repoPath, files, state.leftRef, state.rightRef, state.label);
  };

  register('githelm.stash.fileDiff', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await openStashFileDiffs(editor.document.uri, selectedLines(editor));
    }
  });

  /**
   * `t` on a stash's file list: the files as they were inside the stash. A tracked file
   * lives in the stash commit, a file stashed with `-u` in its third parent, and a file
   * the stash deleted in neither — the same read-only `git:` tabs the commit screen opens,
   * grouped by the revision each file actually lives under.
   */
  const openStashFilesAtRef = async (uri: vscode.Uri, rows: readonly number[]): Promise<void> => {
    const state = stashDoc.stateFor(uri);
    const files = filesOf(stashDoc.fileListOf(uri), rows);
    if (!state || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    const refs = await stashRefsForFiles(state.repoPath, state.ref, files);
    const byRef = new Map<string, string[]>();
    const missing: string[] = [];
    for (const file of files) {
      const revision = refs.get(file);
      if (!revision) {
        missing.push(file);
        continue;
      }
      byRef.set(revision, [...(byRef.get(revision) ?? []), file]);
    }
    for (const [revision, list] of byRef) {
      await openFilesAtRef(state.repoPath, list, revision);
    }
    if (missing.length > 0) {
      notify(t('msg.stashNoFile', { count: missing.length }));
    }
  };

  register('githelm.stash.filesAtRef', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await openStashFilesAtRef(editor.document.uri, selectedLines(editor));
    }
  });

  /**
   * `d` on a commit's file list: the files as the commit left them, against its first
   * parent. A root commit has no parent to compare with, so the files at the commit are
   * opened on their own — there is no "before" to show.
   */
  const openCommitFileDiffs = async (uri: vscode.Uri, rows: readonly number[]): Promise<void> => {
    const state = commitDoc.stateFor(uri);
    const files = filesOf(commitDoc.fileListOf(uri), rows);
    if (!state || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    const parent = await firstParent(state.repoPath, state.sha);
    if (!parent) {
      await openFilesAtRef(state.repoPath, files, state.sha);
      return;
    }
    await openRevisionDiffs(state.repoPath, files, parent, state.sha, state.sha.slice(0, 8));
  };

  register('githelm.commit.fileDiff', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await openCommitFileDiffs(editor.document.uri, selectedLines(editor));
    }
  });

  /**
   * `t` on a commit's file list: the same files, but as the commit left them, each in a tab
   * of its own instead of a diff. A commit is a state, not only a change, and there is no
   * other way to read a file at an old revision without checking that revision out — that
   * is what `git show <sha>:<path>` gives the blame and the root-commit case already.
   */
  const openCommitFilesAtRef = async (uri: vscode.Uri, rows: readonly number[]): Promise<void> => {
    const state = commitDoc.stateFor(uri);
    const files = filesOf(commitDoc.fileListOf(uri), rows);
    if (!state || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    await openFilesAtRef(state.repoPath, files, state.sha);
  };

  register('githelm.commit.filesAtRef', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await openCommitFilesAtRef(editor.document.uri, selectedLines(editor));
    }
  });

  /**
   * The conflict keys, addressed by the document instead of the active editor: the
   * buffer passes its own URI, the panel the one it draws.
   */
  const takeConflictSide = async (uri: vscode.Uri, side: 'ours' | 'theirs' | 'base'): Promise<void> => {
    const state = conflictDoc.stateFor(uri);
    if (!state) {
      warn(t('msg.notStatus'));
      return;
    }
    await takeSide(state.repoPath, state.relativePath, side);
    await conflictDoc.reload(uri);
    notify(t('msg.updated'));
  };

  /** `s`: mark the file resolved, the same for both UIs. */
  const resolveConflict = async (uri: vscode.Uri): Promise<void> => {
    const state = conflictDoc.stateFor(uri);
    if (!state) {
      warn(t('msg.notStatus'));
      return;
    }
    await markResolved(state.repoPath, state.relativePath);
    await updateStatusBar();
    notify(t('msg.conflictResolved'));
  };

  /** `m`: VS Code's own three-way editor, falling back to the file itself. */
  const openMergeEditor = async (uri: vscode.Uri): Promise<void> => {
    const state = conflictDoc.stateFor(uri);
    if (!state) {
      warn(t('msg.notStatus'));
      return;
    }
    const file = vscode.Uri.file(path.join(state.repoPath, state.relativePath));
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', file);
    } catch {
      await vscode.window.showTextDocument(file, { preview: false });
    }
  };

  const activeConflictUri = (): vscode.Uri | undefined => vscode.window.activeTextEditor?.document.uri;

  register('githelm.conflict.ours', async () => {
    const uri = activeConflictUri();
    if (uri) {
      await takeConflictSide(uri, 'ours');
    }
  });
  register('githelm.conflict.theirs', async () => {
    const uri = activeConflictUri();
    if (uri) {
      await takeConflictSide(uri, 'theirs');
    }
  });
  register('githelm.conflict.base', async () => {
    const uri = activeConflictUri();
    if (uri) {
      await takeConflictSide(uri, 'base');
    }
  });

  register('githelm.conflict.resolve', async () => {
    const uri = activeConflictUri();
    if (uri) {
      await resolveConflict(uri);
    }
  });

  register('githelm.conflict.mergeEditor', async () => {
    const uri = activeConflictUri();
    if (uri) {
      await openMergeEditor(uri);
    }
  });
  // The two arrows of the diff editor's own toolbar. Which of them is greyed out is the
  // context keys' answer, so a press that arrives anyway says why instead of doing nothing.
  register('githelm.diff.walkPrev', () => diffWalk.run('older'));
  register('githelm.diff.walkNext', () => diffWalk.run('newer'));

  // A blame is the one `githelm:` document a window reload restores: its text lives in
  // memory only, so it is rebuilt from the URI the tab was reopened with.
  const restoreBlameTabs = async (): Promise<void> => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== SCHEME) {
        continue;
      }
      try {
        await historyDoc.restore(document.uri);
      } catch (error) {
        // Restoring a tab of the last session happens once, at start-up: a failure here
        // leaves an empty editor with no explanation, so it gets the usual treatment.
        fail(error);
      }
    }
  };
  void restoreBlameTabs();


  syncContext();
  void diffWalk.sync();
  void updateStatusBar();
  output.appendLine('Git Helm ready.');
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}
