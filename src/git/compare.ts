import { t } from '../i18n';
import { git } from './exec';

export type CompareMode = 'two' | 'three';

/** The six ways to compare two commits, in the order both UIs list them. */
export type CompareChoice = 'diff-two' | 'diff-three' | 'diff-swapped' | 'log-two' | 'log-three' | 'log-swapped';

/** `A..B` (two dots) or `A...B` (three dots, from the merge base). */
export function compareRange(a: string, b: string, mode: CompareMode): string {
  return `${a}${mode === 'three' ? '...' : '..'}${b}`;
}

/**
 * The quick pick of a compare, shared by the history buffer and the history panel: the
 * same six choices in the same order, so the panel cannot grow a menu of its own.
 */
export function compareChoices(): { label: string; value: CompareChoice }[] {
  return [
    { label: t('compare.diffTwo'), value: 'diff-two' },
    { label: t('compare.diffThree'), value: 'diff-three' },
    { label: t('compare.diffSwapped'), value: 'diff-swapped' },
    { label: t('compare.logTwo'), value: 'log-two' },
    { label: t('compare.logThree'), value: 'log-three' },
    { label: t('compare.logSwapped'), value: 'log-swapped' },
  ];
}

/** A `diff-*` choice opens the patch, a `log-*` choice opens the graph of the range. */
export function choiceShowsDiff(choice: CompareChoice): boolean {
  return choice.startsWith('diff-');
}

/** A `...` choice reads from the merge base, and so does its diff. */
export function choiceMode(choice: CompareChoice): CompareMode {
  return choice === 'diff-three' || choice === 'log-three' ? 'three' : 'two';
}

/** `B..A`: the sides are swapped, which is a different question, not a different view. */
export function choiceSwaps(choice: CompareChoice): boolean {
  return choice.endsWith('swapped');
}

/** One choice, worked out: what to read, what to call it, and what to diff. */
export interface ComparePlan {
  /** The range as the reader spells it — `feature/x..HEAD`. */
  label: string;
  /** The range git is asked for: the sides of the choice, swapped if it swaps them. */
  range: string;
  mode: CompareMode;
  /** The range's own sides, which is what `git diff A...B` knows how to read. */
  from: string;
  to: string;
  /** The left side of a side-by-side view: the merge base for `...`, else `from`. */
  diffLeft: string;
  /** The right side of a side-by-side view. */
  diffRight: string;
}

/**
 * The choice the reader picked, turned into a range and its sides. Both screens ask the
 * same six questions, so they answer them here rather than in two places: a swapped
 * choice swaps the range, and a `...` choice keeps `A...B` for git while pointing its
 * side-by-side view at the merge base — `git diff A...B` is `git diff $(merge-base) B`,
 * and using `A` there would show the changes `A` carries that `B` does not.
 */
export async function planCompare(
  repoPath: string,
  choice: CompareChoice,
  a: string,
  b: string,
  aLabel: string,
  bLabel: string
): Promise<ComparePlan> {
  const mode = choiceMode(choice);
  const swapped = choiceSwaps(choice);
  const from = swapped ? b : a;
  const to = swapped ? a : b;
  const diffLeft = mode === 'three' ? ((await mergeBase(repoPath, from, to)) ?? from) : from;
  return {
    label: compareRange(swapped ? bLabel : aLabel, swapped ? aLabel : bLabel, mode),
    range: compareRange(from, to, mode),
    mode,
    from,
    to,
    diffLeft,
    diffRight: to,
  };
}

/**
 * The commit a branch or tag names, or nothing — the same "look it up again" every other
 * key does, so a row deleted in another window compares nothing instead of comparing the
 * wrong thing. An option-shaped ref is refused before git sees it.
 */
export async function refTip(repoPath: string, ref: string): Promise<string | undefined> {
  if (ref.length === 0 || ref.startsWith('-')) {
    return undefined;
  }
  const result = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
}

export async function compareDiff(repoPath: string, a: string, b: string, mode: CompareMode): Promise<string> {
  const range = compareRange(a, b, mode);
  const result = await git(repoPath, ['diff', '--no-color', '--no-ext-diff', range]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git diff ${range} failed (${result.code})`);
  }
  return result.stdout.length > 0 ? result.stdout : `(empty: ${range})\n`;
}

/**
 * The files that differ across the range, with the status letter `git diff --name-status`
 * prints. A rename is listed under its new path, which is the file the diff editor shows.
 */
export interface CompareChange {
  status: string;
  path: string;
}

export async function compareChanges(repoPath: string, range: string): Promise<CompareChange[]> {
  const result = await git(repoPath, ['diff', '--no-color', '--name-status', '-M', '--no-ext-diff', range]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git diff --name-status ${range} failed (${result.code})`);
  }
  const changes: CompareChange[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const [status = '', firstPath = '', secondPath = ''] = line.split('\t');
    if (firstPath.length === 0) {
      continue;
    }
    changes.push({ status: status.slice(0, 1), path: (secondPath || firstPath).trim() });
  }
  return changes;
}

/**
 * The repository-relative paths whose content differs across the range — what a
 * side-by-side diff of two commits needs to know before it can open. `-z` keeps a path
 * with a space or a quote in it one entry, and renames are listed under their new name,
 * which is the file the diff editor shows.
 */
export async function compareFiles(repoPath: string, range: string): Promise<string[]> {
  const result = await git(repoPath, ['diff', '--name-only', '--no-ext-diff', '-z', range]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git diff --name-only ${range} failed (${result.code})`);
  }
  return result.stdout.split('\0').filter((entry) => entry.length > 0);
}

/**
 * The commit a `...` range starts at. `git diff A...B` is `git diff $(merge-base A B) B`,
 * so a side-by-side view of it has to name the merge base as its left side; the commit A
 * itself would show the changes A carries that B does not.
 */
export async function mergeBase(repoPath: string, a: string, b: string): Promise<string | undefined> {
  const result = await git(repoPath, ['merge-base', a, b]);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{4,64}$/i.test(sha) ? sha : undefined;
}

export async function headSha(repoPath: string): Promise<string> {
  const result = await git(repoPath, ['rev-parse', 'HEAD']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git rev-parse HEAD failed');
  }
  return result.stdout.trim();
}
