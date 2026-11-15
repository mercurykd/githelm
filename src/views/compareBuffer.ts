import * as vscode from 'vscode';
import { t } from '../i18n';
import { repoDisplayName } from '../git/repo';
import { withHints } from './columns';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

/** Read-only buffer for a commit range diff (`A..B` / `A...B`). */
export class CompareBuffer {
  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string, slug: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/compare/${repoDisplayName(repoPath)}/${slug}`,
      query: encodeURIComponent(repoPath),
    });
  }

  async open(repoPath: string, range: string, text: string, column?: number): Promise<vscode.TextEditor> {
    const uri = CompareBuffer.uriFor(repoPath, range.replace(/[^\w.-]+/g, '_'));
    const decorated = withHints(text, t('diff.keys'), t('status.keysHeader'), column);
    this.docs.set(uri, decorated.text);
    this.highlighter.setSpans(uri, decorated.spans);

    let document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId !== 'diff') {
      document = await vscode.languages.setTextDocumentLanguage(document, 'diff');
    }
    return vscode.window.showTextDocument(document, { preview: false });
  }
}
