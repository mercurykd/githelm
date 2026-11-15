import * as vscode from 'vscode';
import { fileBlame, fileLog } from '../git/fileHistory';
import { repoDisplayName } from '../git/repo';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export type FileHistoryKind = 'log' | 'blame';

/** Read-only buffer for `git log --follow <file>` and `git blame <file>`. */
export class FileHistoryBuffer {
  constructor(private readonly docs: VirtualDocuments) {}

  static uriFor(repoPath: string, kind: FileHistoryKind, relativePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/file/${kind}/${repoDisplayName(repoPath)}/${relativePath.split('/').pop() ?? 'file'}`,
      query: encodeURIComponent(`${repoPath}#${relativePath}`),
    });
  }

  static parse(uri: vscode.Uri): { repoPath: string; relativePath: string; kind: FileHistoryKind } | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/file/')) {
      return undefined;
    }
    const match = /^\/file\/(log|blame)\//.exec(uri.path);
    if (!match) {
      return undefined;
    }
    const query = decodeURIComponent(uri.query);
    const separator = query.lastIndexOf('#');
    if (separator < 0) {
      return undefined;
    }
    return {
      kind: match[1] as FileHistoryKind,
      repoPath: query.slice(0, separator),
      relativePath: query.slice(separator + 1),
    };
  }

  private static async build(kind: FileHistoryKind, repoPath: string, relativePath: string): Promise<string> {
    return kind === 'log' ? fileLog(repoPath, relativePath) : fileBlame(repoPath, relativePath);
  }

  async open(kind: FileHistoryKind, repoPath: string, relativePath: string): Promise<vscode.TextEditor> {
    const uri = FileHistoryBuffer.uriFor(repoPath, kind, relativePath);
    const text = await FileHistoryBuffer.build(kind, repoPath, relativePath);
    this.docs.set(uri, text);
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  async restore(uri: vscode.Uri): Promise<void> {
    const parsed = FileHistoryBuffer.parse(uri);
    if (!parsed) {
      return;
    }
    this.docs.set(uri, await FileHistoryBuffer.build(parsed.kind, parsed.repoPath, parsed.relativePath));
  }
}
