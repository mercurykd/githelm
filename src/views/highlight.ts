import * as vscode from 'vscode';
import { Span, SpanKind } from '../util/span';

/**
 * The theme colour a kind of paint is drawn in. A span is painted by a decoration type, and a
 * blame's gutter — which is not a span — asks this same table for its colour, so a commit is
 * the same colour in a status row and in a blame.
 */
export const COLOR_OF: Record<SpanKind, string> = {
  meta: 'githelm.meta',
  hash: 'githelm.hash',
  date: 'githelm.date',
  author: 'githelm.author',
  refs: 'githelm.refs',
  upstream: 'githelm.upstream',
  graph: 'githelm.graph',
  section: 'githelm.section',
  staged: 'githelm.staged',
  unstaged: 'githelm.unstaged',
  untracked: 'githelm.untracked',
  remotes: 'githelm.remotes',
  worktrees: 'githelm.worktrees',
  path: 'githelm.path',
  branch: 'githelm.branch',
  help: 'githelm.help',
  rule: 'githelm.rule',
  title: 'githelm.section',
  add: 'githelm.added',
  del: 'githelm.deleted',
  hunk: 'githelm.hunk',
  'file-added': 'githelm.added',
  'file-modified': 'githelm.modified',
  'file-deleted': 'githelm.deleted',
  'file-untracked': 'githelm.added',
  'file-conflict': 'githelm.conflict',
};

/**
 * Colour only. Weight and slant are set by the editor, not by us: a decoration
 * that also changes `fontWeight` or `fontStyle` is rendered through a different
 * code path in VS Code, and in practice it drops the colour — which is exactly
 * how titles ended up bold-but-white while the plain `##` next to them was
 * tinted. One property per decoration keeps the paint where we expect it.
 */

/**
 * Colours virtual buffers with theme-aware decorations.
 *
 * TextMate grammars would be the other option, but our buffers are generated
 * from data we already have, so exact ranges beat regex-based syntax rules —
 * and ranges can be unit-tested.
 */
export class Highlighter implements vscode.Disposable {
  private readonly types = new Map<SpanKind, vscode.TextEditorDecorationType>();
  private readonly spans = new Map<string, Span[]>();
  private readonly kinds: SpanKind[] = Object.keys(COLOR_OF) as SpanKind[];


  setSpans(uri: vscode.Uri, spans: Span[]): void {
    this.spans.set(uri.toString(), spans);
    // The buffer classes set the spans right after they hand the new text to the
    // document provider, so the model may still hold the previous (or empty)
    // text here. Re-apply on the next tick, when the text is in place: ranges
    // clamped against a stale document are dropped and never revisited.
    setTimeout(() => this.applyVisible(), 0);
  }

  clear(uri: vscode.Uri): void {
    this.spans.delete(uri.toString());
  }

  /**
   * The spans rendered for a document. The webview draws the same buffer text the editor
   * does, so it paints it with the same spans instead of parsing the patch again.
   */
  spansOf(uri: vscode.Uri): Span[] {
    return this.spans.get(uri.toString()) ?? [];
  }

  apply(editor: vscode.TextEditor): void {
    const spans = this.spans.get(editor.document.uri.toString());
    if (!spans) {
      return;
    }

    const byKind = new Map<SpanKind, vscode.Range[]>();
    for (const span of spans) {
      if (span.line < 0 || span.line >= editor.document.lineCount) {
        continue;
      }
      const lineText = editor.document.lineAt(span.line).text;
      const end = Math.min(span.end, lineText.length);
      if (end <= span.start) {
        continue;
      }
      const range = new vscode.Range(span.line, span.start, span.line, end);
      const list = byKind.get(span.kind);
      if (list) {
        list.push(range);
      } else {
        byKind.set(span.kind, [range]);
      }
    }

    for (const kind of this.kinds) {
      editor.setDecorations(this.type(kind), byKind.get(kind) ?? []);
    }

  }

  applyVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  dispose(): void {
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types.clear();
    this.spans.clear();
  }

  private type(kind: SpanKind): vscode.TextEditorDecorationType {
    const existing = this.types.get(kind);
    if (existing) {
      return existing;
    }
    const created = vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor(COLOR_OF[kind]),
    });
    this.types.set(kind, created);
    return created;
  }
}
