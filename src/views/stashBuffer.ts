import * as vscode from 'vscode';
import { t } from '../i18n';
import { repoDisplayName } from '../git/repo';
import { stashFiles } from '../git/stash';
import { Span } from '../util/span';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface StashViewState {
  uri: vscode.Uri;
  repoPath: string;
  ref: string;
  targets: Map<number, string>;
}

/** File list of one stash: `d` opens the diff for the file under the cursor. */
export class StashBuffer {
  private readonly states = new Map<string, StashViewState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string, ref: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/stashfiles/${repoDisplayName(repoPath)}/${ref}`,
      query: encodeURIComponent(`${repoPath}#${ref}`),
    });
  }

  stateFor(uri: vscode.Uri): StashViewState | undefined {
    return this.states.get(uri.toString());
  }

  fileAt(uri: vscode.Uri, line: number): string | undefined {
    return this.states.get(uri.toString())?.targets.get(line);
  }

  async open(repoPath: string, ref: string): Promise<vscode.TextEditor> {
    await this.render(repoPath, ref);
    const uri = StashBuffer.uriFor(repoPath, ref);
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  async refresh(uri: vscode.Uri, cursorLine: number): Promise<void> {
    const state = this.states.get(uri.toString());
    const query = decodeURIComponent(uri.query);
    const separator = query.lastIndexOf('#');
    const repoPath = state?.repoPath ?? query.slice(0, separator);
    const ref = state?.ref ?? query.slice(separator + 1);
    await this.render(repoPath, ref);
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === uri.toString()
    );
    if (editor) {
      const line = Math.min(cursorLine, Math.max(0, editor.document.lineCount - 1));
      editor.selection = new vscode.Selection(line, 0, line, 0);
    }
  }

  private async render(repoPath: string, ref: string): Promise<void> {
    const files = await stashFiles(repoPath, ref);
    const uri = StashBuffer.uriFor(repoPath, ref);

    const lines: string[] = [];
    const targets = new Map<number, string>();
    const spans: Span[] = [];

    const title = `${ref} — ${repoDisplayName(repoPath)}`;
    lines.push(title);
    spans.push({ line: 0, start: 0, end: title.length, kind: 'title' });

    const header = `## ${t('stash.files')} (${files.length})`;
    lines.push(header);
    spans.push({ line: 1, start: 0, end: header.length, kind: 'section' });
    lines.push(`  ${t('hints.stashFiles')}`);
    spans.push({ line: 2, start: 2, end: 2 + t('hints.stashFiles').length, kind: 'help' });
    lines.push('');

    for (const file of files) {
      const lineNumber = lines.length + 1;
      const text = `  ${file.status.padEnd(2)} ${file.path}`;
      lines.push(text);
      targets.set(lineNumber, file.path);
      spans.push({ line: lineNumber - 1, start: 2, end: 3, kind: 'file-modified' });
      spans.push({ line: lineNumber - 1, start: 5, end: text.length, kind: 'path' });
    }

    this.states.set(uri.toString(), { uri, repoPath, ref, targets });
    this.docs.set(uri, `${lines.join('\n')}\n`);
    this.highlighter.setSpans(uri, spans);
  }
}
