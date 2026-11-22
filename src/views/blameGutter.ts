import * as vscode from 'vscode';
import { BLAME_GUTTER_WIDTH, type BlameLineView, type BlameView } from '../git/fileHistory';
import { COLOR_OF } from './highlight';

/** How many blames keep their gutter in memory: closed tabs are never painted again. */
const KEEP = 20;

/**
 * The metadata column of a blame, drawn in front of the code.
 *
 * A blame is the file itself in a real editor — the only place its code is highlighted by the
 * grammar of its own language, and the only place it is as wide as it is instead of wrapped to
 * fit. Which means the gutter cannot be text: the document holds the file's lines and nothing
 * else. It is a decoration instead, a `before` attachment on every line: the sha, the author,
 * the date and the subject in cells of a fixed width, blank on every line of a block but its
 * first, so the code stays on one column all the way down. A column is a width, and a
 * decoration has one where a line of text does not.
 *
 * The whole message of the commit is the line's hover — a `MarkdownString` built with
 * `appendText`, because a commit message is full of `*`, `_` and backticks and none of them are
 * markup — so hovering the row that raised the question answers it in the box VS Code draws at
 * the pointer, over the text that was hovered.
 */
export class BlameGutter implements vscode.Disposable {
  /** The gutter of every line: the cells differ per range, so the type carries no content. */
  private readonly gutterType: vscode.TextEditorDecorationType;
  /** The note that says the blame was cut short, attached to the end of its last line. */
  private readonly noteType: vscode.TextEditorDecorationType;
  private readonly views = new Map<string, BlameView>();

  constructor() {
    this.gutterType = vscode.window.createTextEditorDecorationType({});
    this.noteType = vscode.window.createTextEditorDecorationType({});
  }

  /** Hands a document its gutter; the editor that shows it paints it. */
  set(uri: vscode.Uri, view: BlameView): void {
    const key = uri.toString();
    this.views.delete(key);
    this.views.set(key, view);
    // A closed blame tab is never painted again, and a blame of three thousand lines is a
    // megabyte of gutters: the newest ones are all a session reads at once.
    for (const oldest of this.views.keys()) {
      if (this.views.size <= KEEP) {
        break;
      }
      this.views.delete(oldest);
    }
    this.repaint();
  }

  clear(uri: vscode.Uri): void {
    this.views.delete(uri.toString());
    this.repaint();
  }

  /**
   * Paints the gutter of `editor`'s document, or takes it away when the document is not a
   * blame. Called again whenever the editor is re-created, because decorations belong to the
   * editor and not to the document.
   */
  paint(editor: vscode.TextEditor): void {
    const view = this.views.get(editor.document.uri.toString());
    if (!view) {
      editor.setDecorations(this.gutterType, []);
      editor.setDecorations(this.noteType, []);
      return;
    }
    editor.setDecorations(this.gutterType, this.decorations(view, editor.document));
    editor.setDecorations(this.noteType, this.notes(view, editor.document));
  }

  repaint(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.paint(editor);
    }
  }

  dispose(): void {
    this.gutterType.dispose();
    this.noteType.dispose();
    this.views.clear();
  }

  private decorations(view: BlameView, document: vscode.TextDocument): vscode.DecorationOptions[] {
    const options: vscode.DecorationOptions[] = [];
    // One hover per message, shared by every line of the block it explains: a run of a
    // thousand lines from one commit is one message, not a thousand copies of it.
    const hovers = new Map<string, vscode.MarkdownString>();
    for (const line of view.lines) {
      if (line.line >= document.lineCount) {
        continue;
      }
      options.push({
        range: document.lineAt(line.line).range,
        ...(line.message.length > 0 ? { hoverMessage: this.hover(hovers, line) } : {}),
        renderOptions: { before: this.before(line) },
      });
    }
    return options;
  }

  /** The cells of one line as the `before` attachment that draws them. */
  private before(line: BlameLineView): vscode.ThemableDecorationAttachmentRenderOptions {
    // The width is what makes the gutter a column even if the attachment decides to trim the
    // padding: the boxes are as wide as the cells, so the code starts at one column.
    const width = `${BLAME_GUTTER_WIDTH}ch`;
    if (line.gutter.trim().length === 0) {
      // A line in the middle of a block still holds the column open: the code cannot move.
      return { contentText: line.gutter, width };
    }
    // A line that is not committed is painted the way the status screen paints it: it is about
    // to be in a commit, not in one.
    return {
      contentText: line.gutter,
      width,
      color: new vscode.ThemeColor(COLOR_OF[line.uncommitted ? 'unstaged' : 'meta']),
    };
  }

  /** The note at the end of the last line of a blame that stopped at `maxLines`. */
  private notes(view: BlameView, document: vscode.TextDocument): vscode.DecorationOptions[] {
    const last = view.lines[view.lines.length - 1];
    if (view.truncated <= 0 || !last || last.line >= document.lineCount) {
      return [];
    }
    return [
      {
        range: document.lineAt(last.line).range,
        renderOptions: {
          after: {
            contentText: `  … (blame обрезан: ${view.truncated} строк)`,
            color: new vscode.ThemeColor(COLOR_OF.meta),
          },
        },
      },
    ];
  }

  private hover(hovers: Map<string, vscode.MarkdownString>, line: BlameLineView): vscode.MarkdownString {
    const existing = hovers.get(line.message);
    if (existing) {
      return existing;
    }
    // `appendText` escapes the message: a commit message is not markdown, it is what it says.
    const markdown = new vscode.MarkdownString();
    markdown.appendText(line.message);
    hovers.set(line.message, markdown);
    return markdown;
  }
}
