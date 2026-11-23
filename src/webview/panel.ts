import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { listBranchEntries } from '../git/actions';
import { choiceShowsDiff, compareChoices, compareFiles, headSha, planCompare, refTip } from '../git/compare';
import type { ComparePlan } from '../git/compare';
import { LOG_PAGE, LogCommit, LogFilter, LogSort, commitBySha, readLog, revisionExists } from '../git/log';
import { addToGitignore } from '../git/ignore';
import { discardPaths } from '../git/ops';
import { listRemotes, readUpstream } from '../git/remotes';
import { listStashes } from '../git/stash';
import { readSubmoduleStatus } from '../git/submodules';
import { stageAll, stageFiles, unstageAll, unstageFiles } from '../git/stage';
import { readStatus } from '../git/status';
import { listTags } from '../git/tags';
import { listWorktrees } from '../git/worktree';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { noteDiff } from '../views/diffWalkState';
import type { DiffEntry, OpenedDiff } from '../views/diffWalkState';
import { planDiscard } from '../views/discardPlan';
import { FILTER_FIELDS } from '../views/logFilters';
import type { FilterField } from '../views/logFilters';
import { buildActionLogModel } from './model/actionlog';
import { buildDocModel, lineNumbersOf } from './model/doc';
import type { DocModelGroup } from './model/doc';
import { buildBranchesModel } from './model/branches';
import { buildLogModel } from './model/log';
import { buildStatusModel, fileTargetsOf, pathsOf, sectionsOf } from './model/status';
import type { FileTarget } from '../views/discardPlan';
import { buildSubmodulesModel } from './model/submodules';
import { buildTagsModel } from './model/tags';
import type { Span } from '../util/span';
import type {
  ClientMessage,
  DocKind,
  HintModel,
  RepoAction,
  ScreenAction,
  ScreenKind,
  ScreenModel,
  StatusModel,
  WebviewAction,
} from './protocol';
import { targetOf } from './targets';
import type { PanelTarget } from './targets';

/** The actions the host runs for the whole repository, with no row under them. */
const REPO_ACTIONS = new Set<WebviewAction>([
  'amend',
  'fetch',
  'pull',
  'push',
  'reset',
  'abort',
  'pulls',
  'remoteAdd',
  'worktreeAdd',
  'worktreePrune',
]);

/** Actions that mean something only on a row of the right-hand column. */
const TARGET_ACTIONS = new Set<WebviewAction>([
  'open',
  'diff',
  'delete',
  'edit',
  'stashApply',
  'stashPop',
  'worktreeWindow',
  'worktreeHere',
  'fetch',
  'pull',
  'push',
]);

/** Actions that need a column row under them, and mean nothing without one. */
export type TargetAction =
  | 'open'
  | 'diff'
  | 'delete'
  | 'edit'
  | 'stashApply'
  | 'stashPop'
  | 'worktreeWindow'
  | 'worktreeHere'
  | 'fetch'
  | 'pull'
  | 'push';

/** What every panel needs: where the assets live and how the host talks to the user. */
export interface ScreenPanelDeps {
  extensionUri: vscode.Uri;
  notify: (message: string) => void;
  warn: (message: string) => void;
  /**
   * Re-reads the branch and the counters of the status bar. Every buffer command ends
   * with this call, so the panel's actions must end with it too — otherwise the bar
   * keeps the numbers it had before the user staged anything.
   */
  statusBar: () => Promise<void>;
  /**
   * `Tab` and `Shift+Tab`: the next or previous screen of the carousel, opened for the
   * repository the panel is showing when it is not on screen yet.
   */
  cycle: (from: ScreenKind | DocKind, direction: 1 | -1, repoPath: string) => Promise<void>;
  /**
   * After `q` closed a tab: puts the focus on another screen that is already open, so
   * the keys of the screens keep working instead of falling into an empty editor group.
   */
  neighbour: (from: ScreenKind | DocKind) => Promise<void>;
}

export interface StatusWebviewDeps extends ScreenPanelDeps {
  /** Opens the commit buffer for the repository; the buffer does the rest. */
  commit: (repoPath: string) => Promise<void>;
  /** Asks for a tag name and message, then tags HEAD. */
  createTag: (repoPath: string) => Promise<void>;
  /**
   * `z`: the selected files, or the whole working tree when nothing is selected.
   * The host owns it, so the panel asks the same stash questions the buffer asks and
   * reports through the same status-bar progress line.
   */
  stash: (repoPath: string, files: readonly { path: string; section: string }[]) => Promise<void>;
  /**
   * Repository-wide actions (`m`, `f`, `Shift+P`, …). The host owns them, so the
   * panel and the status buffer run one implementation and ask the same questions.
   */
  runRepo: (action: RepoAction, repoPath: string) => Promise<void>;
  /** The same, for the keys that act on a row of the right-hand column. */
  runTarget: (action: TargetAction, repoPath: string, target: PanelTarget) => Promise<void>;
  /**
   * The keys of the branches block: `Enter`/`c` checkout, `n` create, `m` merge and
   * `Shift+G` the branch's graph, on the row under the selection. The host runs the
   * branches screen's own implementation, so the panel asks the same questions and prints
   * the same notices.
   */
  runBranch: (action: ScreenAction, repoPath: string, ids: readonly string[]) => Promise<void>;
  /**
   * The keys of the last-commits block: `Enter` opens the commit, `n` branches from it,
   * `c` checks out, `C` cherry-picks, `V` reverts, `f` fixups, `R` resets and `t` tags.
   * The host runs the history screen's own implementation, so the commit is re-read from
   * the object store and every guard and question is the graph's.
   */
  runLog: (action: ScreenAction, repoPath: string, ids: readonly string[]) => Promise<void>;
  /**
   * `d`: the selected files in the built-in diff editor — a real side-by-side with syntax
   * highlighting, one multi-diff tab for the selection. The host groups the sections, so
   * staged files are read against the index and unstaged ones against the working tree.
   */
  openDiff: (repoPath: string, targets: readonly FileTarget[]) => Promise<void>;
}

/** What the screens that are lists need: one way to run their keys. */
export interface ListWebviewDeps extends ScreenPanelDeps {
  /**
   * Runs one key of the screen with the rows the user selected. The host owns the
   * action, so the panel and the text buffer run one implementation and ask the same
   * questions (`n` still asks for a branch name, `x` still confirms).
   */
  run: (action: ScreenAction, repoPath: string, ids: readonly string[]) => Promise<void>;
  /**
   * The graph of a range, on the screen that draws graphs. `d` on a branch asks the same
   * six questions the history screen asks; a `log …` answer is that range, so it is
   * read on the history screen instead of being copied into a second view.
   */
  openLogRange: (repoPath: string, range: string, leftRight: boolean) => Promise<void>;
  /**
   * The graph of one branch: `G` on the branches screen hands the name to the history
   * screen, which already has a filter that reads `git log <branch>` — so the reader lands
   * on the branch's own graph with the field filled in, not on a history to search in.
   */
  openLogBranch: (repoPath: string, branch: string) => Promise<void>;
}

/** What the history screen needs: the keys of its rows — it is where a range is shown. */
export type LogWebviewDeps = Omit<ListWebviewDeps, 'openLogRange' | 'openLogBranch'>;

const NEEDS_ROWS = new Set<WebviewAction>(['stage', 'unstage', 'diff', 'open', 'ignore', 'discard']);

/** The keys the last-commits rows borrow from the history screen. */
const COMMIT_ACTIONS = new Set<WebviewAction>([
  'show',
  'create',
  'checkout',
  'cherryPick',
  'revert',
  'fixup',
  'reset',
  'tag',
]);

/** A `git:` URI of `filePath` as it is at `ref`; the built-in git extension serves it. */
function revisionUri(repoPath: string, filePath: string, ref: string): vscode.Uri {
  const file = vscode.Uri.file(path.join(repoPath, filePath));
  return vscode.Uri.from({
    scheme: 'git',
    path: file.path,
    query: JSON.stringify({ path: file.fsPath, ref }),
  });
}

/**
 * The resource-list shape `vscode.changes` accepted last time. A screen that compares
 * several files probes it once and remembers the answer instead of guessing per press.
 */
let changesShape: number | undefined;

/**
 * The name of the side a change is read from, in the words the built-in git extension
 * uses: `a.ts (Index)` for the index, `a.ts (Working Tree)` for the working copy. Both
 * sides of a `git:` diff carry the same path, so the title is the only place that can
 * say which pair is on screen — without it a staged and an unstaged diff of one file
 * are two identical tabs.
 */
function sectionName(section: FileTarget['section']): string {
  if (section === 'staged') {
    return t('diff.side.index');
  }
  if (section === 'untracked') {
    return t('diff.side.untracked');
  }
  // Unstaged and conflicted: the right side is the working copy either way.
  return t('diff.side.worktree');
}

/** A revision as a title: a full sha reads as its short form, anything else stays. */
function refName(ref: string): string {
  return /^[0-9a-f]{40,64}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

/**
 * A diff in the built-in editor: a real side-by-side with syntax highlighting, instead
 * of a generated diff buffer. One file is one tab; several go into one multi-diff
 * editor — the view the built-in git extension opens — so a comparison is one tab, not
 * N. Falls back to one tab per file when that editor cannot be opened.
 *
 * `nameSingle` gives one file the same label it would have had in a multi-diff. A reader
 * opening a file by hand wants the pair in the tab ("a.ts (HEAD^) ↔ a.ts (HEAD)"); a walk
 * stepping through commits wants the commit, and the neighbouring commit may well have
 * touched a single file — the tab has to say "<sha> — 1", not turn into a file's history.
 */
export async function openDiffEntries(
  entries: readonly DiffEntry[],
  title = `${t('app.name')} — ${entries.length}`,
  nameSingle = false
): Promise<OpenedDiff | undefined> {
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    const [entry] = entries;
    const label = nameSingle ? title : entry.title;
    await vscode.commands.executeCommand('vscode.diff', entry.left, entry.right, label, { preview: false });
    return noteDiff(label, [entry]);
  }
  // `vscode.changes` is not part of the typed API. Its resource list is a triple of
  // URIs — the file to reveal, its original side, its modified side — which the
  // workbench handler revives one by one, so the first entry has to be a URI: a plain
  // label there throws. The older reading of the arguments (label first) is kept as a
  // second try, and the working shape is remembered after the first use.
  const shapes: unknown[][] = [
    entries.map((entry) => [entry.right, entry.left, entry.right]),
    entries.map((entry) => [entry.title, entry.left, entry.right]),
  ];
  const order = [
    ...(changesShape === undefined ? [] : [changesShape]),
    ...shapes.map((_, index) => index).filter((index) => index !== changesShape),
  ];
  for (const index of order) {
    try {
      await vscode.commands.executeCommand('vscode.changes', title, shapes[index]);
      changesShape = index;
      return noteDiff(title, entries);
    } catch {
      // Try the next shape: builds differ in the one they accept.
    }
  }
  // No working multi-diff: one tab per file still beats one file out of many.
  let last: OpenedDiff | undefined;
  for (const entry of entries) {
    await vscode.commands.executeCommand('vscode.diff', entry.left, entry.right, entry.title, {
      preview: false,
    });
    last = noteDiff(entry.title, [entry]);
  }
  return last;
}

/**
 * The `diff …` half of a compare, for every panel: the files that differ across the
 * plan's range, opened in the built-in multi-diff at both revisions. Returns false when
 * nothing differs, so the caller can say that in its own words. The revisions are
 * `git:` URIs, which is how the built-in editor reads a file as it was at a commit
 * without touching the working tree.
 */
async function openCompareDiff(repoPath: string, plan: ComparePlan): Promise<boolean> {
  return openRangeDiff(repoPath, plan.range, plan.diffLeft, plan.diffRight, plan.label);
}

/**
 * `d` in the status panel: the selected files in the built-in diff editor.
 *
 * These are the pairs the built-in git extension itself compares, so the editor shows
 * what the SCM view shows and can be read with the full diff UI — folding, syntax
 * highlighting, both sides side by side — instead of a generated patch that only looks
 * like a diff. Staged rows are read against the index, unstaged ones are the index
 * against the working tree (so a staged-and-edited file shows only the edit), and a
 * conflicted file is read against the base stage, because its working copy is the one
 * with the markers in it.
 */
export async function openFileDiffs(
  repoPath: string,
  targets: readonly FileTarget[]
): Promise<OpenedDiff | undefined> {
  const entries = targets.map((target) => {
    const file = vscode.Uri.file(path.join(repoPath, target.path));
    const title = `${target.path} (${sectionName(target.section)})`;
    if (target.section === 'staged') {
      // A deleted file has no index side to read, so the empty right side is the point.
      const right = target.entry.xy.includes('D') ? file : revisionUri(repoPath, target.path, '');
      return { title, left: revisionUri(repoPath, target.path, 'HEAD'), right };
    }
    if (target.section === 'conflict') {
      return { title, left: revisionUri(repoPath, target.path, ':1'), right: file };
    }
    return { title, left: revisionUri(repoPath, target.path, ''), right: file };
  });
  return openDiffEntries(entries);
}

/**
 * One file or a whole list of them as they were at two revisions, in the built-in diff
 * editor: `git:` URIs the built-in git extension serves, so the editor shows the change
 * without touching the working tree. `''` as a ref is the index, `HEAD` the last commit,
 * `A~1` the commit before `A`, and `stash@{0}` the stash — every ref git itself already
 * knows.
 *
 * A list is one multi-diff tab, not a tab per file: `d` on a commit's (or a stash's) whole
 * file list is one answer to "what did this change", which is what the list itself is.
 */
export async function openRevisionDiffs(
  repoPath: string,
  files: readonly string[],
  leftRef: string,
  rightRef: string,
  label: string,
  /** Name a single-file diff after the commit rather than after its pair: a walk's step. */
  nameSingle = false
): Promise<OpenedDiff | undefined> {
  if (files.length === 0) {
    return undefined;
  }
  const left = refName(leftRef);
  const right = refName(rightRef);
  return openDiffEntries(
    files.map((filePath) => ({
      title: `${filePath} (${left}) ↔ ${filePath} (${right})`,
      left: revisionUri(repoPath, filePath, leftRef),
      right: revisionUri(repoPath, filePath, rightRef),
    })),
    `${label} — ${files.length}`,
    nameSingle
  );
}

/** A file as it was at a revision: a read-only tab, the answer for a root commit. */
export async function openFileAtRef(repoPath: string, filePath: string, ref: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(revisionUri(repoPath, filePath, ref));
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Files as they were at a revision, one read-only tab each: the answer for a root commit,
 * which has no parent to diff against however many files it added.
 */
export async function openFilesAtRef(repoPath: string, files: readonly string[], ref: string): Promise<void> {
  for (const filePath of files) {
    await openFileAtRef(repoPath, filePath, ref);
  }
}

/**
 * The `diff` of a range (`A..B`) as one multi-diff tab: every file the range touches,
 * both sides read at their own revision. Returns false when nothing differs, so the
 * caller can say that in its own words.
 */
export async function openRangeDiff(
  repoPath: string,
  range: string,
  leftRef: string,
  rightRef: string,
  label: string
): Promise<boolean> {
  const files = await compareFiles(repoPath, range);
  if (files.length === 0) {
    return false;
  }
  const left = refName(leftRef);
  const right = refName(rightRef);
  await openDiffEntries(
    files.map((filePath) => ({
      title: `${filePath} (${left}) ↔ ${filePath} (${right})`,
      left: revisionUri(repoPath, filePath, leftRef),
      right: revisionUri(repoPath, filePath, rightRef),
    })),
    `${label} — ${files.length}`
  );
  return true;
}
/** The only commands the webview may ask the host to run. */
const OPENERS = new Set([
  'githelm.log.open',
  'githelm.branches.open',
  'githelm.tags.open',
  'githelm.submodules.open',
  'githelm.actionLog',
]);

/**
 * One screen as a webview panel.
 *
 * The host keeps owning git and the translations; the panel owns layout, selection and
 * keys. One panel per screen — so the status screen and the branches screen can sit
 * side by side as tabs, exactly like the buffers do. Opening a screen again reveals the
 * existing tab and re-reads the repository, and becoming visible does the same, so a
 * panel is never a stale snapshot of a repository that changed while it was hidden.
 */
export abstract class ScreenPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private repoPath: string | undefined;
  private model: ScreenModel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(protected readonly deps: ScreenPanelDeps) {}

  /** `githelm.webview.branches`: one per screen, so two screens are two tabs. */
  protected abstract get viewType(): string;

  /** Which screen this is, for the carousel's order and for `runScreen`. */
  abstract get kind(): ScreenKind | DocKind;

  /** Reads the screen's data and builds the model the panel draws. */
  protected abstract buildModel(repoPath: string): Promise<ScreenModel>;

  /** A key of the status screen; the list screens use `onScreen` instead. */
  protected async onAction(_action: WebviewAction, _ids: string[]): Promise<void> {}

  /** A key of a list screen. */
  protected async onScreen(_action: ScreenAction, _ids: string[]): Promise<void> {}

  /** The reader reached the end of a screen that is read a page at a time. */
  protected async onMore(): Promise<void> {}

  /** A filter input was submitted: `field` now holds `value`, empty clears it. */
  protected async onFilter(_field: string, _value: string): Promise<void> {}

  async show(repoPath: string): Promise<void> {
    try {
      await this.showPanel(repoPath);
    } catch (error) {
      this.deps.warn(`${t('app.name')}: ${(error as Error).message}`);
    }
  }

  private async showPanel(repoPath: string): Promise<void> {
    this.repoPath = repoPath;
    const existing = this.panel;
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      await this.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(this.viewType, t('app.name'), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview-client'),
        vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'webview'),
      ],
    });
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html(panel.webview);
    this.panel = panel;
    this.disposables = [
      panel.webview.onDidReceiveMessage((message: ClientMessage) => void this.handle(message)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) {
          void this.refresh();
        }
      }),
      panel.onDidDispose(() => {
        this.panel = undefined;
        this.disposeListeners();
      }),
    ];
    await this.refresh();
  }

  /** The repository the panel shows, so the UI switch can carry the screen over. */
  get folder(): string | undefined {
    return this.repoPath;
  }

  /**
   * The repository the panel shows, while it is on screen. The host's `resolveRepo()`
   * asks this so the status bar and the commands remember which repository the user is
   * looking at when a panel has the focus and no text editor is active — the buffer
   * names its own repository the same way.
   */
  repoIfVisible(): string | undefined {
    return this.panel?.visible && this.repoPath ? this.repoPath : undefined;
  }

  /** Whether this screen is on screen. */
  get visible(): boolean {
    return this.panel?.visible === true;
  }

  /**
   * Whether the screen has a tab at all — also when another tab of the group is the one
   * on screen. The carousel reveals such a tab instead of opening a second one.
   */
  get open(): boolean {
    return this.panel !== undefined;
  }

  /** Focuses the tab, keeping the repository it already shows. */
  reveal(): void {
    this.panel?.reveal();
  }

  /**
   * Re-reads a panel that is on screen. The host calls this from the same debounced
   * refresh the text buffers use (`git` touching the index, a document saved), so both
   * UIs follow the repository on the very same events.
   */
  async refreshIfVisible(): Promise<void> {
    if (this.panel?.visible) {
      await this.refresh();
    }
  }

  /** Re-reads the repository and pushes a fresh model to the panel. */
  async refresh(): Promise<void> {
    const panel = this.panel;
    const repoPath = this.repoPath;
    if (!panel || repoPath === undefined) {
      return;
    }
    try {
      const model = await this.buildModel(repoPath);
      // `Tab` belongs to the panels — the text buffer has no carousel — so its hint is
      // added here instead of in the key lines the two UIs share.
      model.hints = [...model.hints, ...this.extraHints()];
      this.model = model;
      panel.title = model.title;
      void panel.webview.postMessage({ type: 'model', model });
    } catch (error) {
      void panel.webview.postMessage({
        type: 'notice',
        level: 'error',
        text: (error as Error).message,
      });
    }
  }

  /**
   * The keys the panels add to a screen's own line. `Tab` is the carousel, and every
   * screen but a sub-screen is in it.
   */
  protected extraHints(): HintModel[] {
    return [{ keys: 'tab', label: t('webview.cycle') }];
  }

  /** The model of the screen, once it has been read. */
  protected get screen(): ScreenModel | undefined {
    return this.model;
  }

  /** The panel of this screen, while it is open. */
  protected get view(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  /** The repository this screen shows. */
  protected get repo(): string | undefined {
    return this.repoPath;
  }

  /**
   * A webview asset URL with the file modification time in the query, so a rebuilt
   * stylesheet or script is fetched instead of the copy the webview still holds.
   */
  private assetUri(webview: vscode.Webview, ...segments: string[]): vscode.Uri {
    const file = vscode.Uri.joinPath(this.deps.extensionUri, ...segments);
    let stamp = 0;
    try {
      stamp = Math.floor(fs.statSync(file.fsPath).mtimeMs);
    } catch {
      stamp = 0;
    }
    const uri = webview.asWebviewUri(file);
    return stamp > 0 ? uri.with({ query: `v=${stamp}` }) : uri;
  }

  private html(webview: vscode.Webview): string {
    const script = this.assetUri(webview, 'dist', 'webview-client', 'client', 'main.js');
    const style = this.assetUri(webview, 'media', 'webview', 'style.css');
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>Git Helm</title>
</head>
<body>
<div id="app"></div>
<script type="module" src="${script}"></script>
</body>
</html>`;
  }

  /**
   * Re-reads the panel and the status bar after something changed the repository. The
   * status bar is part of the screen in the buffer version too: staging there updates
   * the counters immediately, so the panel must not lag behind.
   */
  protected async settle(): Promise<void> {
    await this.deps.statusBar();
    await this.refresh();
  }

  dispose(): void {
    this.disposeListeners();
    this.panel?.dispose();
    this.panel = undefined;
  }

  /**
   * `q`: closes the tab and gives the focus to another screen that is open, so the keys
   * of the screens keep working. A panel that closes itself takes the focus with it.
   */
  protected async closePanel(): Promise<void> {
    this.panel?.dispose();
    await this.deps.neighbour(this.kind);
  }

  private disposeListeners(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  private async handle(message: ClientMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.refresh();
      return;
    }
    if (message.type === 'action') {
      await this.onAction(message.action, message.ids);
      return;
    }
    if (message.type === 'screen') {
      await this.runScreen(message.action, message.ids);
      return;
    }
    if (message.type === 'cycle') {
      await this.deps.cycle(this.kind, message.direction, this.repoPath ?? '');
      return;
    }
    if (message.type === 'more') {
      await this.onMore();
      return;
    }
    if (message.type === 'filter') {
      await this.onFilter(message.field, message.value);
      return;
    }
    if (message.type === 'command' && OPENERS.has(message.command)) {
      await vscode.commands.executeCommand(message.command);
    }
  }

  /** The keys every screen has: close the tab and re-read the screen. */
  private async runScreen(action: ScreenAction, ids: string[]): Promise<void> {
    if (!this.panel || this.repoPath === undefined) {
      return;
    }
    if (action === 'close') {
      // The closed tab takes the focus with it; a screen that is still open takes it
      // back, so the keys of the screens keep working instead of needing a click.
      await this.closePanel();
      return;
    }
    if (action === 'refresh') {
      await this.refresh();
      this.deps.notify(t('msg.refreshed'));
      return;
    }
    await this.onScreen(action, ids);
    await this.settle();
  }
}

/** The status screen as a panel: the file sections, the right-hand column, the commits. */
export class StatusWebview extends ScreenPanel {
  constructor(private readonly statusDeps: StatusWebviewDeps) {
    super(statusDeps);
  }

  protected get viewType(): string {
    return 'githelm.webview.status';
  }

  get kind(): ScreenKind {
    return 'status';
  }

  protected async buildModel(repoPath: string): Promise<ScreenModel> {
    const dateFormat = vscode.workspace.getConfiguration('githelm').get<string>('log.dateFormat', '%Y-%m-%d %H:%M');
    const [status, remotes, stashes, worktrees, upstream, history, branches] = await Promise.all([
      readStatus(repoPath),
      listRemotes(repoPath),
      listStashes(repoPath),
      listWorktrees(repoPath),
      readUpstream(repoPath),
      readLog(repoPath, { limit: 10, dateFormat }),
      // The status screen shows the local branches only: remotes are the branches screen's
      // business, and the bottom half is a shortcut, not a second branches screen.
      listBranchEntries(repoPath, false),
    ]);
    // The header names the repository itself, so the model needs no `remote` of its own:
    // the remotes are the column's rows.
    return buildStatusModel({
      repoPath,
      status,
      remotes,
      stashes,
      worktrees,
      commits: history.commits,
      branches,
      ...(upstream ? { upstream } : {}),
    });
  }

  protected override async onAction(action: WebviewAction, ids: string[]): Promise<void> {
    const panel = this.view;
    const repoPath = this.repo;
    const model = this.screen?.kind === 'status' ? this.screen : undefined;
    if (!panel || !repoPath || !model) {
      return;
    }
    if (action === 'close') {
      await this.closePanel();
      return;
    }
    if (action === 'refresh') {
      await this.refresh();
      this.deps.notify(t('msg.refreshed'));
      return;
    }
    // A branch row carries the branches screen's keys: the row under the selection decides,
    // exactly as it does for the right-hand column, so `c` commits everywhere else and
    // checks out here, `m` amends everywhere else and merges here, `n` creates a branch
    // from the selected one instead of adding a worktree, and `G` opens its graph.
    if (
      ids[0]?.startsWith('branch:') &&
      (action === 'checkout' ||
        action === 'create' ||
        action === 'merge' ||
        action === 'reset' ||
        action === 'graph')
    ) {
      await this.statusDeps.runBranch(action, repoPath, ids);
      await this.settle();
      return;
    }
    // A last-commits row borrows the history screen's keys. The row names the commit by
    // its full sha, and `runLog` re-reads it from the object store before acting.
    if (ids[0]?.startsWith('commit:') && COMMIT_ACTIONS.has(action)) {
      await this.statusDeps.runLog(action as ScreenAction, repoPath, ids);
      await this.settle();
      return;
    }
    // A key pressed while a row of the right-hand column is selected belongs to
    // that row: `f` fetches that remote, `x` drops that stash, `Enter` opens that
    // worktree. The host looks the entry up again and runs the buffer's handler.
    // This comes before the repository-wide keys, which `f`, `P` and `U` also are:
    // on a remote row they would ask for a remote the row already named.
    const target = targetOf(ids);
    if (target && TARGET_ACTIONS.has(action)) {
      await this.statusDeps.runTarget(action as TargetAction, repoPath, target);
      await this.settle();
      return;
    }

    if (REPO_ACTIONS.has(action)) {
      // Repository-wide keys ask their own questions and refresh the buffers
      // themselves; the panel only has to re-read what they changed.
      await this.statusDeps.runRepo(action as RepoAction, repoPath);
      await this.settle();
      return;
    }

    // Outside the column the opening keys open the entry, as they do in the buffer.
    const effective: WebviewAction =
      action === 'worktreeWindow' || action === 'worktreeHere' ? 'open' : action;

    const paths = pathsOf(model, ids);
    if (NEEDS_ROWS.has(effective) && paths.length === 0) {
      this.deps.warn(t('msg.cursorNotFile'));
      return;
    }

    switch (effective) {
      case 'delete':
      case 'edit':
      case 'stashApply':
      case 'stashPop': {
        // These act on a row of the column. With nothing selected the buffer says
        // so; with a file row selected it says what the key is for instead.
        if (ids.length === 0) {
          this.deps.warn(t('msg.cursorNotEntry'));
          return;
        }
        if (action === 'delete') {
          this.deps.notify(t('msg.forFiles'));
        } else if (action === 'edit') {
          this.deps.notify(t('msg.notEditable'));
        } else {
          this.deps.warn(t('msg.cursorNotEntry'));
        }
        return;
      }
      case 'open':
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(repoPath, paths[0])), { preview: false });
        return;
      case 'diff':
        await this.statusDeps.openDiff(repoPath, fileTargetsOf(model, ids));
        return;
      case 'stage': {
        if (await this.confirmConflicts(model, ids)) {
          return;
        }
        await stageFiles(repoPath, paths);
        this.deps.notify(t('msg.stagedCount', { count: paths.length }));
        break;
      }
      case 'unstage': {
        await unstageFiles(repoPath, paths);
        this.deps.notify(t('msg.unstagedCount', { count: paths.length }));
        break;
      }
      case 'commit': {
        await this.statusDeps.commit(repoPath);
        return;
      }
      case 'tag': {
        await this.statusDeps.createTag(repoPath);
        await this.settle();
        return;
      }
      case 'stash': {
        // Selected files are stashed on their own; otherwise the whole working tree.
        await this.statusDeps.stash(repoPath, fileTargetsOf(model, ids));
        break;
      }
      case 'discard': {
        const plan = planDiscard(fileTargetsOf(model, ids));
        if (plan.paths.length === 0) {
          this.deps.warn(t('msg.cursorNotFile'));
          return;
        }
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
        await discardPaths(repoPath, plan);
        this.deps.notify(t('msg.discardedCount', { count: plan.paths.length }));
        break;
      }
      case 'ignore': {
        const result = await addToGitignore(repoPath, paths);
        if (result.added.length > 0) {
          this.deps.notify(t('msg.ignoredCount', { count: result.added.length }));
        } else if (result.tracked.length === 0) {
          this.deps.notify(t('msg.ignoredNothing'));
        }
        if (result.tracked.length > 0) {
          this.deps.warn(t('msg.ignoreTracked', { count: result.tracked.length }));
        }
        break;
      }
      case 'stageAll': {
        const pending = model.sections
          .filter((section) => section.kind !== 'staged')
          .flatMap((section) => section.rows.map((row) => row.id));
        if (pending.length === 0) {
          this.deps.notify(t('msg.alreadyStaged'));
          return;
        }
        if (await this.confirmConflicts(model, pending)) {
          return;
        }
        await stageAll(repoPath);
        this.deps.notify(t('msg.stagedCount', { count: pending.length }));
        break;
      }
      case 'unstageAll': {
        const staged = model.sections
          .filter((section) => section.kind === 'staged')
          .flatMap((section) => section.rows);
        if (staged.length === 0) {
          this.deps.notify(t('msg.nothingToUnstage'));
          return;
        }
        await unstageAll(repoPath);
        this.deps.notify(t('msg.unstagedCount', { count: staged.length }));
        break;
      }
      default:
        return;
    }
    // Staging, unstaging, stashing and discarding land here: the repository moved.
    await this.settle();
  }

  /** Staging a conflicted file marks it resolved, so it asks first — as `s` does. */
  private async confirmConflicts(model: StatusModel, ids: readonly string[]): Promise<boolean> {
    if (!sectionsOf(model, ids).has('conflict')) {
      return false;
    }
    const confirmed = await vscode.window.showWarningMessage(t('msg.conflictStage'), { modal: true }, t('action.stage'));
    return confirmed !== t('action.stage');
  }

}

/**
 * A screen that is a list of things — branches, tags — as a panel. The screen itself
 * is a model built from the same git data the text buffer renders, so both UIs say the
 * same thing about a branch or a tag; the keys are the buffer's keys, and the host runs
 * them, which is why `n` still asks for a name and `x` still asks for a confirmation.
 */
export class ListWebview extends ScreenPanel {
  /** `shift+r` in the branches screen: remote branches are hidden until it is pressed. */
  private showRemote = false;

  constructor(
    private readonly listDeps: ListWebviewDeps,
    private readonly list: 'branches' | 'tags' | 'submodules'
  ) {
    super(listDeps);
  }

  protected get viewType(): string {
    return `githelm.webview.${this.list}`;
  }

  get kind(): ScreenKind {
    return this.list;
  }

  protected async buildModel(repoPath: string): Promise<ScreenModel> {
    if (this.list === 'tags') {
      return buildTagsModel(repoPath, await listTags(repoPath));
    }
    if (this.list === 'submodules') {
      const { submodules, error } = await readSubmoduleStatus(repoPath);
      return buildSubmodulesModel(repoPath, submodules, error);
    }
    return buildBranchesModel(repoPath, await listBranchEntries(repoPath, true), this.showRemote);
  }

  protected override async onScreen(action: ScreenAction, ids: string[]): Promise<void> {
    const repoPath = this.repo;
    if (!repoPath) {
      return;
    }
    // The buffer's `shift+r` is display state of the screen, not a git action, so the
    // panel keeps it here and redraws; the same notice says which way it went.
    if (this.list === 'branches' && action === 'toggleRemote') {
      this.showRemote = !this.showRemote;
      await this.refresh();
      this.deps.notify(this.showRemote ? t('msg.remotesShown') : t('msg.remotesHidden'));
      return;
    }
    // `d` asks the same six questions the history screen asks, and answers them without
    // a text buffer: a `log …` answer is that range on the history screen, a `diff …`
    // answer is the built-in multi-diff.
    if (this.list === 'branches' && action === 'compare') {
      await this.compareBranches(ids);
      return;
    }
    // `G` is the graph of the row, which on this screen is a branch: the history screen
    // reads it through its branch filter, so the two screens show one history and not two.
    if (this.list === 'branches' && action === 'graph') {
      const [name] = ids
        .filter((id) => id.startsWith('branch:'))
        .map((id) => id.slice('branch:'.length));
      if (name) {
        await this.listDeps.openLogBranch(repoPath, name);
      }
      return;
    }
    await this.listDeps.run(action, repoPath, ids);
  }

  /**
   * `d` on a branch: one row is compared with HEAD, two rows with each other. The tips
   * are read from the repository rather than from the row, so a branch deleted in another
   * window compares nothing instead of comparing a name that moved.
   */
  private async compareBranches(ids: readonly string[]): Promise<void> {
    const repoPath = this.repo;
    if (!repoPath) {
      return;
    }
    const names = [
      ...new Set(ids.filter((id) => id.startsWith('branch:')).map((id) => id.slice('branch:'.length))),
    ].slice(0, 2);
    const tips: { name: string; sha: string }[] = [];
    for (const name of names) {
      const sha = await refTip(repoPath, name);
      if (sha) {
        tips.push({ name, sha });
      }
    }
    const [left] = tips;
    if (!left) {
      this.deps.notify(t('compare.needRefs'));
      return;
    }
    const right = tips[1];
    const rightSha = right ? right.sha : await headSha(repoPath);
    const rightLabel = right ? right.name : 'HEAD';
    const picked = await vscode.window.showQuickPick(compareChoices(), {
      placeHolder: t('compare.pick', { a: left.name, b: rightLabel }),
    });
    if (!picked) {
      return;
    }
    const plan = await planCompare(repoPath, picked.value, left.sha, rightSha, left.name, rightLabel);
    if (!choiceShowsDiff(picked.value)) {
      // The graph of a range lives on the screen that draws graphs; the range is handed
      // over instead of being copied, so `x` there goes back to the whole history.
      await this.listDeps.openLogRange(repoPath, plan.range, plan.mode === 'three');
      this.deps.notify(t('compare.inPanel', { range: plan.label }));
      return;
    }
    if (!(await openCompareDiff(repoPath, plan))) {
      this.deps.notify(t('compare.noChanges', { range: plan.label }));
    }
  }
}

/**
 * The history screen as a panel: the rows of `git log --graph` as a character grid.
 *
 * The rows, the graph and the columns come from `logRows()` — the buffer's own renderer
 * — so the panel and the buffer cannot disagree about a commit. What the panel owns is
 * the *view*: which filters are set, the order, and how much history has been read. The
 * screen is read a page at a time, so opening it does not walk the whole repository, and
 * scrolling to the end asks for the next page.
 */
export class LogWebview extends ScreenPanel {
  private all = false;
  private filter: LogFilter = {};
  private sort: LogSort = 'topo';
  private range: string | undefined;
  private leftRight: boolean | undefined;
  /** How much history has been read so far: a scroll to the end raises it by a page. */
  private limit = LOG_PAGE;

  constructor(private readonly logDeps: LogWebviewDeps) {
    super(logDeps);
  }

  protected get viewType(): string {
    return 'githelm.webview.log';
  }

  get kind(): ScreenKind {
    return 'log';
  }

  /** Another repository starts from its first page; the same one keeps what was read. */
  override async show(repoPath: string): Promise<void> {
    if (repoPath !== this.repo) {
      this.limit = LOG_PAGE;
    }
    await super.show(repoPath);
  }

  /** The history of one path, the way `githelm.log.fileHistory` reads it in a buffer. */
  async showPath(repoPath: string, relativePath: string): Promise<void> {
    this.filter = { ...this.filter, path: relativePath };
    this.range = undefined;
    this.leftRight = undefined;
    this.limit = LOG_PAGE;
    await this.show(repoPath);
  }

  /**
   * The history of one branch: `G` on the branches screen lands here, so the graph opens
   * with the branch filter filled in and the reader can read the branch's own history,
   * then clear the field to widen it. The rest of the filters are kept — a reader who
   * filtered by author and then asked for a branch means both.
   */
  async showBranch(repoPath: string, branch: string): Promise<void> {
    this.filter = { ...this.filter, branch };
    // A branch is the walk, so every-ref mode and a range step aside: `git log` is given
    // the one revision, and the title says what it was given.
    this.all = false;
    this.range = undefined;
    this.leftRight = undefined;
    this.limit = LOG_PAGE;
    await this.show(repoPath);
  }

  /**
   * The screen over a range instead of the branch history: `d` on the branches screen
   * hands its `log …` answer here, so both screens read one range on one screen. `x`
   * clears it, exactly as after `d` on a commit.
   */
  async showRange(repoPath: string, range: string, leftRight: boolean): Promise<void> {
    // A range is the walk, so a branch filter has nothing left to narrow: it is dropped
    // rather than left in its input, where it would claim a say it does not have.
    const { branch: _branch, ...rest } = this.filter;
    this.filter = rest;
    this.range = range;
    this.leftRight = leftRight ? true : undefined;
    this.limit = LOG_PAGE;
    await this.show(repoPath);
  }

  protected async buildModel(repoPath: string): Promise<ScreenModel> {
    // The same two settings the buffer reads, so a custom date column or `--all`'s
    // custom refs read alike in both UIs.
    const configuration = vscode.workspace.getConfiguration('githelm');
    const parsed = await readLog(repoPath, {
      ...(this.range ? { range: this.range } : { all: this.all }),
      ...(this.leftRight ? { leftRight: true } : {}),
      filter: this.filter,
      sort: this.sort,
      limit: this.limit,
      dateFormat: configuration.get<string>('log.dateFormat', '%Y-%m-%d %H:%M'),
      includeAllRefs: configuration.get<boolean>('log.includeAllRefs', false),
    });
    return buildLogModel({
      repoPath,
      parsed,
      all: this.all,
      filter: this.filter,
      sort: this.sort,
      range: this.range,
      leftRight: this.leftRight,
      limit: this.limit,
    });
  }

  protected override async onScreen(action: ScreenAction, ids: string[]): Promise<void> {
    const repoPath = this.repo;
    if (!repoPath) {
      return;
    }
    // The keys that only change what the screen shows stay here, exactly as the branches
    // screen keeps `shift+r` to itself: they are view state, not git actions.
    if (action === 'toggleAll') {
      // `a` and a branch filter answer the same question — which walk is this history — so
      // whichever the reader asked for last wins: with a branch set, `a` lifts it and turns
      // every ref on instead of being a key that does nothing.
      const asked = this.filter.branch !== undefined;
      const { branch: _branch, ...rest } = this.filter;
      this.filter = rest;
      this.all = asked ? true : !this.all;
      await this.refresh();
      // The buffer's `a` only redraws, so the panel only redraws.
      return;
    }
    if (action === 'sort') {
      const order: LogSort[] = ['topo', 'date', 'author-date'];
      this.sort = order[(order.indexOf(this.sort) + 1) % order.length];
      await this.refresh();
      const label = this.sort === 'topo' ? t('sort.topo') : this.sort === 'date' ? t('sort.date') : t('sort.authorDate');
      this.deps.notify(t('msg.sorted', { sort: label }));
      return;
    }
    if (action === 'resetFilters') {
      this.filter = {};
      this.range = undefined;
      this.leftRight = undefined;
      await this.refresh();
      this.deps.notify(t('msg.updated'));
      return;
    }
    // `d` asks the buffer's six questions, but the answer is shown here: a range is a
    // different history read of the same screen, and a diff opens the built-in editor
    // instead of a githelm buffer — the panel never drops the reader into a text buffer.
    if (action === 'compare') {
      await this.compare(ids);
      return;
    }
    await this.logDeps.run(action, repoPath, ids);
  }

  /**
   * `d`: one row compared with `HEAD`, two rows with each other.
   *
   * The six choices — and their wording — are the buffer's, read from `compareChoices()`.
   * A `log-*` choice becomes this panel's range: the title says `A..B`, the rows are the
   * commits the buffer's compare window would draw, and `x` goes back to the full
   * history. A `diff-*` choice is a side-by-side of the two trees, which the built-in
   * diff editor does better than the panel could, so it opens there — one multi-diff
   * tab, the same view the status screen's `d` opens.
   */
  private async compare(ids: readonly string[]): Promise<void> {
    const repoPath = this.repo;
    if (!repoPath) {
      return;
    }
    const seen = new Set<string>();
    const commits: LogCommit[] = [];
    for (const id of ids) {
      const sha = id.startsWith('commit:') ? id.slice('commit:'.length) : undefined;
      if (!sha || seen.has(sha)) {
        continue;
      }
      seen.add(sha);
      // Re-read from the object store: the id names a commit, it is not the commit.
      const commit = await commitBySha(repoPath, sha);
      if (commit) {
        commits.push(commit);
      }
    }
    if (commits.length === 0) {
      this.deps.notify(t('compare.needCommits'));
      return;
    }
    const [left, right] = commits;
    const head = right ? right.sha : await headSha(repoPath);
    const rightLabel = right ? right.shortSha : 'HEAD';
    const picked = await vscode.window.showQuickPick(compareChoices(), {
      placeHolder: t('compare.pick', { a: left.shortSha, b: rightLabel }),
    });
    if (!picked) {
      return;
    }
    // Swapping the sides is swapping the range, not a second implementation of it.
    const plan = await planCompare(repoPath, picked.value, left.sha, head, left.shortSha, rightLabel);
    if (!choiceShowsDiff(picked.value)) {
      this.range = plan.range;
      this.leftRight = plan.mode === 'three' ? true : undefined;
      // A range is another history, not another page of this one.
      this.limit = LOG_PAGE;
      await this.refresh();
      this.deps.notify(t('compare.inPanel', { range: plan.label }));
      return;
    }
    if (!(await openCompareDiff(repoPath, plan))) {
      this.deps.notify(t('compare.noChanges', { range: plan.label }));
    }
  }

  /**
   * A submitted filter input: the field holds the value, an empty value clears it. The
   * panel keeps the filter set and re-reads, so what the input asks for is exactly what
   * `git log` is asked for; a field name that is not a filter is ignored, since the
   * value comes from the DOM.
   */
  protected override async onFilter(field: string, value: string): Promise<void> {
    if (!this.repo || !(FILTER_FIELDS as readonly string[]).includes(field)) {
      return;
    }
    const trimmed = value.trim();
    // Re-reading an unchanged filter would throw the reader back to the top of the page
    // for nothing: typing the same value again is not a change — and it is not a name to
    // look up again either.
    if ((this.filter[field as FilterField] ?? '') === trimmed) {
      return;
    }
    // A branch is a revision, not a pattern: a name that resolves to nothing would send
    // `git log` a fatal error instead of an empty history, so it is answered here — and
    // the input is redrawn from the filter that is still set, not left holding the typo.
    if (field === 'branch' && trimmed.length > 0 && !(await revisionExists(this.repo, trimmed))) {
      this.deps.notify(t('log.branchMissing', { branch: trimmed }));
      await this.refresh();
      return;
    }
    const next: LogFilter = { ...this.filter };
    const writable = next as Record<string, string | undefined>;
    if (trimmed.length > 0) {
      writable[field as FilterField] = trimmed;
    } else {
      delete writable[field as FilterField];
    }
    // A branch is the walk, so `a` — the walk of every ref — is turned off with it; the
    // title would otherwise claim every branch while `git log` is given one.
    if (field === 'branch') {
      this.all = false;
    }
    this.filter = next;
    await this.refresh();
  }

  /** The end of the page is in sight: read the next one and push the longer history. */
  protected override async onMore(): Promise<void> {
    if (!this.repo) {
      return;
    }
    this.limit += LOG_PAGE;
    await this.refresh();
  }
}

/**
 * The action log as a panel. It is the one screen that is not a screen of a repository:
 * it lists what the extension ran, wherever it ran it, so its model takes no path and
 * the panel is opened with the empty one — which is also what keeps `repoIfVisible()`
 * from claiming a repository the host could act on.
 *
 * Only `c` goes back to the host: clearing asks the same question the buffer asks and
 * empties the same log, so the two UIs cannot disagree about what is left.
 */
export interface ActionLogWebviewDeps extends ScreenPanelDeps {
  clear: () => Promise<void>;
}

export class ActionLogWebview extends ScreenPanel {
  constructor(private readonly logDeps: ActionLogWebviewDeps) {
    super(logDeps);
  }

  protected get viewType(): string {
    return 'githelm.webview.actionlog';
  }

  get kind(): ScreenKind {
    return 'actionlog';
  }

  protected async buildModel(): Promise<ScreenModel> {
    return buildActionLogModel();
  }

  protected override async onScreen(action: ScreenAction): Promise<void> {
    if (action === 'clearLog') {
      await this.logDeps.clear();
    }
  }
}


/**
 * A sub-screen: one document, one panel. The commit view, a stash's files, a conflict and
 * a file's history are documents of their own — several can be open at once, each with
 * its own `viewType` and its own identity — so the host keeps one of these per document
 * instead of one per screen.
 *
 * The panel does not render the document itself: `textOf`/`spansOf` hand it the buffer's
 * own text and spans, so a patch reads exactly the same in both UIs and the keys keep
 * meaning the same thing (`s` stages the selected rows or the hunk under a single row).
 */
export interface DocWebviewDeps extends ScreenPanelDeps {
  /** The document's text, as the buffer rendered it. */
  textOf: (uri: vscode.Uri) => string | undefined;
  /** The document's spans, as the buffer rendered them. */
  spansOf: (uri: vscode.Uri) => Span[];
  /**
   * Re-reads the document from `git` without opening a tab: `r`, and every refresh after
   * the panel changed the repository itself.
   */
  reload: (uri: vscode.Uri) => Promise<void>;
  /** The name the tab shows: the file, or the commit and its subject. */
  titleOf: (uri: vscode.Uri) => string;
  /**
   * The lists a header stands for, in 0-based document lines: the `## files (n)` line and
   * the lines under it that name a file. A click on the header selects the whole list, so
   * `d` is one diff of every file. Absent for a document that is not a list.
   */
  groupsOf?: (uri: vscode.Uri) => DocModelGroup[] | undefined;

  /** Runs one key of the sub-screen on the document and the selected rows. */
  run: (action: ScreenAction, uri: vscode.Uri, lines: number[]) => Promise<void>;
  /** The panel closed: the host drops its entry so the next `Enter` opens a fresh one. */
  forget: (uri: vscode.Uri) => void;
}

export class DocWebview extends ScreenPanel {
  private gone = false;

  constructor(
    private readonly docDeps: DocWebviewDeps,
    private readonly doc: DocKind,
    private readonly uri: vscode.Uri
  ) {
    super(docDeps);
  }

  protected get viewType(): string {
    return `githelm.webview.${this.doc}`;
  }

  get kind(): DocKind {
    return this.doc;
  }

  get document(): vscode.Uri {
    return this.uri;
  }

  /** A sub-screen is not in the carousel, so `Tab` has nothing to add. */
  protected override extraHints(): HintModel[] {
    return [];
  }

  /** `r` re-reads the document from `git`, not just the text already in the document. */
  override async refresh(): Promise<void> {
    try {
      await this.docDeps.reload(this.uri);
    } catch (error) {
      this.deps.warn(`${t('app.name')}: ${(error as Error).message}`);
    }
    await super.refresh();
  }

  protected async buildModel(): Promise<ScreenModel> {
    const text = this.docDeps.textOf(this.uri);
    if (text === undefined) {
      throw new Error(t('msg.notDiff'));
    }
    return buildDocModel({
      screen: this.doc,
      title: this.docDeps.titleOf(this.uri),
      text,
      spans: this.docDeps.spansOf(this.uri),
      groups: this.docDeps.groupsOf?.(this.uri),
      selectFirst: t('webview.selectFirst'),
      emptyText: t('diff.empty', { mode: '' }).trim(),
    });
  }

  protected override async onScreen(action: ScreenAction, ids: string[]): Promise<void> {
    await this.docDeps.run(action, this.uri, lineNumbersOf(ids));
  }

  override dispose(): void {
    super.dispose();
    if (!this.gone) {
      this.gone = true;
      this.docDeps.forget(this.uri);
    }
  }
}

