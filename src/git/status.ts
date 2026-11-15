import { git } from './exec';

export type StatusSection = 'staged' | 'unstaged' | 'untracked' | 'conflict';

export interface StatusEntry {
  section: StatusSection;
  /** Two-letter porcelain code, e.g. ` M`, `M `, `A `, `??`, `UU`. */
  xy: string;
  path: string;
  origPath?: string;
}

export interface RepoStatus {
  branch?: string;
  ahead: number;
  behind: number;
  head?: string;
  headSubject?: string;
  entries: StatusEntry[];
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function parseBranchHeader(header: string, status: RepoStatus): void {
  const rest = header.trim();
  if (!rest) {
    return;
  }
  if (rest.startsWith('No commits yet on ')) {
    status.branch = rest.slice('No commits yet on '.length);
    return;
  }
  if (rest.startsWith('HEAD (no branch)')) {
    status.branch = '(detached)';
    return;
  }
  const bracket = /\[([^\]]+)\]/.exec(rest);
  if (bracket) {
    for (const part of bracket[1].split(',')) {
      const token = part.trim();
      if (token.startsWith('ahead ')) {
        status.ahead = Number.parseInt(token.slice('ahead '.length), 10) || 0;
      } else if (token.startsWith('behind ')) {
        status.behind = Number.parseInt(token.slice('behind '.length), 10) || 0;
      }
    }
  }
  status.branch = rest.split('...')[0].trim();
}

/**
 * Parses `git status --porcelain=v1 -z --branch` output.
 * With `-z`, records are NUL-separated and rename entries append the original path as an extra record.
 */
export function parseStatus(raw: string): RepoStatus {
  const status: RepoStatus = { ahead: 0, behind: 0, entries: [] };
  const records = raw.split('\0');

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) {
      continue;
    }
    if (record.startsWith('## ')) {
      parseBranchHeader(record.slice(3), status);
      continue;
    }
    if (record.startsWith('?? ')) {
      status.entries.push({ section: 'untracked', xy: '??', path: record.slice(3) });
      continue;
    }
    if (record.startsWith('!! ')) {
      continue; // ignored files, only present with --ignored
    }
    if (record.length < 4 || record[2] !== ' ') {
      continue;
    }

    const xy = record.slice(0, 2);
    const path = record.slice(3);
    let origPath: string | undefined;
    if (xy[0] === 'R' || xy[0] === 'C') {
      origPath = records[i + 1];
      i++;
    }

    if (UNMERGED.has(xy)) {
      status.entries.push({ section: 'conflict', xy, path, ...(origPath ? { origPath } : {}) });
      continue;
    }
    if (xy[0] !== ' ') {
      status.entries.push({ section: 'staged', xy: `${xy[0]} `, path, ...(origPath ? { origPath } : {}) });
    }
    if (xy[1] !== ' ') {
      status.entries.push({ section: 'unstaged', xy: ` ${xy[1]}`, path, ...(origPath ? { origPath } : {}) });
    }
  }

  return status;
}

export async function readStatus(repoPath: string): Promise<RepoStatus> {
  const result = await git(repoPath, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
  if (result.code !== 0) {
    throw new Error(`git status failed (${result.code}): ${result.stderr.trim()}`);
  }
  const status = parseStatus(result.stdout);

  const log = await git(repoPath, ['log', '-1', '--no-color', '--format=%h%x1f%s']);
  if (log.code === 0) {
    const [hash, subject] = log.stdout.trim().split('\x1f');
    if (hash) {
      status.head = hash;
    }
    if (subject !== undefined) {
      status.headSubject = subject;
    }
  }
  return status;
}

export function sectionTitle(section: StatusSection): string {
  switch (section) {
    case 'staged':
      return 'staged';
    case 'unstaged':
      return 'unstaged';
    case 'untracked':
      return 'untracked';
    case 'conflict':
      return 'conflicts';
  }
}

export function entriesOf(status: RepoStatus, section: StatusSection): StatusEntry[] {
  return status.entries.filter((entry) => entry.section === section);
}
