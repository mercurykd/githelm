import { git } from './exec';

/**
 * A `git:` revision URI read back into the path and the ref it names.
 *
 * The built-in git extension serves `git:/<path>?{"path":"<fs path>","ref":"<ref>"}`, which
 * is exactly what `revisionUri()` in `src/webview/panel.ts` writes, so a diff tab of two
 * such URIs says by itself which repository, which file and which two revisions it
 * compares — no registry, and a tab reopened after a window reload is still understood.
 */
export interface RevisionRef {
  path: string;
  ref: string;
}

export function parseRevisionUri(scheme: string, query: string): RevisionRef | undefined {
  if (scheme !== 'git' || query.length === 0) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(query);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { path, ref } = raw as { path?: unknown; ref?: unknown };
  if (typeof path !== 'string' || path.length === 0 || typeof ref !== 'string') {
    return undefined;
  }
  return { path, ref };
}

/** A stage number (`:1`, `:2`, `:3`) is a conflict side, not a revision the walk can step. */
export function isStageRef(ref: string): boolean {
  return ref.startsWith(':');
}

/**
 * A stash is a commit, and `stash@{0}^` happens to be its first parent, so a stash diff
 * looks exactly like a commit pair from the outside. It is not a position in the
 * repository's history, though — no chain holds it, no screen lists it — so it is refused
 * by name rather than walked into the commit it was stashed on.
 */
export function isStashRef(ref: string): boolean {
  return ref.includes('stash@{');
}

/** The two sides of a diff tab, as far as their URIs go. */
export interface SideUri {
  scheme: string;
  query: string;
}

/**
 * What a diff's two sides say, when they are worth walking at all.
 *
 * `revisions` still has to prove it is "a commit and its first parent" — that needs git, so
 * the caller resolves the two refs and compares. Everything that is *not* a step in a
 * history at all is answered here: a conflict stage, a stash, two files on disk, sides of
 * different files, or a `githelm:` buffer pretending to be a diff.
 */
export type PairShape =
  | { kind: 'worktree'; path: string }
  | { kind: 'revisions'; path: string; left: string; right: string };

export function readPair(left: SideUri, right: SideUri): PairShape | undefined {
  if (left.scheme !== 'git') {
    return undefined;
  }
  const leftRef = parseRevisionUri(left.scheme, left.query);
  if (leftRef === undefined || isStageRef(leftRef.ref) || isStashRef(leftRef.ref)) {
    return undefined;
  }
  const rightRef = right.scheme === 'git' ? parseRevisionUri(right.scheme, right.query) : undefined;
  if (rightRef !== undefined && (isStageRef(rightRef.ref) || isStashRef(rightRef.ref))) {
    return undefined;
  }
  // The newer side of a status diff is not a commit: the file on disk, or the index.
  if (right.scheme === 'file' || (rightRef !== undefined && rightRef.ref === '')) {
    return { kind: 'worktree', path: leftRef.path };
  }
  if (rightRef === undefined || rightRef.path !== leftRef.path) {
    return undefined;
  }
  return { kind: 'revisions', path: leftRef.path, left: leftRef.ref, right: rightRef.ref };
}

/** Which history a diff walks: the file's own commits, or the repository's. */
export type WalkKind = 'file' | 'repo';

/** `older` is the change before the one on screen, `newer` the one after it. */
export type WalkStep = 'older' | 'newer';

/** A point on a walk: a commit, or the working tree at the top of it. */
export type WalkPosition = { kind: 'commit'; sha: string } | { kind: 'worktree' };

/** Where `sha` sits in a newest-first chain, or -1 when it is not in it. */
export function chainIndex(chain: readonly string[], sha: string): number {
  return chain.indexOf(sha);
}

/**
 * The neighbouring commit in a newest-first chain.
 *
 * The chain only chooses *which* commit comes next; the diff of that commit is always
 * `(its first parent, itself)`, the pair the commit and history screens open. So a step
 * never depends on the two commits touching the same lines, and a commit that is not in
 * the chain (a merged branch reached from the graph) has no forward neighbour rather than
 * a guessed one.
 */
export function stepChain(chain: readonly string[], sha: string, step: WalkStep): string | undefined {
  const at = chain.indexOf(sha);
  if (at < 0) {
    return undefined;
  }
  const next = step === 'older' ? at + 1 : at - 1;
  return next >= 0 && next < chain.length ? chain[next] : undefined;
}

/** The commits that touched one file, newest first — the chain a single-file diff walks. */
export async function fileChain(
  repoPath: string,
  relativePath: string,
  limit = 200
): Promise<string[]> {
  const result = await git(repoPath, [
    'log',
    '--follow',
    '--no-color',
    '--format=%H',
    `--max-count=${limit}`,
    '--',
    relativePath,
  ]);
  return result.code === 0 ? lines(result.stdout) : [];
}

/** A first-parent chain, newest first, from `from` (a revision such as `HEAD`). */
export async function repoChain(repoPath: string, from = 'HEAD', limit = 2000): Promise<string[]> {
  const result = await git(repoPath, [
    'rev-list',
    '--first-parent',
    `--max-count=${limit}`,
    from,
  ]);
  return result.code === 0 ? lines(result.stdout) : [];
}

/** The commit a revision names, or undefined when it names no commit (a tree, a bad ref). */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | undefined> {
  const result = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = result.code === 0 ? result.stdout.trim() : '';
  return sha.length > 0 ? sha : undefined;
}

/**
 * The files that differ between two revisions, in git's own order.
 *
 * Renames are reported as a deletion plus an addition (`--no-renames`): a multi-diff of a
 * commit then shows both paths, with the empty side that says which end the file is
 * missing from — the same reading a deletion gets in the status panel.
 */
export async function changedFiles(repoPath: string, left: string, right: string): Promise<string[]> {
  const result = await git(repoPath, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    left,
    right,
  ]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout.split('\0').filter((entry) => entry.length > 0);
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
