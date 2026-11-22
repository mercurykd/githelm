import * as vscode from 'vscode';
import { fileBlame, fileLog, type BlameView, type HistoryView } from '../git/fileHistory';
import { repoDisplayName } from '../git/repo';
import { BlameGutter } from './blameGutter';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export type FileHistoryKind = 'log' | 'blame';

/**
 * A file's history: `git log --follow <file>` and `git blame <file>`.
 *
 * The two are read differently, so they are rendered differently. A log *is* text — a sha, a
 * date, an author and a subject on a line — and the panel draws that one `HistoryView`. A
 * blame is the file's code, and the code is the file's own text in a real editor: highlighted
 * by its language, as wide as it needs, scrolled instead of wrapped. Its metadata is a
 * decoration in front of the line (`BlameGutter`), never part of the document, so nothing that
 * is not the file can be a token of it. That is why a blame is the one screen a webview cannot
 * draw, and the only `githelm:` document the extension still opens as an editor.
 */
export class HistoryDoc {
  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter,
    private readonly gutter: BlameGutter
  ) {}

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

  /** Hands the document its text and the paint that goes with it, in one step. */
  private setLog(uri: vscode.Uri, view: HistoryView): void {
    this.docs.set(uri, view.text);
    this.highlighter.setSpans(uri, view.spans);
    this.gutter.clear(uri);
  }

  private setBlame(uri: vscode.Uri, view: BlameView): void {
    // The code, and only the code: the gutter is drawn in front of it, not written into it.
    this.docs.set(uri, view.text);
    this.highlighter.clear(uri);
    this.gutter.set(uri, view);
  }

  private async build(kind: FileHistoryKind, repoPath: string, relativePath: string): Promise<vscode.Uri> {
    const uri = HistoryDoc.uriFor(repoPath, kind, relativePath);
    if (kind === 'log') {
      this.setLog(uri, await fileLog(repoPath, relativePath));
    } else {
      this.setBlame(uri, await fileBlame(repoPath, relativePath));
    }
    return uri;
  }

  /**
   * The language VS Code would open the file with, so a blame is highlighted exactly as the
   * file is: the grammar is picked by VS Code itself, from the file it belongs to, instead of
   * a table of extensions that would be wrong for every language it does not list.
   */
  private static async languageOf(repoPath: string, relativePath: string): Promise<string | undefined> {
    try {
      const file = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(vscode.Uri.file(repoPath), ...relativePath.split('/'))
      );
      return file.languageId;
    } catch {
      // A file the working tree no longer has keeps the default language: a blame still reads.
      return undefined;
    }
  }

  /** Renders a file's history into its document; the panel reads a log back. */
  async prepare(kind: FileHistoryKind, repoPath: string, relativePath: string): Promise<vscode.Uri> {
    return this.build(kind, repoPath, relativePath);
  }

  /** Re-reads a log from `git` without opening anything: what `r` does. */
  async reload(uri: vscode.Uri): Promise<void> {
    const parsed = HistoryDoc.parse(uri);
    if (parsed) {
      await this.build(parsed.kind, parsed.repoPath, parsed.relativePath);
    }
  }

  /** Opens a blame in the editor the file belongs in: real text, real grammar, a gutter. */
  async openBlame(repoPath: string, relativePath: string): Promise<vscode.TextEditor> {
    const uri = await this.build('blame', repoPath, relativePath);
    let document = await vscode.workspace.openTextDocument(uri);
    document = await HistoryDoc.speakLanguage(document, repoPath, relativePath);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    // Decorations belong to an editor, so the one that was just made gets them now.
    this.gutter.paint(editor);
    return editor;
  }

  /** Gives a blame document the language of its file, when the file is there to ask. */
  private static async speakLanguage(
    document: vscode.TextDocument,
    repoPath: string,
    relativePath: string
  ): Promise<vscode.TextDocument> {
    const language = await HistoryDoc.languageOf(repoPath, relativePath);
    if (!language || language === document.languageId) {
      return document;
    }
    try {
      return await vscode.languages.setTextDocumentLanguage(document, language);
    } catch {
      // An id this VS Code does not know is not worth failing a blame over: plain text reads.
      return document;
    }
  }

  /** A blame tab that a window reload restored: the document is rebuilt, then given its language. */
  async restore(uri: vscode.Uri): Promise<void> {
    const parsed = HistoryDoc.parse(uri);
    if (!parsed || parsed.kind !== 'blame') {
      return;
    }
    await this.build('blame', parsed.repoPath, parsed.relativePath);
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.toString() === uri.toString()) {
        await HistoryDoc.speakLanguage(document, parsed.repoPath, parsed.relativePath);
        break;
      }
    }
  }
}
