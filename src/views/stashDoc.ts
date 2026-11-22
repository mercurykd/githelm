import * as vscode from 'vscode';
import { t } from '../i18n';
import { repoDisplayName } from '../git/repo';
import { stashFiles } from '../git/stash';
import { Span } from '../util/span';
import { FileList } from './fileList';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface StashDocState {
  uri: vscode.Uri;
  repoPath: string;
  ref: string;
  /** The `## files (n)` line (1-based): a key on it means the whole list. */
  header: number;
  targets: Map<number, string>;
}

/** The file list of one stash, as the panel draws it: `d` opens the files under the cursor. */
export class StashDoc {
  private readonly states = new Map<string, StashDocState>();

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

  /** The repository and the stash behind a stash URI. */
  static parse(uri: vscode.Uri): { repoPath: string; ref: string } | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/stashfiles/')) {
      return undefined;
    }
    const query = decodeURIComponent(uri.query);
    const separator = query.lastIndexOf('#');
    if (separator < 0) {
      return undefined;
    }
    return { repoPath: query.slice(0, separator), ref: query.slice(separator + 1) };
  }

  stateFor(uri: vscode.Uri): StashDocState | undefined {
    return this.states.get(uri.toString());
  }

  /**
   * The file list of the document: the `## files (n)` line, the lines that name a file
   * and the file each of them names.
   */
  fileListOf(uri: vscode.Uri): FileList | undefined {
    const state = this.states.get(uri.toString());
    if (!state) {
      return undefined;
    }
    const lines = [...state.targets.keys()].sort((left, right) => left - right);
    return { header: state.header, lines, targets: state.targets };
  }

  /** Re-reads the list from `git` without opening anything: what `r` does. */
  async reload(uri: vscode.Uri): Promise<void> {
    const state = this.states.get(uri.toString());
    const parsed = state ? { repoPath: state.repoPath, ref: state.ref } : StashDoc.parse(uri);
    if (parsed) {
      await this.prepare(parsed.repoPath, parsed.ref);
    }
  }

  /** Renders a stash's file list into its document, which the panel reads back. */
  async prepare(repoPath: string, ref: string): Promise<vscode.Uri> {
    const files = await stashFiles(repoPath, ref);
    const uri = StashDoc.uriFor(repoPath, ref);

    const lines: string[] = [];
    const targets = new Map<number, string>();
    const spans: Span[] = [];

    const title = `${ref} — ${repoDisplayName(repoPath)}`;
    lines.push(title);
    spans.push({ line: 0, start: 0, end: title.length, kind: 'title' });

    // The header is part of the list, not a title over it: a key on this line means every
    // file under it. Counted here, so it cannot drift from the layout.
    const headerLine = lines.length + 1;
    const header = `## ${t('stash.files')} (${files.length})`;
    lines.push(header);
    spans.push({ line: headerLine - 1, start: 0, end: header.length, kind: 'section' });
    lines.push(`  ${t('hints.stashFiles')}`);
    spans.push({ line: headerLine, start: 2, end: 2 + t('hints.stashFiles').length, kind: 'help' });
    lines.push('');

    for (const file of files) {
      const lineNumber = lines.length + 1;
      const text = `  ${file.status.padEnd(2)} ${file.path}`;
      lines.push(text);
      targets.set(lineNumber, file.path);
      spans.push({ line: lineNumber - 1, start: 2, end: 3, kind: 'file-modified' });
      spans.push({ line: lineNumber - 1, start: 5, end: text.length, kind: 'path' });
    }

    this.states.set(uri.toString(), { uri, repoPath, ref, header: headerLine, targets });
    this.docs.set(uri, `${lines.join('\n')}\n`);
    this.highlighter.setSpans(uri, spans);
    return uri;
  }
}
