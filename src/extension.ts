import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { EditableDocuments, EDIT_SCHEME } from './fs/editableDocs';
import { getLanguage, isLanguage, Language, LANGUAGES, setLanguage, t } from './i18n';
import { cherryPick, checkoutBranch, createBranch, deleteBranch, renameBranch, setUpstream } from './git/actions';
import { buildCommitTemplate, cleanCommitMessage } from './git/commitMessage';
import { DiffMode, diffPosition } from './git/diff';
import { git } from './git/exec';
import { repoRelativePath } from './git/fileHistory';
import { addToGitignore } from './git/ignore';
import { compareDiff, compareRange, headSha } from './git/compare';
import { markResolved, takeSide } from './git/conflicts';
import { checkoutableRefs, LogFilter } from './git/log';
import { addRemote, listRemotes, readUpstream, removeRemote, setRemoteUrl } from './git/remotes';
import {
  abortPendingOperation,
  deleteRemoteBranch,
  discardPaths,
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
import { addIntentToAdd, PatchApplyError, stageFiles, unstageFiles } from './git/stage';
import { applyStash, dropStash, planStash, popStash, pushStash, showStash, stashFileDiff, StashOptions } from './git/stash';
import { entriesOf, readStatus } from './git/status';
import { createTag, deleteRemoteTag, deleteTag, moveTag, pushTag, remoteTag } from './git/tags';
import { addWorktree, isLinkedWorktree, pruneWorktrees, removeWorktree } from './git/worktree';
import type { Submodule } from './git/submodules';
import { updateSubmodule } from './git/submodules';
import { fetchForgeItems, ForgeItem, newPullUrl } from './forge/api';
import { ForgeKind, ForgeRemote, parseForgeRemote } from './forge/remote';
import { runInteractiveRebase, RebaseAbortedError } from './rebase/bridge';
import { createReporter } from './util/notifier';
import { ActionLogBuffer } from './views/actionLogBuffer';
import { CompareBuffer } from './views/compareBuffer';
import { ConflictBuffer } from './views/conflictBuffer';
import { StashBuffer } from './views/stashBuffer';
import { BranchesBuffer } from './views/branchesBuffer';
import { setHintColumn } from './views/columns';
import { planDiscard } from './views/discardPlan';
import { CommitBuffer } from './views/commitBuffer';
import { DiffBuffer, formatError } from './views/diffBuffer';
import { FileHistoryBuffer } from './views/fileHistoryBuffer';
import { HelpBuffer } from './views/helpBuffer';
import { Highlighter } from './views/highlight';
import { filterHint, LogBuffer } from './views/logBuffer';
import { StatusBuffer } from './views/statusBuffer';
import { SubmodulesBuffer } from './views/submodulesBuffer';
import { TagsBuffer } from './views/tagsBuffer';
import type { MessageKey } from './i18n';
import type { StatusTarget } from './views/statusBuffer';
import type { ResolvedTargets } from './views/statusRender';
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
  const statusBuffer = new StatusBuffer(docs, highlighter);
  const diffBuffer = new DiffBuffer(docs, highlighter);
  const logBuffer = new LogBuffer(docs, highlighter);
  const commitBuffer = new CommitBuffer(docs, highlighter);
  const branchesBuffer = new BranchesBuffer(docs, highlighter);
  const tagsBuffer = new TagsBuffer(docs, highlighter);
  const submodulesBuffer = new SubmodulesBuffer(docs, highlighter);
  const fileHistoryBuffer = new FileHistoryBuffer(docs);
  const helpBuffer = new HelpBuffer(docs, highlighter);
  const actionLogBuffer = new ActionLogBuffer(docs, highlighter);
  const compareBuffer = new CompareBuffer(docs, highlighter);
  const stashBuffer = new StashBuffer(docs, highlighter);
  const conflictBuffer = new ConflictBuffer(docs, highlighter);
  setHintColumn(vscode.workspace.getConfiguration('githelm').get<number>('ui.hintColumn', 100));

  context.subscriptions.push(
    output,
    docs,
    editable,
    highlighter,
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

  const guarded =
    (handler: () => Promise<void>, progress?: { spin: string; done?: string }) =>
    async (): Promise<void> => {
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
      }
    };

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
    if (uri.path.startsWith('/help/')) {
      return 'help';
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
      const fromStatus = statusBuffer.repoForUri(editor.document.uri);
      if (fromStatus) {
        return fromStatus;
      }
      const fromDiff = diffBuffer.repoForUri(editor.document.uri);
      if (fromDiff) {
        return fromDiff;
      }
      const fromLog = logBuffer.repoForUri(editor.document.uri);
      if (fromLog) {
        return fromLog;
      }
      const fromBranches = branchesBuffer.repoForUri(editor.document.uri);
      if (fromBranches) {
        return fromBranches;
      }
      const fromTags = tagsBuffer.repoForUri(editor.document.uri);
      if (fromTags) {
        return fromTags;
      }
      const fromSubmodules = submodulesBuffer.repoForUri(editor.document.uri);
      if (fromSubmodules) {
        return fromSubmodules;
      }
      if (editor.document.uri.scheme === 'file') {
        const root = await findRepoRoot(path.dirname(editor.document.uri.fsPath));
        if (root) {
          return root;
        }
      }
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
    if (editor) {
      const fromStatus = statusBuffer.folderForUri(editor.document.uri);
      if (fromStatus) {
        return fromStatus;
      }
      if (editor.document.uri.scheme === 'file') {
        const owner = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        return owner ? owner.uri.fsPath : path.dirname(editor.document.uri.fsPath);
      }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  };

  /** Runs `git init` and repaints every status buffer so it becomes the real screen. */
  const initRepo = async (folderPath: string): Promise<void> => {
    const root = await initRepository(folderPath);
    const opened = vscode.window.visibleTextEditors.some((editor) => statusBuffer.stateFor(editor.document.uri));
    await statusBuffer.refreshAll();
    await updateStatusBar();
    if (!opened) {
      await statusBuffer.open(root);
    }
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

  const statusEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      warn(t('msg.noEditor'));
      return undefined;
    }
    if (!statusBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notStatus'));
      return undefined;
    }
    return editor;
  };

  /**
   * File targets under every cursor of the status screen. A cursor on a section
   * header covers the whole section, and overlapping cursors count once.
   */
  const statusFiles = (
    editor: vscode.TextEditor
  ): { resolved: ResolvedTargets; files: FileTarget[] } => {
    const resolved = statusBuffer.resolveAll(editor.document.uri, editor.selections);
    const targets = resolved?.targets ?? [];
    return {
      resolved: resolved ?? { kind: 'none', targets: [] },
      files: targets.filter((target): target is FileTarget => target.kind === 'file'),
    };
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
      void statusBuffer.refreshAll().catch((error: unknown) => output.appendLine(`[refresh] ${formatError(error)}`));
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
      void updateStatusBar();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => highlighter.applyVisible()),
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

  const stageOrUnstageSelection = async (expected: 'staged' | 'unstaged'): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = diffBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notDiff'));
      return;
    }
    if (state.mode !== expected) {
      warn(t('msg.notDiff'));
      return;
    }
    const cursor = editor.selection.start.line;
    let message: string;
    try {
      message = await diffBuffer.applySelection(editor.document.uri, editor);
    } catch (error) {
      if (error instanceof PatchApplyError) {
        await diffBuffer.refresh(editor.document.uri, cursor);
        warn(
          t('msg.staleDiff')
        );
        return;
      }
      throw error;
    }
    await diffBuffer.refresh(editor.document.uri, cursor);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(message);
  };

  register('githelm.status.open', async () => {
    const repo = await resolveRepo();
    if (repo) {
      await statusBuffer.open(repo);
      return;
    }
    const folder = resolveFolder();
    if (!folder) {
      warn(t('msg.noRepo'));
      return;
    }
    // No repository yet: show the status screen with a `git init` row instead of
    // failing, and put the same action on a notification button.
    await statusBuffer.open(folder);
    const choice = await vscode.window.showInformationMessage(t('msg.notRepoInit'), t('action.initGit'));
    if (choice === t('action.initGit')) {
      await initRepo(folder);
    }
  });

  register('githelm.repo.init', async () => {
    const editor = vscode.window.activeTextEditor;
    const folder = (editor ? statusBuffer.folderForUri(editor.document.uri) : undefined) ?? resolveFolder();
    if (!folder) {
      warn(t('msg.noRepo'));
      return;
    }
    const existing = await findRepoRoot(folder);
    if (existing) {
      await statusBuffer.open(existing);
      return;
    }
    await initRepo(folder);
  });

  register('githelm.status.refresh', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && statusBuffer.stateFor(editor.document.uri)) {
      await statusBuffer.refresh(editor.document.uri, editor.selection.active.line);
      return;
    }
    const repo = await resolveRepo();
    if (repo) {
      await statusBuffer.open(repo);
      return;
    }
    const folder = resolveFolder();
    if (!folder) {
      warn(t('msg.noRepo'));
      return;
    }
    await statusBuffer.open(folder);
  });

  register('githelm.status.stage', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      return;
    }
    const { resolved, files } = statusFiles(editor);
    if (resolved.kind === 'none' || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    const pending = files.filter((target) => target.section !== 'staged');
    if (pending.length === 0) {
      notify(t('msg.alreadyStaged'));
      return;
    }
    if (pending.some((target) => target.section === 'conflict')) {
      const confirmed = await vscode.window.showWarningMessage(
        t('msg.conflictStage'),
        { modal: true },
        t('action.stage')
      );
      if (confirmed !== t('action.stage')) {
        return;
      }
    }
    const paths = [...new Set(pending.map((target) => target.path))];
    await stageFiles(state.repoPath, paths);
    await statusBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.stagedCount', { count: paths.length }));
  });

  register('githelm.status.unstage', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      return;
    }
    const { resolved, files } = statusFiles(editor);
    if (resolved.kind === 'none' || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    const pending = files.filter((target) => target.section !== 'untracked');
    if (pending.length === 0) {
      refuse(t('msg.untrackedUnstage'));
      return;
    }
    const paths = [...new Set(pending.map((target) => target.path))];
    await unstageFiles(state.repoPath, paths);
    await statusBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.unstagedCount', { count: paths.length }));
  });

  register('githelm.status.ignore', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      return;
    }
    if (!state.initialized) {
      warn(t('msg.noRepo'));
      return;
    }
    const { resolved, files } = statusFiles(editor);
    const paths = [...new Set(files.map((target) => target.path))];
    if (resolved.kind === 'none' || paths.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }

    const result = await addToGitignore(state.repoPath, paths);
    if (result.added.length > 0) {
      notify(t('msg.ignoredCount', { count: result.added.length }));
    } else if (result.tracked.length === 0) {
      notify(t('msg.ignoredNothing'));
    }
    if (result.tracked.length > 0) {
      warn(t('msg.ignoreTracked', { count: result.tracked.length }));
    }
    await statusBuffer.refresh(editor.document.uri, editor.selection.active.line);
  });

  register('githelm.status.diff', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      return;
    }
    const { resolved, files } = statusFiles(editor);
    const targets = resolved.targets;
    const stashes = targets.filter(
      (target): target is Extract<StatusTarget, { kind: 'stash' }> => target.kind === 'stash'
    );

    if (resolved.kind === 'none' || targets.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }

    for (const ref of new Set(stashes.map((stash) => stash.ref))) {
      const text = await showStash(state.repoPath, ref);
      await compareBuffer.open(state.repoPath, ref, text);
    }

    if (files.length === 0) {
      if (stashes.length === 0) {
        notify(t('msg.forFiles'));
      }
      return;
    }

    // One buffer per mode: staged and unstaged content cannot share a `git diff`
    // call. Groups are opened in reverse so the buffer of the primary cursor
    // (the first target resolved) ends up as the visible one.
    const groups = new Map<DiffMode, FileTarget[]>();
    for (const target of files) {
      const mode: DiffMode = target.section === 'staged' ? 'staged' : 'unstaged';
      const group = groups.get(mode);
      if (group) {
        group.push(target);
      } else {
        groups.set(mode, [target]);
      }
    }

    let changed = false;
    for (const [mode, group] of [...groups].reverse()) {
      if (mode === 'unstaged') {
        for (const target of group.filter((entry) => entry.section === 'untracked')) {
          // Untracked files are invisible to `git diff`; adopt them as
          // intent-to-add so they show up (and can be staged partially).
          await addIntentToAdd(state.repoPath, target.path);
          changed = true;
        }
      }
      const paths = [...new Set(group.map((target) => target.path))];
      await diffBuffer.open(state.repoPath, mode, paths);
    }

    if (changed) {
      await statusBuffer.refresh(editor.document.uri, editor.selection.active.line);
    }
  });
  register('githelm.status.discard', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      return;
    }
    const { resolved, files } = statusFiles(editor);
    if (resolved.kind === 'none' || files.length === 0) {
      notify(t('msg.cursorNotFile'));
      return;
    }

    const plan = planDiscard(files);
    const preview = (list: readonly string[]): string => {
      const shown = list.slice(0, 5).join(', ');
      return list.length > 5 ? `${shown}, … +${list.length - 5}` : shown;
    };
    const layers: Array<[readonly string[], MessageKey]> = [
      [plan.conflicts, 'discard.layerConflict'],
      [plan.staged, 'discard.layerStaged'],
      [plan.worktree, 'discard.layerWorktree'],
      [plan.remove, 'discard.layerNew'],
    ];
    const notes = layers
      .filter(([list]) => list.length > 0)
      .map(([list, key]) => t(key, { files: preview(list) }));
    const confirmed = await vscode.window.showWarningMessage(
      t('confirm.discard', { files: preview(plan.paths) }),
      { modal: true, ...(notes.length > 0 ? { detail: notes.join('\n') } : {}) },
      t('action.discard')
    );
    if (confirmed !== t('action.discard')) {
      return;
    }

    await discardPaths(state.repoPath, plan);
    await statusBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.discardedCount', { count: plan.paths.length }));
  });
  register('githelm.status.openFile', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    const target = statusBuffer.targetAt(editor.document.uri, editor.selection.active.line + 1, editor.selection.active.character);
    if (!state || !target) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    if (target.kind === 'init') {
      await initRepo(state.repoPath);
      return;
    }
    if (target.kind === 'stash') {
      await stashBuffer.open(state.repoPath, target.ref);
      return;
    }
    if (target.kind === 'worktree') {
      // Another worktree is another checkout: show its own status buffer.
      await statusBuffer.open(target.path);
      return;
    }
    if (target.kind === 'file' && target.section === 'conflict') {
      await conflictBuffer.open(state.repoPath, target.path);
      return;
    }
    if (target.kind !== 'file') {
      notify(t('msg.forFiles'));
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(state.repoPath, target.path)), { preview: false });
  });

  register('githelm.diff.stageSelection', () => stageOrUnstageSelection('unstaged'));
  register('githelm.diff.unstageSelection', () => stageOrUnstageSelection('staged'));

  register('githelm.diff.refresh', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!diffBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notDiff'));
      return;
    }
    await diffBuffer.refresh(editor.document.uri, editor.selection.active.line);
  });

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
    await statusBuffer.refreshAll();
    await updateStatusBar();
    void vscode.window.showInformationMessage(t('msg.committed'));
  };

  register('githelm.status.commit', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await commitFromBuffer(repo);
  });

  register('githelm.help', async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri && HelpBuffer.viewOf(uri)) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      return;
    }
    const view = uri ? viewOf(uri) : 'status';
    await helpBuffer.open(view || 'status');
  });

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
    await statusBuffer.refreshAll();
    await updateStatusBar();
    void vscode.window.showInformationMessage(t('msg.updated'));
  });

  register('githelm.log.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await logBuffer.open(repo, false);
  });

  register('githelm.log.refresh', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !logBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notLog'));
      return;
    }
    await logBuffer.refresh(editor.document.uri, editor.selection.active.line);
  });

  register('githelm.log.toggleAll', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !logBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notLog'));
      return;
    }
    await logBuffer.toggleAll(editor.document.uri, editor.selection.active.line);
    notify(t('msg.updated'));
  });

  register('githelm.log.showCommit', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notLog'));
      return;
    }
    const line = editor.selection.active.line + 1;
    const field = logBuffer.fieldAt(editor.document.uri, line);
    if (field) {
      const value = await vscode.window.showInputBox({
        prompt: t('prompt.filterValue', { field: filterHint(field) }),
        value: state.filter[field] ?? '',
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      const next: LogFilter = { ...state.filter };
      const writable = next as Record<string, string | undefined>;
      if (value.trim()) {
        writable[field] = value.trim();
      } else {
        delete writable[field];
      }
      await logBuffer.setFilter(editor.document.uri, next, line - 1);
      return;
    }
    const commit = logBuffer.commitAt(editor.document.uri, line);
    if (!commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    await commitBuffer.open(state.repoPath, commit.sha);
  });

  register('githelm.log.createBranch', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    const commit = logBuffer.commitAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: t('prompt.branchFrom', { ref: commit.shortSha }),
      placeHolder: 'feature/x',
      ignoreFocusOut: true,
    });
    if (!name || !name.trim()) {
      return;
    }
    const branch = name.trim();
    await createBranch(state.repoPath, branch, commit.sha);
    await statusBuffer.refreshAll();
    await logBuffer.refresh(state.uri, editor.selection.active.line);
    await updateStatusBar();
    notify(t('msg.branchCreated', { name: branch }));
  });

  register('githelm.log.tagCreate', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    const commit = logBuffer.commitAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    await createTagAt(state.repoPath, { ref: commit.sha, shortSha: commit.shortSha });
    // The graph prints the refs of each row, so the new tag appears on it.
    await statusBuffer.refreshAll();
    await logBuffer.refresh(state.uri, editor.selection.active.line);
    await updateStatusBar();
  });

  register('githelm.log.checkout', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    const commit = logBuffer.commitAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    const refs = checkoutableRefs(commit.refs);
    if (refs.length === 0) {
      warn(t('msg.notEditable'));
      return;
    }
    const target = refs.length === 1 ? refs[0] : await vscode.window.showQuickPick(refs, { placeHolder: t('branch.pick') });
    if (!target) {
      return;
    }
    await checkoutBranch(state.repoPath, target);
    await statusBuffer.refreshAll();
    await logBuffer.refresh(state.uri, editor.selection.active.line);
    await updateStatusBar();
    notify(t('msg.checkout', { name: target }));
  });

  register('githelm.log.fixup', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    const commit = logBuffer.commitAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    if (!(await hasStagedChanges(state.repoPath))) {
      warn(t('msg.noStaged'));
      return;
    }

    await createFixupCommit(state.repoPath, commit.sha);
    notify(t('msg.updated'));

    const base = await parentOf(state.repoPath, commit.sha);
    try {
      const result = await runInteractiveRebase({
        repoPath: state.repoPath,
        base,
        extraArgs: ['--autosquash'],
        shimsDir: shimsDir(),
        onEdit: async (request) => {
          const name = path.basename(request.path);
          const uri = editable.createUri(
            name.includes('git-rebase-todo') ? 'rebase-todo' : 'commit-message',
            state.repoPath
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
        await statusBuffer.refreshAll();
        await logBuffer.refresh(state.uri, editor.selection.active.line);
        return;
      }
      throw error;
    }

    await statusBuffer.refreshAll();
    await logBuffer.refresh(state.uri, editor.selection.active.line);
    await updateStatusBar();
    void vscode.window.showInformationMessage(t('msg.committed'));
  });

  register('githelm.status.amend', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
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
    await statusBuffer.refreshAll();
    await updateStatusBar();
    void vscode.window.showInformationMessage(t('msg.amendDone'));
  });

  register('githelm.diff.openFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = diffBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notDiff'));
      return;
    }
    const position = diffPosition(state.parsed, editor.selection.active.line + 1);
    if (!position) {
      notify(t('msg.cursorNotFile'));
      return;
    }

    const target = vscode.Uri.file(path.join(state.repoPath, position.file.path));
    let targetEditor: vscode.TextEditor;
    try {
      targetEditor = await vscode.window.showTextDocument(target, { preview: false });
    } catch {
      warn(t('msg.cursorNotFile'));
      return;
    }
    const line = Math.min(Math.max(0, position.line - 1), Math.max(0, targetEditor.document.lineCount - 1));
    targetEditor.selection = new vscode.Selection(line, 0, line, 0);
    targetEditor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  });

  const statusTargetFor = (): { editor: vscode.TextEditor; repo: string; target: StatusTarget } | undefined => {
    const editor = statusEditor();
    if (!editor) {
      return undefined;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      return undefined;
    }
    const target = statusBuffer.targetAt(editor.document.uri, editor.selection.active.line + 1, editor.selection.active.character);
    if (!target) {
      notify(t('msg.cursorNotEntry'));
      return undefined;
    }
    return { editor, repo: state.repoPath, target };
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

  register('githelm.status.stash', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notStatus'));
      return;
    }
    // Files under the cursors are the answer: the options are not asked for, and
    // only those files go into the stash.
    const { files } = statusFiles(editor);
    const options = files.length > 0 ? {} : await askStashOptions();
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
    await pushStash(state.repoPath, message, planStash(files, options));
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.stashCreated'));
  });

  register('githelm.status.stashApply', async () => {
    const found = statusTargetFor();
    if (!found) {
      return;
    }
    if (found.target.kind !== 'stash') {
      notify(t('msg.cursorNotEntry'));
      return;
    }
    await applyStash(found.repo, found.target.ref);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.stashApplied', { ref: found.target.ref }));
  });

  register('githelm.status.stashPop', async () => {
    const found = statusTargetFor();
    if (!found) {
      return;
    }
    if (found.target.kind !== 'stash') {
      notify(t('msg.cursorNotEntry'));
      return;
    }
    await popStash(found.repo, found.target.ref);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.stashPopped', { ref: found.target.ref }));
  });

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

  register('githelm.status.tagCreate', async () => {
    const editor = statusEditor();
    if (!editor) {
      return;
    }
    const state = statusBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notStatus'));
      return;
    }
    const commit = state.rendered.commitLines.get(editor.selection.active.line + 1);
    await createTagAt(state.repoPath, commit);
    await statusBuffer.refreshAll();
    await updateStatusBar();
  });

  register('githelm.status.remoteAdd', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
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
    await statusBuffer.refreshAll();
    notify(t('msg.remoteAdded', { name: name.trim() }));
  });

  register('githelm.status.worktreeAdd', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
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
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.worktreeAdded', { path: target }));
  });

  register('githelm.status.worktreePrune', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    const removed = await pruneWorktrees(repo);
    await statusBuffer.refreshAll();
    notify(removed > 0 ? t('msg.worktreePruned', { count: removed }) : t('msg.worktreeNothingToPrune'));
  });

  // `Enter` shows the other worktree's status buffer; `Shift+Enter` makes it the
  // folder of a new window, `Alt+Enter` reloads this window on it.
  const worktreeUnderCursor = async (): Promise<StatusTarget | undefined> => {
    const found = statusTargetFor();
    if (!found) {
      notify(t('msg.notStatus'));
      return undefined;
    }
    if (found.target.kind !== 'worktree') {
      // Anywhere else the opening keys keep their usual meaning: open the file.
      await vscode.commands.executeCommand('githelm.status.openFile');
      return undefined;
    }
    if (!fs.existsSync(found.target.path)) {
      warn(t('msg.worktreeMissing', { path: found.target.path }));
      return undefined;
    }
    return found.target;
  };

  register('githelm.status.worktreeOpen', async () => {
    const worktree = await worktreeUnderCursor();
    if (!worktree || worktree.kind !== 'worktree') {
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), {
      forceNewWindow: true,
    });
  });

  register('githelm.status.worktreeOpenHere', async () => {
    const worktree = await worktreeUnderCursor();
    if (!worktree || worktree.kind !== 'worktree') {
      return;
    }
    if (worktree.current) {
      notify(t('msg.worktreeAlreadyHere'));
      return;
    }
    // Reloading the window drops its layout and any unsaved editors, so ask first.
    const confirmed = await vscode.window.showWarningMessage(
      t('confirm.openWorktreeHere', { path: worktree.path }),
      { modal: true },
      t('action.openHere')
    );
    if (confirmed !== t('action.openHere')) {
      return;
    }
    // `forceReuseWindow` reopens this window on that folder instead of a new one.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), {
      forceReuseWindow: true,
    });
  });

  register('githelm.status.delete', async () => {
    const found = statusTargetFor();
    if (!found) {
      return;
    }
    const { repo, target } = found;

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
      await statusBuffer.refreshAll();
      await updateStatusBar();
      notify(t('msg.worktreeRemoved', { path: target.path }));
      return;
    } else {
      notify(t('msg.forFiles'));
      return;
    }

    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.deleted'));
  });

  register('githelm.status.edit', async () => {
    const found = statusTargetFor();
    if (!found) {
      return;
    }
    const { repo, target } = found;

    if (target.kind === 'remote') {
      const url = await vscode.window.showInputBox({ prompt: t('prompt.remoteUrl', { name: target.name }), value: target.url, ignoreFocusOut: true });
      if (!url || !url.trim() || url.trim() === target.url) {
        return;
      }
      await setRemoteUrl(repo, target.name, url.trim());
    } else {
      notify(t('msg.notEditable'));
      return;
    }

    await statusBuffer.refreshAll();
    notify(t('msg.updated'));
  });

  register('githelm.status.branches', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await branchesBuffer.open(repo, false);
  });

  register('githelm.branches.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await branchesBuffer.open(repo, false);
  });

  register('githelm.branches.checkout', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !entry) {
      notify(t('msg.cursorNotBranch'));
      return;
    }
    await checkoutBranch(state.repoPath, entry.name);
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.checkout', { name: entry.name }));
  });

  register('githelm.branches.create', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    if (!state) {
      return;
    }
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    const name = await vscode.window.showInputBox({
      prompt: t('prompt.branchFrom', { ref: entry?.name ?? 'HEAD' }),
      placeHolder: 'feature/x',
      ignoreFocusOut: true,
    });
    if (!name || !name.trim()) {
      return;
    }
    await createBranch(state.repoPath, name.trim(), entry?.name);
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.branchCreated', { name: name.trim() }));
  });

  register('githelm.branches.rename', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !entry) {
      notify(t('msg.cursorNotBranch'));
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
    await renameBranch(state.repoPath, entry.name, name.trim());
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.branchRenamed', { name: name.trim() }));
  });

  register('githelm.branches.delete', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !entry) {
      notify(t('msg.cursorNotBranch'));
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
    const confirmed = await vscode.window.showWarningMessage(t('confirm.deleteBranch', { name: entry.name }), { modal: true }, t('action.delete'));
    if (confirmed !== t('action.delete')) {
      return;
    }
    let force = false;
    try {
      await deleteBranch(state.repoPath, entry.name, false);
    } catch {
      const forced = await vscode.window.showWarningMessage(
        t('msg.branchNotMerged', { name: entry.name }),
        { modal: true },
        t('msg.forceDelete')
      );
      if (forced !== t('msg.forceDelete')) {
        return;
      }
      force = true;
    }
    if (force) {
      await deleteBranch(state.repoPath, entry.name, true);
    }
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.branchDeleted', { name: entry.name }));
  });

  register('githelm.branches.upstream', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !entry) {
      notify(t('msg.cursorNotBranch'));
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
    await setUpstream(state.repoPath, entry.name, value.trim());
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(`Upstream: ${value.trim()}`);
  });

  register('githelm.branches.toggleRemote', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!branchesBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notBranches'));
      return;
    }
    const show = await branchesBuffer.toggleRemote(editor.document.uri, editor.selection.active.line);
    notify(show ? t('msg.remotesShown') : t('msg.remotesHidden'));
  });

  register('githelm.branches.refresh', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!branchesBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notBranches'));
      return;
    }
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
  });

  // `/` is navigation, not a second filter UI: the filter rows live in the
  // buffer header and are edited in place, so `/` just jumps to them.
  register('githelm.log.search', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notLog'));
      return;
    }
    const firstField = [...state.fieldLines.keys()][0];
    if (!firstField) {
      return;
    }
    const line = Math.max(0, firstField - 1);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  });

  register('githelm.log.cherryPick', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    const commit = logBuffer.commitAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    await cherryPick(state.repoPath, commit.sha);
    await statusBuffer.refreshAll();
    await logBuffer.refresh(state.uri, editor.selection.active.line);
    await updateStatusBar();
    notify(`Cherry-pick ${commit.shortSha}`);
  });

  register('githelm.log.revert', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    const commit = logBuffer.commitAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
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
      await revertCommit(state.repoPath, commit.sha, mainline);
    } catch (error) {
      // A conflict leaves the revert half-done: show the files, keep the error.
      await statusBuffer.refreshAll();
      await updateStatusBar();
      throw error;
    }
    await statusBuffer.refreshAll();
    await logBuffer.refresh(state.uri, editor.selection.active.line);
    await updateStatusBar();
    notify(t('msg.reverted', { sha: commit.shortSha }));
  });

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
        { label: t('help.history'), description: 'git log --follow', value: 'log' },
        { label: 'Blame', description: 'git blame', value: 'blame' },
      ],
      { placeHolder: relative }
    );
    if (!picked) {
      return;
    }
    if (picked.value === 'log') {
      await logBuffer.open(repo, false, { path: relative });
      return;
    }
    await fileHistoryBuffer.open('blame', repo, relative);
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

  register('githelm.status.fetch', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    const remote = await pickRemote(repo);
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
    await statusBuffer.refreshAll();
    await logBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.fetched'));
  });

  register('githelm.status.pull', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    const remote = await pickRemote(repo);
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
    await statusBuffer.refreshAll();
    await logBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.pulled'));
  });

  register('githelm.status.push', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    const remote = await pickRemote(repo);
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
    await statusBuffer.refreshAll();
    await logBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.pushed'));
  });

  const pickResetMode = async (): Promise<ResetMode | undefined> => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: t('reset.soft'), value: 'soft' as ResetMode },
        { label: t('reset.mixed'), value: 'mixed' as ResetMode },
        { label: t('reset.hard'), value: 'hard' as ResetMode },
      ],
      { placeHolder: t('reset.pickMode') }
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

  register('githelm.status.reset', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    const mode = await pickResetMode();
    if (!mode || !(await confirmReset(mode))) {
      return;
    }
    const targets = [{ label: 'HEAD', value: 'HEAD' }];
    const upstream = await readUpstream(repo);
    if (upstream) {
      targets.push({ label: `${t('reset.targetUpstream')} (${upstream.ref})`, value: '@{u}' });
    }
    const picked = await vscode.window.showQuickPick(targets, { placeHolder: t('reset.pickTarget') });
    if (!picked) {
      return;
    }
    await resetTo(repo, mode, picked.value);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.resetDone', { mode, target: picked.label }));
  });

  register('githelm.status.abortMerge', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
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
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(aborted === 'merge' ? t('msg.mergeAborted') : t('msg.opAborted', { kind: aborted }));
  });

  // ---------- log reset ----------

  register('githelm.log.reset', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    const commit = logBuffer.commitAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !commit) {
      notify(t('msg.cursorNotCommit'));
      return;
    }
    const mode = await pickResetMode();
    if (!mode || !(await confirmReset(mode))) {
      return;
    }
    await resetTo(state.repoPath, mode, commit.sha);
    await statusBuffer.refreshAll();
    await logBuffer.refresh(state.uri, editor.selection.active.line);
    await updateStatusBar();
    notify(t('msg.resetDone', { mode, target: commit.shortSha }));
  });

  // ---------- branches: merge / delete remote / reset ----------

  register('githelm.branches.merge', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !entry) {
      notify(t('msg.cursorNotBranch'));
      return;
    }
    if (entry.current) {
      notify(t('msg.notEditable'));
      return;
    }
    try {
      await mergeRef(state.repoPath, entry.name);
      notify(t('msg.merged', { name: entry.name }));
    } catch (error) {
      await statusBuffer.refreshAll();
      throw error;
    }
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    await statusBuffer.refreshAll();
    await updateStatusBar();
  });

  register('githelm.branches.deleteRemote', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !entry) {
      notify(t('msg.cursorNotBranch'));
      return;
    }
    const slash = entry.name.indexOf('/');
    const remote = entry.isRemote && slash > 0 ? entry.name.slice(0, slash) : (await pickRemote(state.repoPath));
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
    await deleteRemoteBranch(state.repoPath, remote, branch);
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.deleted'));
  });

  register('githelm.branches.reset', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = branchesBuffer.stateFor(editor.document.uri);
    const entry = branchesBuffer.branchAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !entry) {
      notify(t('msg.cursorNotBranch'));
      return;
    }
    const mode = await pickResetMode();
    if (!mode || !(await confirmReset(mode))) {
      return;
    }
    await resetTo(state.repoPath, mode, entry.name);
    await branchesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.resetDone', { mode, target: entry.name }));
  });

  // ---------- submodules screen ----------

  const submoduleAtCursor = (): { repoPath: string; submodule: Submodule } | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const state = submodulesBuffer.stateFor(editor.document.uri);
    const submodule = submodulesBuffer.submoduleAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !submodule) {
      return undefined;
    }
    return { repoPath: state.repoPath, submodule };
  };

  register('githelm.submodules.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await submodulesBuffer.open(repo);
  });

  register('githelm.submodules.refresh', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !submodulesBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notSubmodules'));
      return;
    }
    await submodulesBuffer.refresh(editor.document.uri, editor.selection.active.line);
  });

  register('githelm.submodules.enter', async () => {
    const found = submoduleAtCursor();
    if (!found) {
      notify(t('msg.cursorNotSubmodule'));
      return;
    }
    if (found.submodule.state === 'uninitialized') {
      notify(t('msg.submoduleNotInitialized', { path: found.submodule.path }));
      return;
    }
    // A checked-out submodule is a repository of its own, so it gets its own
    // status screen — that is where its changes are actually staged or discarded.
    await statusBuffer.open(path.join(found.repoPath, found.submodule.path));
  });

  const updateSubmoduleAtCursor = async (remote: boolean): Promise<void> => {
    const found = submoduleAtCursor();
    if (!found) {
      notify(t('msg.cursorNotSubmodule'));
      return;
    }
    await updateSubmodule(found.repoPath, found.submodule.path, remote ? { init: true, remote: true } : { init: true });
    const editor = vscode.window.activeTextEditor;
    if (editor && submodulesBuffer.stateFor(editor.document.uri)) {
      await submodulesBuffer.refresh(editor.document.uri, editor.selection.active.line);
    }
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.submoduleUpdated', { path: found.submodule.path }));
  };

  register('githelm.submodules.update', () => updateSubmoduleAtCursor(false));
  register('githelm.submodules.updateRemote', () => updateSubmoduleAtCursor(true));

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

  register('githelm.forge.pulls', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
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
  });

  // ---------- tags screen ----------

  register('githelm.tags.open', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await tagsBuffer.open(repo);
  });

  register('githelm.tags.refresh', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !tagsBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notBranches'));
      return;
    }
    await tagsBuffer.refresh(editor.document.uri, editor.selection.active.line);
  });

  register('githelm.tags.show', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = tagsBuffer.stateFor(editor.document.uri);
    const tag = tagsBuffer.tagAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !tag) {
      notify(t('msg.cursorNotTag'));
      return;
    }
    await commitBuffer.open(state.repoPath, tag.name);
  });

  register('githelm.tags.push', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = tagsBuffer.stateFor(editor.document.uri);
    const tag = tagsBuffer.tagAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !tag) {
      notify(t('msg.cursorNotTag'));
      return;
    }
    const remote = await pickRemote(state.repoPath);
    if (!remote) {
      return;
    }
    try {
      // Asked before the confirmation so the question can say what is about to be
      // overwritten — and so the push can lease against exactly that value.
      const onRemote = await remoteTag(state.repoPath, remote, tag.name);
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
      await pushTag(state.repoPath, remote, tag.name);
      await tagsBuffer.refresh(editor.document.uri, editor.selection.active.line);
      notify(t('msg.tagPushed', { name: tag.name, remote }));
    } catch (error) {
      fail(error);
    }
  });

  register('githelm.tags.deleteRemote', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = tagsBuffer.stateFor(editor.document.uri);
    const tag = tagsBuffer.tagAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !tag) {
      notify(t('msg.cursorNotTag'));
      return;
    }
    const remote = await pickRemote(state.repoPath);
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
    try {
      await deleteRemoteTag(state.repoPath, remote, tag.name);
      await tagsBuffer.refresh(editor.document.uri, editor.selection.active.line);
      notify(t('msg.tagDeletedRemote', { name: tag.name, remote }));
    } catch (error) {
      fail(error);
    }
  });

  register('githelm.tags.create', async () => {
    const repo = await resolveRepo();
    if (!repo) {
      warn(t('msg.noRepo'));
      return;
    }
    await createTagAt(repo);
    await statusBuffer.refreshAll();
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === SCHEME && document.uri.path.startsWith('/tags/')) {
        await tagsBuffer.refresh(document.uri, 0);
      }
    }
  });

  register('githelm.tags.move', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = tagsBuffer.stateFor(editor.document.uri);
    const tag = tagsBuffer.tagAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !tag) {
      notify(t('msg.cursorNotTag'));
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
    await moveTag(state.repoPath, tag.name);
    await tagsBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.updated'));
  });

  register('githelm.tags.delete', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = tagsBuffer.stateFor(editor.document.uri);
    const tag = tagsBuffer.tagAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !tag) {
      notify(t('msg.cursorNotTag'));
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
    await deleteTag(state.repoPath, tag.name);
    await tagsBuffer.refresh(editor.document.uri, editor.selection.active.line);
    notify(t('msg.deleted'));
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
    await restoreOpenBuffers();
    notify(t('msg.languageChanged', { language: picked.label }));
  });

  register('githelm.log.resetFilters', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!logBuffer.stateFor(editor.document.uri)) {
      warn(t('msg.notLog'));
      return;
    }
    await logBuffer.resetFilters(editor.document.uri, editor.selection.active.line);
    notify(t('msg.filterCleared'));
  });

  register('githelm.actionLog', async () => {
    await actionLogBuffer.open();
  });

  register('githelm.actionLog.clear', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !actionLogBuffer.isActionLog(editor.document.uri)) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      t('confirm.clearLog'),
      { modal: true },
      t('action.delete')
    );
    if (confirmed !== t('action.delete')) {
      return;
    }
    await actionLogBuffer.clear(editor.document.uri);
    notify(t('actionLog.empty'));
  });

  register('githelm.actionLog.refresh', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !actionLogBuffer.isActionLog(editor.document.uri)) {
      return;
    }
    await actionLogBuffer.refresh(editor.document.uri, editor.selection.active.line);
  });

  register('githelm.log.sort', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notLog'));
      return;
    }
    const sort = await logBuffer.toggleSort(editor.document.uri, editor.selection.active.line);
    const label = sort === 'topo' ? t('sort.topo') : sort === 'date' ? t('sort.date') : t('sort.authorDate');
    notify(t('msg.sorted', { sort: label }));
  });

  register('githelm.log.compare', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = logBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notLog'));
      return;
    }

    const lines = [...new Set(editor.selections.map((selection) => selection.active.line + 1))];
    const commits = lines
      .map((line) => logBuffer.commitAt(editor.document.uri, line))
      .filter((commit): commit is NonNullable<typeof commit> => commit !== undefined);
    if (commits.length === 0) {
      notify(t('compare.needCommits'));
      return;
    }

    const head = await headSha(state.repoPath);
    const left = commits[0].sha;
    const right = commits.length > 1 ? commits[1].sha : head;
    const leftLabel = commits[0].shortSha;
    const rightLabel = commits.length > 1 ? commits[1].shortSha : 'HEAD';

    const picked = await vscode.window.showQuickPick(
      [
        { label: t('compare.diffTwo'), value: 'diff-two' },
        { label: t('compare.diffThree'), value: 'diff-three' },
        { label: t('compare.diffSwapped'), value: 'diff-swapped' },
        { label: t('compare.logTwo'), value: 'log-two' },
        { label: t('compare.logThree'), value: 'log-three' },
        { label: t('compare.logSwapped'), value: 'log-swapped' },
      ],
      { placeHolder: t('compare.pick', { a: leftLabel, b: rightLabel }) }
    );
    if (!picked) {
      return;
    }

    const openDiff = async (a: string, b: string, mode: 'two' | 'three'): Promise<void> => {
      const range = compareRange(a, b, mode);
      const text = await compareDiff(state.repoPath, a, b, mode);
      await compareBuffer.open(state.repoPath, range, text);
    };

    switch (picked.value) {
      case 'diff-two':
        await openDiff(left, right, 'two');
        break;
      case 'diff-three':
        await openDiff(left, right, 'three');
        break;
      case 'diff-swapped':
        await openDiff(right, left, 'two');
        break;
      case 'log-two':
        await logBuffer.openCompare(state.repoPath, compareRange(left, right, 'two'), false);
        break;
      case 'log-three':
        await logBuffer.openCompare(state.repoPath, compareRange(left, right, 'three'), true);
        break;
      case 'log-swapped':
        await logBuffer.openCompare(state.repoPath, compareRange(right, left, 'two'), false);
        break;
    }
  });
  register('githelm.stash.fileDiff', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = stashBuffer.stateFor(editor.document.uri);
    const path = stashBuffer.fileAt(editor.document.uri, editor.selection.active.line + 1);
    if (!state || !path) {
      notify(t('msg.cursorNotFile'));
      return;
    }
    const text = await stashFileDiff(state.repoPath, state.ref, path);
    await compareBuffer.open(state.repoPath, `${state.ref}/${path}`, text);
  });

  const takeConflictSide = async (side: 'ours' | 'theirs' | 'base'): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = conflictBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notStatus'));
      return;
    }
    await takeSide(state.repoPath, state.relativePath, side);
    await conflictBuffer.refresh(editor.document.uri);
    await statusBuffer.refreshAll();
    notify(t('msg.updated'));
  };

  register('githelm.conflict.ours', () => takeConflictSide('ours'));
  register('githelm.conflict.theirs', () => takeConflictSide('theirs'));
  register('githelm.conflict.base', () => takeConflictSide('base'));

  register('githelm.conflict.resolve', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = conflictBuffer.stateFor(editor.document.uri);
    if (!state) {
      warn(t('msg.notStatus'));
      return;
    }
    await markResolved(state.repoPath, state.relativePath);
    await statusBuffer.refreshAll();
    await updateStatusBar();
    notify(t('msg.conflictResolved'));
  });

  register('githelm.conflict.mergeEditor', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const state = conflictBuffer.stateFor(editor.document.uri);
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
  });
  register('githelm.buffer.close', async () => {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  // Buffers keep their text in memory, so a restarted extension host would show
  // empty tabs. Rebuild whatever is still open from the URIs themselves.
  const restoreOpenBuffers = async (): Promise<void> => {
    for (const document of vscode.workspace.textDocuments) {
      const uri = document.uri;
      if (uri.scheme !== SCHEME) {
        continue;
      }
      try {
        if (uri.path.startsWith('/status/')) {
          await statusBuffer.refresh(uri);
        } else if (uri.path.startsWith('/log/')) {
          await logBuffer.refresh(uri, 0);
        } else if (uri.path.startsWith('/diff/')) {
          await diffBuffer.refresh(uri, 0);
        } else if (uri.path.startsWith('/branches/')) {
          await branchesBuffer.refresh(uri, 0);
        } else if (uri.path.startsWith('/tags/')) {
          await tagsBuffer.refresh(uri, 0);
        } else if (uri.path.startsWith('/submodules/')) {
          await submodulesBuffer.refresh(uri, 0);
        } else if (uri.path.startsWith('/file/')) {
          await fileHistoryBuffer.restore(uri);
        } else if (uri.path.startsWith('/actionlog')) {
          await actionLogBuffer.refresh(uri, 0);
        } else if (uri.path.startsWith('/help/')) {
          await helpBuffer.restore(uri);
        } else if (uri.path.startsWith('/conflict/')) {
          await conflictBuffer.refresh(uri);
        } else if (uri.path.startsWith('/stashfiles/')) {
          await stashBuffer.refresh(uri, 0);
        } else if (uri.path.startsWith('/commit/')) {
          await commitBuffer.restore(uri);
        }
      } catch (error) {
        // Restoring the buffers of the last session happens once, at start-up: a
        // failure here leaves an empty buffer with no explanation, so it gets the
        // same treatment as any other failure.
        fail(error);
      }
    }
  };
  void restoreOpenBuffers();

  syncContext();
  void updateStatusBar();
  output.appendLine('Git Helm ready.');
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}