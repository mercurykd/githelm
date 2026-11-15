import * as vscode from 'vscode';
import { allActions, clearActions, formatAction, formatClock } from '../git/actionLog';
import { t } from '../i18n';
import { Highlighter } from './highlight';
import { withHints } from './columns';
import { SCHEME, VirtualDocuments } from './virtualDocs';

/** Read-only screen with every git command the extension executed. */
export class ActionLogBuffer {
  private readonly refs = new Map<string, vscode.Uri>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: '/actionlog', query: '' });
  }

  isActionLog(uri: vscode.Uri): boolean {
    return uri.scheme === SCHEME && uri.path.startsWith('/actionlog');
  }

  async open(): Promise<vscode.TextEditor> {
    const uri = ActionLogBuffer.uriFor();
    this.refs.set(uri.toString(), uri);
    this.render(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  async refresh(uri: vscode.Uri, cursorLine: number): Promise<void> {
    this.render(uri);
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === uri.toString()
    );
    if (editor) {
      const line = Math.min(cursorLine, Math.max(0, editor.document.lineCount - 1));
      editor.selection = new vscode.Selection(line, 0, line, 0);
    }
  }

  async clear(uri: vscode.Uri): Promise<void> {
    clearActions();
    await this.refresh(uri, 2);
  }

  private render(uri: vscode.Uri): void {
    // Newest first: the last thing that happened is what you look for.
    const records = [...allActions()].reverse();
    const lines: string[] = [];
    lines.push(t('actionLog.title'));
    lines.push(t('actionLog.count', { count: records.length }));
    lines.push('');

    for (const record of records) {
      lines.push(`  ${formatClock(record.at)}  ${formatAction(record)}`);
    }
    if (records.length === 0) {
      lines.push(`  ${t('actionLog.empty')}`);
    }

    lines.push('');
    const decorated = withHints(`${lines.join('\n')}\n`, t('actionLog.keys'), t('status.keysHeader'));
    this.docs.set(uri, decorated.text);
    this.highlighter.setSpans(uri, decorated.spans);
  }
}
