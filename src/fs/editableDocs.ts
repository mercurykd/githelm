import * as vscode from 'vscode';

/** Scheme for editable buffers backed by memory (commit message, rebase todo). */
export const EDIT_SCHEME = 'githelm-edit';

interface FileRecord {
  content: string;
  ctime: number;
  mtime: number;
}

type SaveHandler = (content: string) => void;

/**
 * A minimal in-memory file system: documents opened on this scheme are
 * editable and Ctrl+S calls `writeFile`, which is where the real action
 * (commit, rebase todo, …) is hooked in.
 *
 * This is the VS Code analogue of a Sublime scratch view: unlike
 * `TextDocumentContentProvider` documents, these can be typed into.
 */
export class EditableDocuments implements vscode.FileSystemProvider {
  private readonly files = new Map<string, FileRecord>();
  private readonly pending = new Map<string, SaveHandler>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const record = this.files.get(uri.toString());
    if (!record) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: vscode.FileType.File,
      ctime: record.ctime,
      mtime: record.mtime,
      size: Buffer.byteLength(record.content, 'utf8'),
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    /* flat namespace */
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const record = this.files.get(uri.toString());
    if (!record) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return Buffer.from(record.content, 'utf8');
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const key = uri.toString();
    const text = Buffer.from(content).toString('utf8');
    const existing = this.files.get(key);
    const now = Date.now();
    this.files.set(key, { content: text, ctime: existing?.ctime ?? now, mtime: now });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);

    const handler = this.pending.get(key);
    if (handler) {
      this.pending.delete(key);
      handler(text);
    }
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.toString());
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    /* the buffer name is fixed at creation; renaming is not supported */
  }

  /** Creates the buffer and returns its content; resolves on save or on close. */
  async edit(uri: vscode.Uri, initialContent: string): Promise<string | undefined> {
    const key = uri.toString();
    const now = Date.now();
    this.files.set(key, { content: initialContent, ctime: now, mtime: now });
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);

    // Register the resolver before opening the document so a very fast save
    // cannot be missed.
    const saved = new Promise<string | undefined>((resolve) => {
      this.pending.set(key, (content) => resolve(content));
      const subscription = vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed.uri.toString() !== key) {
          return;
        }
        subscription.dispose();
        const pendingHandler = this.pending.get(key);
        if (pendingHandler) {
          this.pending.delete(key);
          resolve(undefined);
        }
      });
    });

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return saved;
  }

  /** Registers a one-shot save handler for a buffer opened elsewhere. */
  onSave(uri: vscode.Uri, handler: SaveHandler): void {
    this.pending.set(uri.toString(), handler);
  }

  createUri(name: string, repoPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: EDIT_SCHEME, path: `/${name}`, query: encodeURIComponent(repoPath) });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
