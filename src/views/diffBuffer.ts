import * as vscode from 'vscode';
import { diffArgs, diffSlug, DiffMode, hunkAt, ParsedDiff, parseDiff } from '../git/diff';
import { diffHasLfsPointer } from '../git/lfs';
import { git } from '../git/exec';
import { buildPatch, LineSelection, PatchBuildError, selectionForBlock, selectionForHunk, selectionToLines } from '../git/patch';
import { repoDisplayName } from '../git/repo';
import { applyPatchToIndex, PatchApplyError } from '../git/stage';
import { t } from '../i18n';
import { withHints } from './columns';
import { Highlighter } from './highlight';
import { SCHEME, VirtualDocuments } from './virtualDocs';

export interface DiffState {
  uri: vscode.Uri;
  repoPath: string;
  mode: DiffMode;
  /** Empty for the whole working tree; otherwise the files this buffer is scoped to. */
  paths: string[];
  parsed: ParsedDiff;
}


export class DiffBuffer {
  private readonly states = new Map<string, DiffState>();

  constructor(
    private readonly docs: VirtualDocuments,
    private readonly highlighter: Highlighter
  ) {}

  static uriFor(repoPath: string, mode: DiffMode, paths: readonly string[] = []): vscode.Uri {
    return vscode.Uri.from({
      scheme: SCHEME,
      path: `/diff/${mode}/${repoDisplayName(repoPath)}${paths.length > 0 ? `/${diffSlug(paths)}` : ''}`,
      query: encodeURIComponent(repoPath),
    });
  }

  stateFor(uri: vscode.Uri): DiffState | undefined {
    return this.states.get(uri.toString());
  }

  repoForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || !uri.path.startsWith('/diff/')) {
      return undefined;
    }
    return this.stateFor(uri)?.repoPath ?? decodeURIComponent(uri.query);
  }

  async open(repoPath: string, mode: DiffMode, paths: readonly string[] = []): Promise<vscode.TextEditor> {
    const uri = DiffBuffer.uriFor(repoPath, mode, paths);
    const parsed = await this.render(repoPath, mode, paths);

    let document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId !== 'diff') {
      document = await vscode.languages.setTextDocumentLanguage(document, 'diff');
    }
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    if (parsed.files.length > 0) {
      const first = parsed.files[0];
      const target = first.hunks.length > 0 ? first.hunks[0].docLine : 1;
      const line = Math.max(0, target - 1);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    }
    return editor;
  }

  async refresh(uri: vscode.Uri, cursorLine: number): Promise<void> {
    const state = this.stateFor(uri);
    const repoPath = state?.repoPath ?? decodeURIComponent(uri.query);
    const mode: DiffMode = state?.mode ?? (uri.path.startsWith('/diff/staged/') ? 'staged' : 'unstaged');
    await this.render(repoPath, mode, state?.paths ?? []);
    const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === uri.toString());
    if (editor) {
      const line = Math.min(cursorLine, Math.max(0, editor.document.lineCount - 1));
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    }
  }

  /** Applies the selection — or the whole hunk under the cursor — to the index. */
  async applySelection(uri: vscode.Uri, editor: vscode.TextEditor): Promise<string> {
    const state = this.stateFor(uri);
    if (!state) {
      return 'Not a Git Helm diff buffer.';
    }

    const start = editor.selection.start;
    const end = editor.selection.end;
    const empty = start.line === end.line && start.character === end.character;

    let selection: LineSelection[];
    let what: string;

    if (empty) {
      const location = hunkAt(state.parsed, start.line + 1);
      if (!location) {
        return t('msg.cursorNotInHunk');
      }
      const hunk = state.parsed.files[location.file].hunks[location.hunk];
      const bodyIndex = start.line + 1 - hunk.docLine - 1;
      const block = selectionForBlock(state.parsed, location.file, location.hunk, bodyIndex);
      selection = block.length > 0 ? block : selectionForHunk(state.parsed, location.file, location.hunk);
      what = block.length > 0 ? t('msg.whatBlock') : t('msg.whatHunk');
    } else {
      selection = selectionToLines(state.parsed, Math.min(start.line, end.line) + 1, Math.max(start.line, end.line) + 1);
      what = t('msg.whatLines');
    }

    if (selection.length === 0) {
      return 'В выделении нет добавленных или удалённых строк.';
    }

    const patch = buildPatch(state.parsed, selection);
    if (!patch.trim()) {
      return 'Nothing to apply.';
    }

    await applyPatchToIndex(state.repoPath, patch, { reverse: state.mode === 'staged' });
    return state.mode === 'staged'
      ? `Unstaged ${selection.length} строк (${what}).`
      : `Staged ${selection.length} строк (${what}).`;
  }

  private async render(repoPath: string, mode: DiffMode, paths: readonly string[]): Promise<ParsedDiff> {
    const uri = DiffBuffer.uriFor(repoPath, mode, paths);
    const result = await git(repoPath, diffArgs(mode, paths));
    if (result.code !== 0) {
      throw new Error(`git diff failed (${result.code}): ${result.stderr.trim()}`);
    }

    const raw = result.stdout.length > 0 ? result.stdout : `${t('diff.empty', { mode })}\n`;
    // An LFS pointer diffs as three lines of oid/size; say so above the diff
    // instead of letting it look like the file's real content.
    const note = diffHasLfsPointer(raw) ? `${t('diff.lfsPointer')}\n` : '';
    const parsed = parseDiff(raw, note ? 1 : 0);
    this.states.set(uri.toString(), { uri, repoPath, mode, paths: [...paths], parsed });
    const decorated = withHints(`${note}${raw}`, t('diff.keys'), t('status.keysHeader'));
    this.docs.set(uri, decorated.text);
    this.highlighter.setSpans(uri, decorated.spans);
    return parsed;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof PatchBuildError || error instanceof PatchApplyError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
