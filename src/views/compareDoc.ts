import * as vscode from 'vscode';
import { t } from '../i18n';
import { repoDisplayName } from '../git/repo';
import { compareChanges } from '../git/compare';
import { Span } from '../util/span';
import { FileList } from './fileList';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface CompareDocState {
  uri: vscode.Uri;
  repoPath: string;
  range: string;
  leftRef: string;
  rightRef: string;
  label: string;
  /** The `## files (n)` line (1-based): a key on it means the whole list. */
  header: number;
  targets: Map<number, string>;
}

/**
 * The files a compare range touches, as one document. A compare ends in a file list
 * first, exactly like a commit or a stash: `d` on a row opens that file's diff and `d`
 * on the `## files` header opens all of them. The range and its two sides are kept in
 * the document's state, so the list and the diff it opens cannot disagree about what
 * `A...B` means.
 */
export class CompareDoc {
  private readonly states = new Map<string, CompareDocState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string, range: string, leftRef: string, rightRef: string, label: string): vscode.Uri {
    const state = JSON.stringify({ repoPath, range, leftRef, rightRef, label });
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/compare/${repoDisplayName(repoPath)}`,
      query: encodeURIComponent(state),
    });
  }

  /** The repository and the range behind a compare URI. */
  static parse(uri: vscode.Uri): Omit<CompareDocState, 'uri' | 'header' | 'targets'> | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/compare/')) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(decodeURIComponent(uri.query)) as Record<string, unknown>;
      const repoPath = parsed.repoPath;
      const range = parsed.range;
      const leftRef = parsed.leftRef;
      const rightRef = parsed.rightRef;
      const label = parsed.label;
      if (
        typeof repoPath !== 'string' ||
        typeof range !== 'string' ||
        typeof leftRef !== 'string' ||
        typeof rightRef !== 'string' ||
        typeof label !== 'string'
      ) {
        return undefined;
      }
      return { repoPath, range, leftRef, rightRef, label };
    } catch {
      return undefined;
    }
  }

  stateFor(uri: vscode.Uri): CompareDocState | undefined {
    return this.states.get(uri.toString());
  }

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
    const parsed = state ?? CompareDoc.parse(uri);
    if (parsed) {
      await this.prepare(parsed.repoPath, parsed.range, parsed.leftRef, parsed.rightRef, parsed.label);
    }
  }

  /** Renders a compare's file list into its document, which the panel reads back. */
  async prepare(
    repoPath: string,
    range: string,
    leftRef: string,
    rightRef: string,
    label: string
  ): Promise<vscode.Uri> {
    const changes = await compareChanges(repoPath, range);
    const uri = CompareDoc.uriFor(repoPath, range, leftRef, rightRef, label);

    const lines: string[] = [];
    const targets = new Map<number, string>();
    const spans: Span[] = [];

    const title = `${label} — ${repoDisplayName(repoPath)}`;
    lines.push(title);
    spans.push({ line: 0, start: 0, end: title.length, kind: 'title' });

    const headerLine = lines.length + 1;
    const header = `## ${t('compare.files')} (${changes.length})`;
    lines.push(header);
    spans.push({ line: headerLine - 1, start: 0, end: header.length, kind: 'section' });
    lines.push(`  ${t('hints.compareFiles')}`);
    spans.push({ line: headerLine, start: 2, end: 2 + t('hints.compareFiles').length, kind: 'help' });
    lines.push('');

    for (const change of changes) {
      const lineNumber = lines.length + 1;
      const text = `  ${change.status.padEnd(2)} ${change.path}`;
      lines.push(text);
      targets.set(lineNumber, change.path);
      spans.push({ line: lineNumber - 1, start: 2, end: 3, kind: 'file-modified' });
      spans.push({ line: lineNumber - 1, start: 5, end: text.length, kind: 'path' });
    }

    this.states.set(uri.toString(), { uri, repoPath, range, leftRef, rightRef, label, header: headerLine, targets });
    this.docs.set(uri, `${lines.join('\n')}\n`);
    this.highlighter.setSpans(uri, spans);
    return uri;
  }
}
