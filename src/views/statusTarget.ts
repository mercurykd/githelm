import type { StatusEntry, StatusSection } from '../git/status';

/**
 * What a row of the list screens points at, resolved: a file of the status, a stash, a
 * remote, another worktree, or the `git init` row of a folder without a repository.
 *
 * A panel sends the id it drew (`PanelTarget`); the action resolves that id back to one of
 * these before it runs, which is why the union lives outside both the panel and the git
 * layer: it is the meeting point of the two.
 */
export type StatusTarget =
  | { kind: 'file'; section: StatusSection; path: string; entry: StatusEntry }
  | { kind: 'stash'; section: 'stash'; ref: string; subject: string }
  | { kind: 'remote'; section: 'remotes'; name: string; url: string }
  | { kind: 'worktree'; section: 'worktrees'; path: string; current: boolean; prunable: boolean }
  /** The `git init` row of a folder that is not a repository yet. */
  | { kind: 'init'; section: 'init' };
