import * as path from 'node:path';
import * as vscode from 'vscode';
import { firstParent } from '../git/commitView';
import {
  chainIndex,
  changedFiles,
  fileChain,
  readPair,
  repoChain,
  resolveCommit,
  stepChain,
} from '../git/diffWalk';
import type { WalkKind, WalkPosition, WalkStep } from '../git/diffWalk';
import { repoRelativePath } from '../git/fileHistory';
import { findRepoRoot } from '../git/repo';
import { t } from '../i18n';
import { openDiffEntries, openRevisionDiffs } from '../webview/panel';
import { forgetDiff, noteDiff, openedDiff } from './diffWalkState';
import type { DiffEntry, OpenedDiff } from './diffWalkState';

/** Context keys: whether a diff is walkable at all, and whether each arrow does anything. */
export const WALK_CONTEXT = 'githelm.diffWalk';
export const PREV_CONTEXT = 'githelm.diffPrev';
export const NEXT_CONTEXT = 'githelm.diffNext';

/**
 * A diff read as a point on a history, plus the working-tree diff it may sit above.
 *
 * `←` and `→` are the same rule in both directions: the neighbouring commit in the chain
 * the walk follows, and that commit's own diff `(its first parent, itself)` — the pair the
 * commit and history screens open. Nothing is remembered except the working-tree pair,
 * because a status diff (`HEAD` ↔ file, `HEAD` ↔ index, index ↔ file) is the one pair no
 * commit position reproduces.
 */
/** The two sides of one file of a multi-diff, as the tab input reports them. */
interface DiffSide {
  original: vscode.Uri;
  modified: vscode.Uri;
}

/** Whether a value read off a tab input is a URI: `Uri.isUri` itself is not in the typings. */
const isUri = (value: unknown): value is vscode.Uri => {
  const candidate = value as { scheme?: unknown; path?: unknown } | undefined;
  return typeof candidate?.scheme === 'string' && typeof candidate.path === 'string';
};

interface Walk {
  repo: string;
  kind: WalkKind;
  /** The file of a single-file walk; the whole tree for a `repo` walk. */
  file?: string;
  position: WalkPosition;
  worktree?: { title?: string; entries: readonly DiffEntry[] };
}

/** What a step opens: a revision pair for a commit position, or the stored status diff. */
interface Target {
  repo: string;
  files?: readonly string[];
  left?: string;
  right?: string;
  entries?: readonly DiffEntry[];
  title?: string;
  /** Name the tab after the commit, even when the commit touched a single file. */
  nameSingle?: boolean;
}

export interface DiffWalk {
  /** One press of `←` (older) or `→` (newer). */
  run(step: WalkStep): Promise<void>;
  /** Recompute the context keys for whatever tab is active now. */
  sync(): Promise<void>;
}

export function createDiffWalk(options: { notice: (text: string) => void }): DiffWalk {
  let applied: string | undefined;
  let generation = 0;
  let lastLabel: string | undefined;
  let lastWalk: Walk | undefined;

  const setContext = (key: string, value: boolean): Thenable<unknown> =>
    vscode.commands.executeCommand('setContext', key, value);

  /**
   * Whether a tab can be showing a diff at all.
   *
   * A registry record is keyed by the label its opener gave the tab, and a label is not
   * guaranteed to be unique across kinds: a commit screen is `<sha8> — <subject>`, which a
   * multi-diff of `<sha8> — <count>` can read like. A webview or a text tab must never be
   * mistaken for a diff, because a step *closes* the tab it replaced — that mistake would
   * close a screen, not a diff.
   */
  const canHoldDiff = (input: unknown): boolean =>
    !(input instanceof vscode.TabInputWebview) && !(input instanceof vscode.TabInputText);

  /**
   * The walk of a tab, or undefined when its two sides are not a step in a history.
   *
   * A single-file diff says everything by itself: its sides are `git:` revision URIs whose
   * query carries the path and the ref. A multi-diff says it too, through the per-file pairs
   * of its input, which current builds fill in for the extension host; when they do not, the
   * openers in `panel.ts` have recorded what they opened and the label finds it.
   */
  const walkOf = async (tab: vscode.Tab): Promise<Walk | undefined> => {
    if (!canHoldDiff(tab.input)) {
      return undefined;
    }
    const record = openedDiff(tab.label);
    if (record !== undefined) {
      return walkFromOpened(record);
    }
    const sides = multiDiffSides(tab.input);
    if (sides !== undefined) {
      return walkFromSides(sides);
    }
    const input = tab.input;
    if (input instanceof vscode.TabInputTextDiff) {
      return walkFromPair(input.original, input.modified, tab.label);
    }
    return undefined;
  };

  const walkFromOpened = async (record: OpenedDiff): Promise<Walk | undefined> => {
    const first = record.entries[0];
    const plan = first === undefined ? undefined : await walkFromPair(first.left, first.right, first.title);
    if (plan === undefined) {
      return undefined;
    }
    // One file is its own history; a list of files is the repository's, one commit per step.
    // A step records the rule it used, and it wins over the count: stepping from a commit
    // that changed three files onto one that changed a single file still opens that file's
    // change, but the walk stays on the repository's history — otherwise `←` would quietly
    // become "the previous change of this file" after the first press.
    const kind: WalkKind = record.kind ?? (record.entries.length > 1 ? 'repo' : plan.kind);
    // The working-tree pair travels with the diff: a reader who stepped away from a status
    // diff can step back into it, and the pair is re-opened verbatim rather than rebuilt.
    const worktree =
      record.worktree ??
      (plan.position.kind === 'worktree'
        ? { title: record.label, entries: record.entries }
        : undefined);
    return { repo: plan.repo, kind, file: plan.file, position: plan.position, worktree };
  };

  /**
   * The diff pairs a multi-diff tab is showing, read off its input.
   *
   * There is no `TabInputTextMultiDiff` in the typings this extension compiles against, and
   * the property carrying the pairs was renamed once: the installed build puts them in
   * `textDiffs`, newer ones in `diffEditors`. Both are an array of `{ original, modified }`
   * URI pairs, so the list is read by shape and either name will do. Anything else — a text
   * tab, a webview, a single diff — is not this.
   */
  const multiDiffSides = (input: unknown): readonly DiffSide[] | undefined => {
    if (input === null || typeof input !== 'object') {
      return undefined;
    }
    const holder = input as { diffEditors?: unknown; textDiffs?: unknown };
    const editors = holder.diffEditors ?? holder.textDiffs;
    if (!Array.isArray(editors) || editors.length === 0) {
      return undefined;
    }
    const sides: DiffSide[] = [];
    for (const editor of editors) {
      const pair = editor as { original?: unknown; modified?: unknown } | undefined;
      const original = pair?.original;
      const modified = pair?.modified;
      if (!isUri(original) || !isUri(modified)) {
        return undefined;
      }
      sides.push({ original, modified });
    }
    return sides;
  };

  /** The last segment of a side's path, for a title the tab itself does not carry. */
  const fileName = (uri: vscode.Uri): string => {
    const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    return name === '' ? uri.path : name;
  };

  /** A multi-diff as a walk: the rule of a recorded diff, applied to what the tab reports. */
  const walkFromSides = async (sides: readonly DiffSide[]): Promise<Walk | undefined> => {
    const first = sides[0];
    if (first === undefined) {
      return undefined;
    }
    const entries: DiffEntry[] = sides.map((side) => ({
      title: `${fileName(side.modified)} ↔ ${fileName(side.original)}`,
      left: side.original,
      right: side.modified,
    }));
    const plan = await walkFromPair(first.original, first.modified, entries[0].title);
    if (plan === undefined) {
      return undefined;
    }
    // One file is its own history; a list of files is the repository's, one commit per step.
    const kind: WalkKind = sides.length > 1 ? 'repo' : plan.kind;
    // A status diff read here has no title of ours, so it is re-opened under the default.
    const worktree =
      plan.position.kind === 'worktree' ? { entries } : plan.worktree;
    return { repo: plan.repo, kind, file: plan.file, position: plan.position, worktree };
  };

  const walkFromPair = async (
    left: vscode.Uri,
    right: vscode.Uri,
    title: string
  ): Promise<Walk | undefined> => {
    const shape = readPair(left, right);
    if (shape === undefined) {
      return undefined;
    }
    const repo = await findRepoRoot(path.dirname(shape.path));
    if (repo === undefined) {
      return undefined;
    }
    const file = repoRelativePath(repo, shape.path);
    if (shape.kind === 'worktree') {
      return {
        repo,
        kind: 'file',
        file,
        position: { kind: 'worktree' },
        worktree: { title, entries: [{ title, left, right }] },
      };
    }
    const sha = await resolveCommit(repo, shape.right);
    if (sha === undefined) {
      return undefined;
    }
    const parent = await firstParent(repo, sha);
    if (parent === undefined) {
      // A root commit has no earlier side, so the screens show its files instead of a diff.
      return undefined;
    }
    if ((await resolveCommit(repo, shape.left)) !== parent) {
      // Not "a commit and its first parent": a compare range, a stash, a two-sided diff.
      return undefined;
    }
    return { repo, kind: 'file', file, position: { kind: 'commit', sha } };
  };

  /** The commits a walk steps through, newest first. */
  const chainOf = async (walk: Walk): Promise<readonly string[]> => {
    if (walk.kind === 'file' && walk.file !== undefined) {
      return fileChain(walk.repo, walk.file);
    }
    const head = await repoChain(walk.repo, 'HEAD');
    const sha = walk.position.kind === 'commit' ? walk.position.sha : undefined;
    if (sha === undefined || chainIndex(head, sha) >= 0) {
      return head;
    }
    // A commit off the checked-out branch, reached through the graph: its own first-parent
    // history answers `←`, and `→` has no commit to offer rather than a guessed one.
    return repoChain(walk.repo, sha);
  };

  const stepTo = async (
    walk: Walk,
    step: WalkStep,
    chain?: readonly string[]
  ): Promise<WalkPosition | undefined> => {
    if (walk.position.kind === 'worktree') {
      if (step === 'newer') {
        return undefined;
      }
      const tip = (chain ?? (await chainOf(walk)))[0];
      return tip === undefined ? undefined : { kind: 'commit', sha: tip };
    }
    const sha = walk.position.sha;
    const commits = chain ?? (await chainOf(walk));
    const sibling = stepChain(commits, sha, step);
    if (sibling !== undefined) {
      return { kind: 'commit', sha: sibling };
    }
    const at = chainIndex(commits, sha);
    if (step === 'newer') {
      // The tip of the walk: the working tree, when the reader came from there.
      return at === 0 && walk.worktree !== undefined ? { kind: 'worktree' } : undefined;
    }
    if (at < 0) {
      const parent = await firstParent(walk.repo, sha);
      if (parent !== undefined) {
        return { kind: 'commit', sha: parent };
      }
    }
    return undefined;
  };

  const targetFor = async (walk: Walk, position: WalkPosition): Promise<Target | undefined> => {
    if (position.kind === 'worktree') {
      const worktree = walk.worktree;
      return worktree === undefined
        ? undefined
        : { repo: walk.repo, entries: worktree.entries, title: worktree.title };
    }
    const parent = await firstParent(walk.repo, position.sha);
    if (parent === undefined) {
      return undefined;
    }
    if (walk.kind === 'file' && walk.file !== undefined) {
      return { repo: walk.repo, files: [walk.file], left: parent, right: position.sha };
    }
    // A commit is the unit of this walk, so the tab says which commit it shows, even when
    // that commit touched one file: "<sha> — 1" is the same kind of tab as "<sha> — 3", and
    // a single-file pair there would read as the file's own history.
    return {
      repo: walk.repo,
      files: await changedFiles(walk.repo, parent, position.sha),
      left: parent,
      right: position.sha,
      nameSingle: true,
    };
  };

  /** Whether a step leads anywhere: a position whose own diff can be built. */
  const canStep = async (
    walk: Walk,
    step: WalkStep,
    chain: readonly string[]
  ): Promise<boolean> => {
    const next = await stepTo(walk, step, chain);
    if (next === undefined) {
      return false;
    }
    return next.kind === 'worktree'
      ? walk.worktree !== undefined
      : (await firstParent(walk.repo, next.sha)) !== undefined;
  };

  const open = (target: Target): Promise<OpenedDiff | undefined> => {
    if (target.entries !== undefined) {
      return openDiffEntries(target.entries, target.title);
    }
    if (target.files === undefined || target.left === undefined || target.right === undefined) {
      return Promise.resolve(undefined);
    }
    return openRevisionDiffs(
      target.repo,
      target.files,
      target.left,
      target.right,
      target.right.slice(0, 8),
      target.nameSingle === true
    );
  };

  /** The cursor line, so a step does not drop the reader at the top of the file. */
  const reveal = (line: number): void => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      return;
    }
    const target = Math.max(0, Math.min(line, editor.document.lineCount - 1));
    editor.selection = new vscode.Selection(target, 0, target, 0);
    editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const nameOf = (position: WalkPosition): string =>
    position.kind === 'worktree' ? t('diff.side.worktree') : position.sha.slice(0, 8);

  const run = async (step: WalkStep): Promise<void> => {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (tab === undefined) {
      return;
    }
    const walk = await walkOf(tab);
    if (walk === undefined) {
      return;
    }
    const next = await stepTo(walk, step);
    const target = next === undefined ? undefined : await targetFor(walk, next);
    if (next === undefined || target === undefined) {
      options.notice(t('diff.walk.noFurther'));
      return;
    }
    if (target.files !== undefined && target.files.length === 0) {
      options.notice(t('diff.walk.noFiles', { ref: nameOf(next) }));
      return;
    }
    const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const opened = await open(target);
    if (opened === undefined) {
      options.notice(t('diff.walk.noFiles', { ref: nameOf(next) }));
      return;
    }
    // VS Code cannot change the sides of an open diff, so the step is a new tab: the pair
    // for the neighbouring commit takes this one's place, and this one is closed. The tab
    // count stays at one; the tab itself moves to the end of its group.
    forgetDiff(tab.label);
    noteDiff(opened.label, opened.entries, walk.worktree, walk.kind);
    await vscode.window.tabGroups.close(tab, true);
    reveal(line);
    await sync();
  };

  const sync = async (): Promise<void> => {
    const mine = ++generation;
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    // Reading a tab costs a few git calls, and the active editor changes on every click
    // between the two sides of the same diff: a label names one tab, so one read is enough.
    let walk: Walk | undefined;
    if (tab === undefined) {
      walk = undefined;
    } else if (tab.label === lastLabel) {
      walk = lastWalk;
    } else {
      try {
        walk = await walkOf(tab);
      } catch {
        // A repository that cannot answer must not leave the icons in a wrong state.
        walk = undefined;
      }
    }
    lastLabel = tab?.label;
    lastWalk = walk;
    const key =
      walk === undefined || tab === undefined
        ? ''
        : `${tab.label}\u0000${walk.position.kind === 'worktree' ? 'worktree' : walk.position.sha}`;
    if (key === applied) {
      return;
    }
    let older = false;
    let newer = false;
    if (walk !== undefined) {
      try {
        const chain = await chainOf(walk);
        older = await canStep(walk, 'older', chain);
        newer = await canStep(walk, 'newer', chain);
      } catch {
        // Keep both arrows off: a wrong arrow is worse than a missing one.
      }
    }
    if (mine !== generation) {
      return;
    }
    applied = key;
    await setContext(WALK_CONTEXT, walk !== undefined);
    await setContext(PREV_CONTEXT, older);
    await setContext(NEXT_CONTEXT, newer);
  };

  return { run, sync };
}
