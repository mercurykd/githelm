import type { DiscardRequest } from '../git/ops';
import type { StatusTarget } from './statusRender';

export type FileTarget = Extract<StatusTarget, { kind: 'file' }>;

/**
 * What `D` will do, split by the section the cursor is on.
 *
 * The same path can legitimately sit in two sections at once — `git rm --cached`
 * gives a staged `D ` row and an untracked `??` row for one file, and `AM` gives
 * a staged row plus an unstaged one. Each row is discarded on its own: the
 * staged row only resets the index, the unstaged row only the working tree, the
 * untracked row only the file on disk. Merging them by path is what made
 * discarding an untracked file throw away its staged part.
 */
export interface DiscardPlan extends DiscardRequest {
  /** Every distinct path the plan touches, in the order it was first seen. */
  paths: string[];
  /** Conflicted paths, kept apart only to explain the HEAD rule in the prompt. */
  conflicts: string[];
}

const unique = (list: readonly string[]): string[] => [...new Set(list)];

export function planDiscard(files: readonly FileTarget[]): DiscardPlan {
  const staged: string[] = [];
  const worktree: string[] = [];
  const reset: string[] = [];
  const remove: string[] = [];
  const conflicts: string[] = [];

  for (const target of files) {
    if (target.section === 'untracked') {
      remove.push(target.path);
      continue;
    }
    if (target.section === 'conflict') {
      reset.push(target.path);
      conflicts.push(target.path);
      continue;
    }
    if (target.section === 'staged') {
      staged.push(target.path);
      continue;
    }
    // Unstaged rows are mostly real working-tree changes, except for
    // intent-to-add (` A`): git has an index slot but no committed content, so
    // nothing can be restored — the file goes away with its empty slot.
    if (target.entry.xy[1] === 'A') {
      reset.push(target.path);
      remove.push(target.path);
      continue;
    }
    worktree.push(target.path);
  }

  const paths = unique([...staged, ...worktree, ...reset, ...remove]);
  return {
    staged: unique(staged),
    worktree: unique(worktree),
    reset: unique(reset),
    remove: unique(remove),
    conflicts: unique(conflicts),
    paths,
  };
}
