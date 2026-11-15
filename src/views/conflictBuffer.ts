import * as vscode from 'vscode';
import { t } from '../i18n';
import { ConflictRegion, readConflict } from '../git/conflicts';
import { repoDisplayName } from '../git/repo';
import { Span } from '../util/span';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface ConflictState {
  uri: vscode.Uri;
  repoPath: string;
  relativePath: string;
  regions: ConflictRegion[];
}

const PREVIEW_LINES = 6;

/** Overview of one conflicted file: what ours/theirs look like per region. */
export class ConflictBuffer {
  private readonly states = new Map<string, ConflictState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string, relativePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/conflict/${repoDisplayName(repoPath)}/${relativePath.split('/').pop() ?? 'file'}`,
      query: encodeURIComponent(`${repoPath}#${relativePath}`),
    });
  }

  stateFor(uri: vscode.Uri): ConflictState | undefined {
    return this.states.get(uri.toString());
  }

  repoForUri(uri: vscode.Uri): string | undefined {
    return this.stateFor(uri)?.repoPath;
  }

  async open(repoPath: string, relativePath: string): Promise<vscode.TextEditor> {
    await this.render(repoPath, relativePath);
    const uri = ConflictBuffer.uriFor(repoPath, relativePath);
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document, { preview: false });
  }

  async refresh(uri: vscode.Uri): Promise<void> {
    const state = this.stateFor(uri);
    if (!state) {
      return;
    }
    await this.render(state.repoPath, state.relativePath);
  }

  private async render(repoPath: string, relativePath: string): Promise<void> {
    const regions = await readConflict(repoPath, relativePath);
    const uri = ConflictBuffer.uriFor(repoPath, relativePath);

    const lines: string[] = [];
    const spans: Span[] = [];

    const title = `${relativePath} — ${t('conflict.title', { count: regions.length })}`;
    lines.push(title);
    spans.push({ line: 0, start: 0, end: title.length, kind: 'title' });

    const hint = `  ${t('conflict.hints')}`;
    lines.push(hint);
    spans.push({ line: 1, start: 2, end: hint.length, kind: 'help' });
    lines.push('');

    regions.forEach((region, index) => {
      const headerLine = lines.length;
      const header = `## ${t('conflict.region', { index: index + 1, line: region.startLine })}`;
      lines.push(header);
      spans.push({ line: headerLine, start: 0, end: header.length, kind: 'section' });

      const pushSide = (label: string, side: string[], kind: Span['kind']): void => {
        lines.push(`  ${label}:`);
        spans.push({ line: lines.length - 1, start: 2, end: 2 + label.length, kind: 'meta' });
        for (const text of side.slice(0, PREVIEW_LINES)) {
          const row = `    ${text}`;
          lines.push(row);
          spans.push({ line: lines.length - 1, start: 4, end: row.length, kind });
        }
        if (side.length > PREVIEW_LINES) {
          const more = `    ${t('conflict.more', { count: side.length - PREVIEW_LINES })}`;
          lines.push(more);
          spans.push({ line: lines.length - 1, start: 4, end: more.length, kind: 'meta' });
        }
      };

      pushSide(t('conflict.ours'), region.ours, 'add');
      pushSide(t('conflict.theirs'), region.theirs, 'del');
      if (region.base.length > 0) {
        pushSide(t('conflict.base'), region.base, 'meta');
      }
      lines.push('');
    });

    if (regions.length === 0) {
      lines.push(`  ${t('conflict.none')}`);
      lines.push('');
    }

    this.states.set(uri.toString(), { uri, repoPath, relativePath, regions });
    this.docs.set(uri, `${lines.join('\n')}\n`);
    this.highlighter.setSpans(uri, spans);
  }
}
