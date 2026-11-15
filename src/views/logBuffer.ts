import * as vscode from 'vscode';
import { LogFilter, LogCommit, LogSort, ParsedLog, readLog } from '../git/log';
import { Highlighter } from './highlight';
import { repoDisplayName } from '../git/repo';
import { renderLog } from './logRender';
import type { FilterField } from './logRender';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export { FILTER_FIELDS, filterHint, logKeys } from './logRender';
export type { FilterField } from './logRender';

export interface LogState {
  uri: vscode.Uri;
  repoPath: string;
  all: boolean;
  filter: LogFilter;
  sort: LogSort;
  range?: string;
  leftRight?: boolean;
  parsed: ParsedLog;
  commitsByLine: Map<number, LogCommit>;
  fieldLines: Map<number, FilterField>;
}


export class LogBuffer {
  private readonly states = new Map<string, LogState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/log/${repoDisplayName(repoPath)}`,
      query: encodeURIComponent(repoPath),
    });
  }

  stateFor(uri: vscode.Uri): LogState | undefined {
    return this.states.get(uri.toString());
  }

  repoForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/log/')) {
      return undefined;
    }
    return this.stateFor(uri)?.repoPath ?? decodeURIComponent(uri.query);
  }

  commitAt(uri: vscode.Uri, line: number): LogCommit | undefined {
    return this.stateFor(uri)?.commitsByLine.get(line);
  }

  fieldAt(uri: vscode.Uri, line: number): FilterField | undefined {
    return this.stateFor(uri)?.fieldLines.get(line);
  }

  async open(repoPath: string, all = false, filter: LogFilter = {}, sort: LogSort = 'topo'): Promise<vscode.TextEditor> {
    const uri = LogBuffer.uriFor(repoPath);
    await this.render(repoPath, all, filter, sort);

    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    const state = this.stateFor(uri);
    const firstCommitLine = state ? ([...state.commitsByLine.keys()][0] ?? 1) : 1;
    const line = Math.max(0, firstCommitLine - 1);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    return editor;
  }

  /** Re-renders every open history buffer (used after fetch/pull/push). */
  async refreshAll(): Promise<void> {
    for (const state of [...this.states.values()]) {
      await this.render(state.repoPath, state.all, state.filter, state.sort, state.range, state.leftRight);
    }
  }

  async refresh(uri: vscode.Uri, cursorLine: number): Promise<void> {
    const state = this.stateFor(uri);
    const repoPath = state?.repoPath ?? decodeURIComponent(uri.query);
    await this.render(repoPath, state?.all ?? false, state?.filter ?? {}, state?.sort ?? 'topo', state?.range, state?.leftRight);
    placeCursor(uri, cursorLine);
  }

  async toggleAll(uri: vscode.Uri, cursorLine: number): Promise<boolean> {
    const state = this.stateFor(uri);
    if (!state) {
      return false;
    }
    state.all = !state.all;
    await this.render(state.repoPath, state.all, state.filter, state.sort);
    placeCursor(uri, cursorLine);
    return state.all;
  }

  /** Drops every filter and the compared range, going back to plain history. */
  async resetFilters(uri: vscode.Uri, cursorLine: number): Promise<void> {
    const state = this.stateFor(uri);
    if (!state) {
      return;
    }
    state.filter = {};
    state.range = undefined;
    state.leftRight = undefined;
    await this.render(state.repoPath, state.all, {}, state.sort);
    placeCursor(uri, cursorLine);
  }

  async setFilter(uri: vscode.Uri, filter: LogFilter, cursorLine: number): Promise<void> {
    const state = this.stateFor(uri);
    if (!state) {
      return;
    }
    state.filter = filter;
    await this.render(state.repoPath, state.all, state.filter, state.sort);
    placeCursor(uri, cursorLine);
  }

  /** Cycles graph order -> date -> author date. */
  async toggleSort(uri: vscode.Uri, cursorLine: number): Promise<LogSort> {
    const state = this.stateFor(uri);
    if (!state) {
      return 'topo';
    }
    const order: LogSort[] = ['topo', 'date', 'author-date'];
    state.sort = order[(order.indexOf(state.sort) + 1) % order.length];
    await this.render(state.repoPath, state.all, state.filter, state.sort, state.range, state.leftRight);
    placeCursor(uri, cursorLine);
    return state.sort;
  }

  /** History of a commit range, used by the compare menu. */
  async openCompare(repoPath: string, range: string, leftRight: boolean): Promise<vscode.TextEditor> {
    const uri = LogBuffer.uriFor(repoPath);
    await this.render(repoPath, false, {}, 'topo', range, leftRight);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const state = this.stateFor(uri);
    const firstCommitLine = state ? ([...state.commitsByLine.keys()][0] ?? 1) : 1;
    const line = Math.max(0, firstCommitLine - 1);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    return editor;
  }

  private async render(repoPath: string, all: boolean, filter: LogFilter, sort: LogSort, range?: string, leftRight?: boolean): Promise<void> {
    const uri = LogBuffer.uriFor(repoPath);
    const configuration = vscode.workspace.getConfiguration('githelm');
    const dateFormat = configuration.get<string>('log.dateFormat', '%Y-%m-%d %H:%M');
    const includeAllRefs = configuration.get<boolean>('log.includeAllRefs', false);
    const parsed = await readLog(repoPath, {
      ...(range ? { range } : { all }),
      ...(leftRight ? { leftRight } : {}),
      filter,
      sort,
      dateFormat,
      includeAllRefs,
    });

    const rendered = renderLog(parsed, { repoPath, all, filter, sort, range, leftRight });

    this.states.set(uri.toString(), {
      uri,
      repoPath,
      all,
      filter,
      sort,
      range,
      leftRight,
      parsed,
      commitsByLine: rendered.commitsByLine,
      fieldLines: rendered.fieldLines,
    });
    this.docs.set(uri, `${rendered.lines.join('\n')}\n`);
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
