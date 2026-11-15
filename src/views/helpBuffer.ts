import * as vscode from 'vscode';
import { Span } from '../util/span';
import { helpText } from './helpText';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

/** Read-only buffer with the key map for the screen it was opened from. */
export class HelpBuffer {
  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(view: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/help/${view}` });
  }

  /** Screen name encoded in the URI, used to render the right key map. */
  static viewOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/help/')) {
      return undefined;
    }
    return uri.path.slice('/help/'.length);
  }

  /** Re-renders a restored help tab after an extension-host restart. */
  async restore(uri: vscode.Uri): Promise<void> {
    const view = HelpBuffer.viewOf(uri);
    if (!view) {
      return;
    }
    this.docs.set(uri, helpText(view));
  }

  async open(view: string): Promise<vscode.TextEditor> {
    const uri = HelpBuffer.uriFor(view);
    const text = helpText(view);
    this.docs.set(uri, text);

    const spans: Span[] = [{ line: 0, start: 0, end: text.split('\n')[0].length, kind: 'title' }];
    const lines = text.split('\n');
    for (let line = 0; line < lines.length; line++) {
      const value = lines[line];
      if (/^\s{2}\S/.test(value) && line > 0) {
        const keyEnd = value.indexOf('  ', 2);
        const end = keyEnd > 0 ? keyEnd : value.length;
        spans.push({ line, start: 2, end, kind: 'branch' });
      }
      if (value.includes('Esc или q')) {
        spans.push({ line, start: 0, end: value.length, kind: 'help' });
      }
    }
    this.highlighter.setSpans(uri, spans);

    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: false });
  }
}
