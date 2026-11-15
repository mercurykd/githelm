import { git } from './exec';

/**
 * `git submodule status` marks every entry with one character:
 * a space when the checkout matches the recorded commit, `+` when it points to a
 * different commit, `-` when the submodule is not initialized, `U` on conflicts.
 */
export type SubmoduleState = 'ok' | 'modified' | 'uninitialized' | 'conflict';

export interface Submodule {
  /** Path relative to the parent repository. */
  path: string;
  /** Commit recorded in the parent repository. */
  sha: string;
  state: SubmoduleState;
  /** `git describe` of the checked-out commit, when git printed one. */
  describe?: string;
}

const STATE_BY_MARK: Record<string, SubmoduleState> = {
  ' ': 'ok',
  '+': 'modified',
  '-': 'uninitialized',
  U: 'conflict',
};

export function parseSubmoduleStatus(raw: string): Submodule[] {
  const submodules: Submodule[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const state = STATE_BY_MARK[line[0]];
    if (!state) {
      continue;
    }
    const rest = line.slice(1).trim();
    const space = rest.indexOf(' ');
    if (space <= 0) {
      continue;
    }
    const sha = rest.slice(0, space);
    const remainder = rest.slice(space + 1).trim();
    const describe = /\(([^()]*)\)\s*$/.exec(remainder);
    const subPath = (describe && describe.index !== undefined ? remainder.slice(0, describe.index) : remainder).trim();
    if (subPath.length === 0) {
      continue;
    }
    submodules.push({
      path: subPath,
      sha,
      state,
      ...(describe ? { describe: describe[1] } : {}),
    });
  }
  return submodules;
}

export interface SubmoduleStatus {
  submodules: Submodule[];
  /** Why the list is empty, when git refused to produce it. */
  error?: string;
}

/**
 * Submodules of the repository, nested ones included. `git submodule` is a shell
 * script, so it can fail for reasons that have nothing to do with submodules
 * (a sandbox that blocks `sh`, a broken PATH); the reason travels with the empty
 * list so the screen can say "unavailable" instead of "none".
 */
export async function readSubmoduleStatus(repoPath: string): Promise<SubmoduleStatus> {
  const result = await git(repoPath, ['submodule', 'status', '--recursive']);
  if (result.code !== 0) {
    return { submodules: [], error: result.stderr.trim() || `git submodule status failed (${result.code})` };
  }
  return { submodules: parseSubmoduleStatus(result.stdout) };
}

/** Submodules only, for callers that cannot tell "none" from "unknown". */
export async function readSubmodules(repoPath: string): Promise<Submodule[]> {
  return (await readSubmoduleStatus(repoPath)).submodules;
}

export function submoduleUpdateArgs(
  subPath: string | undefined,
  opts: { init?: boolean; remote?: boolean } = {}
): string[] {
  const args = ['submodule', 'update'];
  if (opts.init) {
    args.push('--init');
  }
  if (opts.remote) {
    args.push('--remote');
  }
  if (subPath) {
    args.push('--', subPath);
  }
  return args;
}

/**
 * Checks a submodule out at the commit the parent records (`--remote` instead
 * follows the branch configured in .gitmodules, which is how a submodule is
 * brought up to date with its own upstream).
 */
export async function updateSubmodule(
  repoPath: string,
  subPath: string | undefined,
  opts: { init?: boolean; remote?: boolean } = {}
): Promise<void> {
  const args = submoduleUpdateArgs(subPath, opts);
  const result = await git(repoPath, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed (${result.code})`);
  }
}
