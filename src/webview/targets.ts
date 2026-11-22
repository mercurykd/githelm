/**
 * The rows of the right-hand column, as the webview sees them.
 *
 * A row id already carries everything the host needs to look the entry up again
 * (`remote:<name>`, `worktree:<path>`, `stash:<ref>`), so nothing here has to be
 * kept in step with git: the host re-reads the repository before it acts, and an id
 * that no longer exists does nothing.
 *
 * Nothing here imports `vscode`, so the tests can cover it directly.
 */

export interface PanelTarget {
  kind: 'remote' | 'worktree' | 'stash';
  value: string;
}

/** `remote:origin` → `{ kind: 'remote', value: 'origin' }`. */
const KINDS = new Set(['remote', 'worktree', 'stash']);

/**
 * The column row the selection points at, or `undefined` for a selection of file
 * rows. Only the first id counts: it is the row at the top of the selection, the
 * panel's version of the buffer's primary cursor, so a selection that grew into the
 * column with `Shift+Click` still means "the files" and `Ctrl+A` still means "all
 * files, no particular remote".
 */
export function targetOf(ids: readonly string[]): PanelTarget | undefined {
  const id = ids[0];
  if (id === undefined) {
    return undefined;
  }
  const separator = id.indexOf(':');
  if (separator < 0) {
    return undefined;
  }
  const kind = id.slice(0, separator);
  if (!KINDS.has(kind)) {
    return undefined;
  }
  // Everything after the first colon is the value: a Windows path keeps the colon
  // of its drive, and a stash ref keeps the one of `stash@{0}`.
  return { kind: kind as PanelTarget['kind'], value: id.slice(separator + 1) };
}
