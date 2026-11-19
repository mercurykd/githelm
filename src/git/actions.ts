import { git } from './exec';

export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  const result = await git(repoPath, ['checkout', branch]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git checkout failed (${result.code})`);
  }
}

export async function createBranch(repoPath: string, name: string, at?: string): Promise<void> {
  const args = ['checkout', '-b', name];
  if (at) {
    args.push(at);
  }
  const result = await git(repoPath, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git checkout -b failed (${result.code})`);
  }
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const result = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

export interface BranchEntry {
  name: string;
  current: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  subject: string;
  isRemote: boolean;
  /** HEAD points at this branch, but it has no commit yet — `git init` and nothing more. */
  unborn?: boolean;
}

const REF_FORMAT = '--format=%(refname:short)	%(HEAD)	%(upstream:short)	%(upstream:track)	%(contents:subject)';

function parseBranchLine(line: string, isRemote: boolean): BranchEntry {
  const [name = line, head = '', upstream = '', track = '', subject = ''] = line.split('\t');
  const ahead = Number.parseInt(/ahead (\d+)/.exec(track)?.[1] ?? '0', 10) || 0;
  const behind = Number.parseInt(/behind (\d+)/.exec(track)?.[1] ?? '0', 10) || 0;
  return { name, current: head === '*', upstream, ahead, behind, subject, isRemote };
}

async function readRefs(repoPath: string, ref: 'refs/heads' | 'refs/remotes', isRemote: boolean): Promise<BranchEntry[]> {
  const result = await git(repoPath, ['for-each-ref', REF_FORMAT, ref]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => parseBranchLine(line, isRemote))
    .filter((entry) => !entry.name.endsWith('/HEAD'));
}

export async function listBranchEntries(repoPath: string, includeRemote: boolean): Promise<BranchEntry[]> {
  const local = await readRefs(repoPath, 'refs/heads', false);
  const remote = includeRemote ? await readRefs(repoPath, 'refs/remotes', true) : [];
  if (local.length === 0) {
    // A repository that has just been initialised has an unborn HEAD: the branch
    // name exists in `.git/HEAD` but `refs/heads` is still empty, so git lists no
    // branches at all while `git status` reports the name. Show that branch, or
    // the screen looks broken right after `git init`.
    const unborn = await unbornBranch(repoPath);
    if (unborn) {
      return [
        { name: unborn, current: true, upstream: '', ahead: 0, behind: 0, subject: '', isRemote: false, unborn: true },
        ...remote,
      ];
    }
  }
  return [...local, ...remote];
}

/** The branch HEAD points at when it has no commit yet, if that is the case. */
async function unbornBranch(repoPath: string): Promise<string | undefined> {
  const result = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const name = result.stdout.trim();
  return result.code === 0 && name ? name : undefined;
}

export async function deleteBranch(repoPath: string, name: string, force = false): Promise<void> {
  const result = await git(repoPath, ['branch', force ? '-D' : '-d', name]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git branch -d failed (${result.code})`);
  }
}

export async function renameBranch(repoPath: string, from: string, to: string): Promise<void> {
  const result = await git(repoPath, ['branch', '-m', from, to]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git branch -m failed (${result.code})`);
  }
}

export async function setUpstream(repoPath: string, branch: string, upstream: string): Promise<void> {
  const result = await git(repoPath, ['branch', `--set-upstream-to=${upstream}`, branch]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git branch --set-upstream-to failed (${result.code})`);
  }
}

export async function cherryPick(repoPath: string, sha: string): Promise<void> {
  const result = await git(repoPath, ['cherry-pick', sha]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `git cherry-pick завершился с кодом ${result.code}. Если это конфликт — разрешите его и выполните git cherry-pick --continue.`
    );
  }
}

export async function showCommit(repoPath: string, sha: string, maxLines = 3000): Promise<string> {
  const result = await git(repoPath, [
    'show',
    '--no-color',
    '--stat',
    '--patch',
    '--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n',
    sha,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git show failed (${result.code})`);
  }
  const lines = result.stdout.split('\n');
  if (lines.length <= maxLines) {
    return result.stdout;
  }
  return `${lines.slice(0, maxLines).join('\n')}\n… (обрезано: ${lines.length - maxLines} строк, полный коммит откройте в терминале)\n`;
}
