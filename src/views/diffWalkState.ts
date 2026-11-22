import type * as vscode from 'vscode';
import type { WalkKind } from '../git/diffWalk';

/**
 * One file of a diff, as the openers in `src/webview/panel.ts` build it.
 *
 * The two sides are `git:` revision URIs (the built-in git extension's scheme) or one
 * `git:` URI and the file on disk. A single-file diff tells the walk everything it needs;
 * a multi-diff (`vscode.changes`) reports its pairs as `diffEditors` on the tab input in
 * current builds, but not in every build the engine allows, so the openers record here
 * what they opened as a second answer, read back by the tab's own label.
 */
export interface DiffEntry {
  title: string;
  left: vscode.Uri;
  right: vscode.Uri;
}

/** A diff this extension opened, and the working-tree diff it may have been reached from. */
export interface OpenedDiff {
  label: string;
  entries: readonly DiffEntry[];
  /**
   * The rule the diff was opened under, when a walk wrote it: a list of files walks the
   * repository's history, one file walks its own. A step has to keep the rule it started
   * with — the neighbouring commit may well have touched a single file, and without this
   * the walk would silently turn into that file's history after one press of `←`.
   */
  kind?: WalkKind;
  /**
   * The working-tree diff a reader stepped away from, kept so `→` can walk back into it.
   * Its sides are a status pair (`HEAD` ↔ file, `HEAD` ↔ index, `''` ↔ file) that no
   * commit position reproduces, so the pair is remembered rather than derived.
   */
  worktree?: { title?: string; entries: readonly DiffEntry[] };
}

/** Labels are how a tab is recognised; a session reads a few dozen at most. */
const LIMIT = 40;

const opened = new Map<string, OpenedDiff>();

/**
 * A tab label without the decoration VS Code adds to a multi-diff (`"<title> (3 files)"`,
 * localised, so the words are not a thing to match on — but the count always leads it).
 *
 * The title handed to `vscode.changes` is a tab's name only up to this suffix: the editor
 * input builds `"{0} ({1} files)"` from it. Everything recorded here is keyed by title, so
 * a lookup has to drop the suffix or it finds nothing — which is exactly how the arrows
 * went missing on every multi-diff.
 */
export function titleOfLabel(label: string): string {
  return label.replace(/\s*\(\d+[^()]*\)\s*$/, '');
}

export function noteDiff(
  label: string,
  entries: readonly DiffEntry[],
  worktree?: { title?: string; entries: readonly DiffEntry[] },
  kind?: WalkKind
): OpenedDiff {
  const record: OpenedDiff = {
    label,
    entries,
    ...(kind === undefined ? {} : { kind }),
    ...(worktree === undefined ? {} : { worktree }),
  };
  // Delete first so the newest note is also the newest insertion, which is what the
  // size limit below trims from.
  opened.delete(label);
  opened.set(label, record);
  while (opened.size > LIMIT) {
    const oldest = opened.keys().next();
    if (oldest.done === true) {
      break;
    }
    opened.delete(oldest.value);
  }
  return record;
}

export function openedDiff(label: string): OpenedDiff | undefined {
  return opened.get(label) ?? opened.get(titleOfLabel(label));
}

export function forgetDiff(label: string): void {
  opened.delete(label);
  opened.delete(titleOfLabel(label));
}

export function clearDiffs(): void {
  opened.clear();
}
