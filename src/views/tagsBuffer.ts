import * as vscode from 'vscode';
import { repoDisplayName } from '../git/repo';
import { listTags, TagEntry } from '../git/tags';
import { Highlighter } from './highlight';
import { renderTags } from './tagsRender';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface TagsState {
  uri: vscode.Uri;
  repoPath: string;
  targets: Map<number, TagEntry>;
}

export class TagsBuffer {
  private readonly states = new Map<string, TagsState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/tags/${repoDisplayName(repoPath)}`,
      query: encodeURIComponent(repoPath),
    });
  }

  stateFor(uri: vscode.Uri): TagsState | undefined {
    return this.states.get(uri.toString());
  }

  repoForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/tags/')) {
      return undefined;
    }
    return this.stateFor(uri)?.repoPath ?? decodeURIComponent(uri.query);
  }

  tagAt(uri: vscode.Uri, line: number): TagEntry | undefined {
    return this.stateFor(uri)?.targets.get(line);
  }

  async open(repoPath: string): Promise<vscode.TextEditor> {
    await this.render(repoPath);
    const uri = TagsBuffer.uriFor(repoPath);
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
    await this.render(repoPath);
    placeCursor(uri, cursorLine);
  }

  private async render(repoPath: string): Promise<void> {
    const tags = await listTags(repoPath);
    const uri = TagsBuffer.uriFor(repoPath);
    const rendered = renderTags(repoPath, tags);
    this.states.set(uri.toString(), { uri, repoPath, targets: rendered.targets });
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
