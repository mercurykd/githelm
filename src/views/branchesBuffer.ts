import * as vscode from 'vscode';
import { BranchEntry, listBranchEntries } from '../git/actions';
import { repoDisplayName } from '../git/repo';
import { branchesKeys, renderBranches } from './branchesRender';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface BranchesState {
  uri: vscode.Uri;
  repoPath: string;
  showRemote: boolean;
  targets: Map<number, BranchEntry>;
}

export class BranchesBuffer {
  private readonly states = new Map<string, BranchesState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/branches/${repoDisplayName(repoPath)}`,
      query: encodeURIComponent(repoPath),
    });
  }

  stateFor(uri: vscode.Uri): BranchesState | undefined {
    return this.states.get(uri.toString());
  }

  repoForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/branches/')) {
      return undefined;
    }
    return this.stateFor(uri)?.repoPath ?? decodeURIComponent(uri.query);
  }

  branchAt(uri: vscode.Uri, line: number): BranchEntry | undefined {
    return this.stateFor(uri)?.targets.get(line);
  }

  async open(repoPath: string, showRemote = false): Promise<vscode.TextEditor> {
    await this.render(repoPath, showRemote);
    const uri = BranchesBuffer.uriFor(repoPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const first = this.stateFor(uri)?.targets.keys().next();
    const line = first && !first.done ? Math.max(0, first.value - 1) : 0;
    editor.selection = new vscode.Selection(line, 0, line, 0);
    return editor;
  }

  async refresh(uri: vscode.Uri, cursorLine: number): Promise<void> {
    const state = this.stateFor(uri);
    const repoPath = state?.repoPath ?? decodeURIComponent(uri.query);
    const showRemote = state?.showRemote ?? false;
    await this.render(repoPath, showRemote);
    placeCursor(uri, cursorLine);
  }

  async toggleRemote(uri: vscode.Uri, cursorLine: number): Promise<boolean> {
    const state = this.stateFor(uri);
    if (!state) {
      return false;
    }
    state.showRemote = !state.showRemote;
    await this.render(state.repoPath, state.showRemote);
    placeCursor(uri, cursorLine);
    return state.showRemote;
  }

  private async render(repoPath: string, showRemote: boolean): Promise<void> {
    const entries = await listBranchEntries(repoPath, showRemote);
    const uri = BranchesBuffer.uriFor(repoPath);
    const rendered = renderBranches(repoPath, entries, showRemote);

    this.states.set(uri.toString(), { uri, repoPath, showRemote, targets: rendered.targets });
    this.docs.set(uri, rendered.text);
    this.highlighter.setSpans(uri, rendered.spans);
  }
}

export { branchesKeys };

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
