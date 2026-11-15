import * as vscode from 'vscode';
import { showCommit } from '../git/actions';
import { repoDisplayName } from '../git/repo';
import { commitSpans } from '../util/span';
import { Highlighter } from './highlight';
import { withHints } from './columns';
import { t } from '../i18n';
import { SCHEME, VirtualDocuments } from './virtualDocs';

/** Read-only buffer with one commit: metadata, stat and patch. */
export class CommitBuffer {
  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string, sha: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/commit/${repoDisplayName(repoPath)}/${sha.slice(0, 12)}`,
      query: encodeURIComponent(`${repoPath}#${sha}`),
    });
  }

  /** Re-renders a restored commit tab after an extension-host restart. */
  async restore(uri: vscode.Uri): Promise<void> {
    const query = decodeURIComponent(uri.query);
    const separator = query.lastIndexOf('#');
    if (separator < 0) {
      return;
    }
    const repoPath = query.slice(0, separator);
    const sha = query.slice(separator + 1);
    const text = await showCommit(repoPath, sha);
    const decorated = withHints(text, t('log.keys'), t('status.keysHeader'));
    this.docs.set(uri, decorated.text);
    this.highlighter.setSpans(uri, [...commitSpans(text), ...decorated.spans]);
  }

  async open(repoPath: string, sha: string): Promise<vscode.TextEditor> {
    const uri = CommitBuffer.uriFor(repoPath, sha);
    const text = await showCommit(repoPath, sha);
    const decorated = withHints(text, t('log.keys'), t('status.keysHeader'));
    this.docs.set(uri, decorated.text);
    this.highlighter.setSpans(uri, [...commitSpans(text), ...decorated.spans]);

    let document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId !== 'git-commit') {
      document = await vscode.languages.setTextDocumentLanguage(document, 'git-commit');
    }
    return vscode.window.showTextDocument(document, { preview: false });
  }
}
