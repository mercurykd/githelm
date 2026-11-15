import { git } from './exec';

export interface RemoteEntry {
  name: string;
  url: string;
}

export interface UpstreamInfo {
  /** `origin/main` */
  ref: string;
  ahead: number;
  behind: number;
}

export async function listRemotes(repoPath: string): Promise<RemoteEntry[]> {
  const result = await git(repoPath, ['remote', '-v']);
  if (result.code !== 0) {
    return [];
  }
  const seen = new Map<string, RemoteEntry>();
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    if (!seen.has(match[1])) {
      seen.set(match[1], { name: match[1], url: match[2] });
    }
  }
  return [...seen.values()];
}

export async function addRemote(repoPath: string, name: string, url: string): Promise<void> {
  const result = await git(repoPath, ['remote', 'add', name, url]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git remote add failed (${result.code})`);
  }
}

export async function setRemoteUrl(repoPath: string, name: string, url: string): Promise<void> {
  const result = await git(repoPath, ['remote', 'set-url', name, url]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git remote set-url failed (${result.code})`);
  }
}

export async function removeRemote(repoPath: string, name: string): Promise<void> {
  const result = await git(repoPath, ['remote', 'remove', name]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git remote remove failed (${result.code})`);
  }
}

/** Upstream of HEAD plus how far HEAD diverged from it. */
export async function readUpstream(repoPath: string): Promise<UpstreamInfo | undefined> {
  const ref = await git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (ref.code !== 0 || !ref.stdout.trim()) {
    return undefined;
  }
  const counts = await git(repoPath, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (counts.code !== 0) {
    return { ref: ref.stdout.trim(), ahead: 0, behind: 0 };
  }
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
  return { ref: ref.stdout.trim(), ahead: ahead ?? 0, behind: behind ?? 0 };
}
