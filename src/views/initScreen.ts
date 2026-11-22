import * as vscode from 'vscode';
import { SCHEME } from './virtualDocs';

/** The path of the `githelm:` document that is the status screen of a folder without a repository. */
export const INIT_PATH = '/init';

/**
 * The document behind the `git init` screen: the status screen of a folder that is not a
 * repository yet, opened as a panel of its own so a webview reader never has to be sent to
 * a text buffer to get a repository created. The screen has one row (`git init`) and one
 * key (`Enter`), because that is the only thing such a folder can be asked to do.
 */
export function initUri(folderPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: INIT_PATH, query: encodeURIComponent(folderPath) });
}

/** The folder behind an init document, or `undefined` for any other document. */
export function parseInit(uri: vscode.Uri): { folderPath: string } | undefined {
  if (uri.scheme !== SCHEME || uri.path !== INIT_PATH) {
    return undefined;
  }
  return { folderPath: decodeURIComponent(uri.query) };
}
