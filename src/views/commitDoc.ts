import * as vscode from 'vscode';
import { t } from '../i18n';
import { repoDisplayName } from '../git/repo';
import { readCommitChanges, readCommitMeta, renderCommitScreen, resolveCommit } from '../git/commitView';
import { Span } from '../util/span';
import { FileList } from './fileList';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface CommitDocState {
  uri: vscode.Uri;
  repoPath: string;
  /** The commit the screen was opened by, resolved to a sha. */
  sha: string;
  /** The `## files (n)` line (1-based): a key on it means the whole list. */
  header: number;
  /** Line (1-based) → the file it names. */
  targets: Map<number, string>;
}

/**
 * One commit: its metadata, its message and the files it touched, as the panel draws them.
 *
 * The text and its spans are built here rather than in the panel, because a screen is a
 * document: the panel renders exactly what the renderer produced, which is also what the
 * tests pin without a window. `d` then opens the change of every selected file in the
 * built-in diff editor — the diff has its own home, and the patch of a whole commit in a
 * read-only document hides the list under it.
 */
export class CommitDoc {
  private readonly states = new Map<string, CommitDocState>();

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

  /** The repository and the commit behind a commit URI. */
  static parse(uri: vscode.Uri): { repoPath: string; sha: string } | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/commit/')) {
      return undefined;
    }
    const query = decodeURIComponent(uri.query);
    const separator = query.lastIndexOf('#');
    if (separator < 0) {
      return undefined;
    }
    return { repoPath: query.slice(0, separator), sha: query.slice(separator + 1) };
  }

  stateFor(uri: vscode.Uri): CommitDocState | undefined {
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

  /** Re-reads the document from `git` without opening anything: what `r` does. */
  async reload(uri: vscode.Uri): Promise<void> {
    const state = this.states.get(uri.toString());
    const parsed = state ? { repoPath: state.repoPath, sha: state.sha } : CommitDoc.parse(uri);
    if (parsed) {
      await this.prepare(parsed.repoPath, parsed.sha);
    }
  }

  /** Renders the commit into its document, which the panel reads back. */
  async prepare(repoPath: string, ref: string): Promise<vscode.Uri> {
    const sha = (await resolveCommit(repoPath, ref)) ?? ref;
    const dateFormat = vscode.workspace.getConfiguration('githelm').get<string>('log.dateFormat', '%Y-%m-%d %H:%M');
    const [meta, changes] = await Promise.all([
      readCommitMeta(repoPath, sha, dateFormat),
      readCommitChanges(repoPath, sha),
    ]);
    const screen = renderCommitScreen(meta, changes, t('commit.files'), t('hints.commitFiles'));
    const uri = CommitDoc.uriFor(repoPath, sha);

    const targets = new Map<number, string>();
    for (const row of screen.rows) {
      targets.set(row.line, row.path);
    }
    this.states.set(uri.toString(), { uri, repoPath, sha, header: screen.header, targets });

    this.docs.set(uri, screen.text);
    const spans: Span[] = screen.spans;
    this.highlighter.setSpans(uri, spans);
    return uri;
  }
}
