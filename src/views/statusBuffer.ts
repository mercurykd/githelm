import * as vscode from 'vscode';
import { actionLabel, formatClock, recentActions } from '../git/actionLog';
import { readLog } from '../git/log';
import { listRemotes, readUpstream } from '../git/remotes';
import { findRepoRoot, normalizePath, repoDisplayName } from '../git/repo';
import { listLfsFiles } from '../git/lfs';
import { listStashes } from '../git/stash';
import { readSubmodules } from '../git/submodules';
import { RepoStatus, readStatus } from '../git/status';
import { listWorktrees } from '../git/worktree';
import { Highlighter } from './highlight';
import {
  RenderedStatus,
  renderStatus,
  renderUninitialized,
  ResolvedTargets,
  resolveSelections as resolveTargetSelections,
  resolveTargets,
  StatusExtras,
  StatusTarget,
  targetAtCell,
} from './statusRender';
import { SCHEME, VirtualDocuments } from './virtualDocs';

/** Status shape used for a folder that is not a repository yet. */
const EMPTY_STATUS: RepoStatus = { ahead: 0, behind: 0, entries: [] };

export interface StatusState {
  uri: vscode.Uri;
  /**
   * The folder this buffer was opened for, in one canonical spelling. Re-renders
   * key the document by *this*, not by the repository root: the root arrives from
   * git (`D:/x`) while the buffer may have been opened for a folder (`D:\x`), and
   * a URI built from the other spelling updates a document nobody is looking at.
   */
  folder: string;
  /** Repository root, or the folder itself when it is not a repository yet. */
  repoPath: string;
  status: RepoStatus;
  rendered: RenderedStatus;
  initialized: boolean;
}

export type { StatusTarget, RenderedStatus } from './statusRender';

export class StatusBuffer {
  private readonly states = new Map<string, StatusState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string): vscode.Uri {
    const folder = normalizePath(repoPath);
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/status/${repoDisplayName(folder)}`,
      query: encodeURIComponent(folder),
    });
  }

  stateFor(uri: vscode.Uri): StatusState | undefined {
    return this.states.get(uri.toString());
  }

  repoForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/status/')) {
      return undefined;
    }
    const state = this.stateFor(uri);
    if (state) {
      return state.initialized ? state.repoPath : undefined;
    }
    return decodeURIComponent(uri.query);
  }

  /** The folder behind a status buffer, repository or not (used by `git init`). */
  folderForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/status/')) {
      return undefined;
    }
    return this.stateFor(uri)?.folder ?? normalizePath(decodeURIComponent(uri.query));
  }

  /**
   * Target under the cursor. Two sections can share a line (`remotes` next to
   * `worktrees`), so the column picks the cell.
   */
  targetAt(uri: vscode.Uri, line: number, character?: number): StatusTarget | undefined {
    const state = this.stateFor(uri);
    return state ? targetAtCell(state.rendered, line, character) : undefined;
  }

  /** Resolves a cursor position or selection into the entries an action applies to. */
  resolveFor(uri: vscode.Uri, fromLine: number, toLine: number): ResolvedTargets | undefined {
    const state = this.stateFor(uri);
    return state ? resolveTargets(state.rendered, fromLine, toLine) : undefined;
  }

  /** Same as `resolveFor`, for every cursor of the editor (multi-cursor included). */
  resolveAll(uri: vscode.Uri, selections: readonly vscode.Selection[]): ResolvedTargets | undefined {
    const state = this.stateFor(uri);
    if (!state) {
      return undefined;
    }
    return resolveTargetSelections(
      state.rendered,
      selections.map((selection) => ({
        fromLine: selection.start.line + 1,
        toLine: selection.end.line + 1,
        // A one-line cursor carries its column: a line of the status screen can
        // hold a file row and a cell of the right-hand column at the same time.
        character: selection.start.line === selection.end.line ? selection.active.character : undefined,
      }))
    );
  }

  async open(folderPath: string): Promise<vscode.TextEditor> {
    await this.render(folderPath);

    const uri = StatusBuffer.uriFor(folderPath);
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  async refresh(uri: vscode.Uri, cursorLine?: number): Promise<void> {
    const state = this.stateFor(uri);
    const folderPath = state?.folder ?? decodeURIComponent(uri.query);
    await this.render(folderPath);
    if (cursorLine !== undefined) {
      placeCursor(uri, cursorLine);
    }
  }

  /** Re-renders every open status buffer (one git round per distinct repo). */
  async refreshAll(): Promise<void> {
    const folders = new Set<string>();
    for (const state of this.states.values()) {
      folders.add(state.folder);
    }
    for (const folderPath of folders) {
      await this.render(folderPath);
    }
  }

  /**
   * Renders the status screen for `folderPath`. A folder without a repository
   * gets the `git init` screen instead of an error: the repository may appear
   * later (the user runs `git init` or opens a subfolder of one), and the check
   * runs on every render for exactly that reason.
   */
  private async render(folderPath: string): Promise<void> {
    const folder = normalizePath(folderPath);
    const repoPath = await findRepoRoot(folder);
    const uri = StatusBuffer.uriFor(folder);

    if (!repoPath) {
      const rendered = renderUninitialized(folder);
      this.states.set(uri.toString(), {
        uri,
        folder,
        repoPath: folder,
        status: EMPTY_STATUS,
        rendered,
        initialized: false,
      });
      this.docs.set(uri, rendered.text);
      this.highlighter.setSpans(uri, rendered.spans);
      return;
    }

    const dateFormat = vscode.workspace.getConfiguration('githelm').get<string>('log.dateFormat', '%Y-%m-%d %H:%M');
    const [status, stashes, remotes, upstream, history, worktrees, lfs, submodules] = await Promise.all([
      readStatus(repoPath),
      listStashes(repoPath),
      listRemotes(repoPath),
      readUpstream(repoPath),
      readLog(repoPath, { limit: 10, dateFormat }),
      listWorktrees(repoPath),
      listLfsFiles(repoPath),
      readSubmodules(repoPath),
    ]);

    const commits = history.commits.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.shortSha,
      date: commit.date,
      author: commit.author,
      subject: commit.subject,
      refs: commit.refs,
    }));
    const remoteName = upstream?.ref.split('/')[0];
    const tracked = remoteName ? remotes.find((entry) => entry.name === remoteName) : undefined;
    const extras: StatusExtras = {
      stashes,
      remotes,
      worktrees,
      commits,
      lfs,
      submodules,
      ...(upstream ? { upstream } : {}),
      ...(tracked ? { remote: { name: tracked.name, url: tracked.url } } : {}),
    };
    const recent = recentActions(50).map((record) => `${formatClock(record.at)}  ${actionLabel(record)}`);
    const rendered = renderStatus(repoPath, status, extras, recent);

    this.states.set(uri.toString(), { uri, folder, repoPath, status, rendered, initialized: true });
    this.docs.set(uri, rendered.text);
    this.highlighter.setSpans(uri, rendered.spans);
  }
}

function placeCursor(uri: vscode.Uri, cursorLine: number): void {
  const editor = vscode.window.visibleTextEditors.find(
    (candidate) => candidate.document.uri.toString() === uri.toString()
  );
  if (!editor) {
    return;
  }
  const line = Math.min(cursorLine, Math.max(0, editor.document.lineCount - 1));
  editor.selection = new vscode.Selection(line, 0, line, 0);
}
