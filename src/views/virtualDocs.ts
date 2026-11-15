import * as vscode from 'vscode';

/** Scheme for read-only, generated buffers (status, diff, …). */
export const SCHEME = 'githelm';

/**
 * Backing store for read-only virtual documents. VS Code asks the provider for
 * content when a `githelm:` URI is opened; `set()` re-renders an open editor
 * in place without touching any file on disk.
 */
export class VirtualDocuments implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString()) ?? '';
  }

  set(uri: vscode.Uri, text: string): void {
    this.store.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  get(uri: vscode.Uri): string | undefined {
    return this.store.get(uri.toString());
  }

  has(uri: vscode.Uri): boolean {
    return this.store.has(uri.toString());
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
