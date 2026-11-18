import { git } from './exec';

export interface TagEntry {
  name: string;
  /** Short sha of the commit the tag points at, annotated tags peeled. */
  sha: string;
  date: string;
  author: string;
  subject: string;
  /**
   * Message of an annotated tag, first paragraph only. Absent for a lightweight
   * tag, which has no message of its own.
   */
  annotation?: string;
}

interface TagRef {
  name: string;
  /** Commit the tag resolves to: `%(*objectname)` for annotated tags, `%(objectname)` otherwise. */
  commit: string;
  /** Present only when the tag itself carries a message. */
  annotation?: string;
}

interface CommitInfo {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

const SEP = '\x1f';
/** Same date shape the history graph uses, so a tag row reads like a commit row. */
const DATE_FORMAT = '%Y-%m-%d %H:%M';

export async function listTags(repoPath: string): Promise<TagEntry[]> {
  const refs = await git(repoPath, [
    'for-each-ref',
    // The message of the tag itself comes last: it can contain whitespace, and
    // only the fields before it are read by position.
    '--format=%(refname:short)\t%(objecttype)\t%(objectname)\t%(*objectname)\t%(contents:subject)',
    '--sort=-creatordate',
    'refs/tags',
  ]);
  if (refs.code !== 0) {
    return [];
  }
  const listed = refs.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): TagRef => {
      const [name, type, object, peeled, ...message] = line.split('\t');
      const annotation = message.join('\t').replace(/\s+/g, ' ').trim();
      return {
        name: name ?? line,
        commit: peeled ? peeled : object ?? '',
        // `objecttype` is `tag` only for an annotated tag; a lightweight one points
        // straight at a commit and borrows that commit's message.
        annotation: type === 'tag' && annotation ? annotation : undefined,
      };
    });
  if (listed.length === 0) {
    return [];
  }

  // The row describes the commit, so the commit is asked for directly: the sha,
  // the date and the author come from it even when the tag carries a message of
  // its own, which the row then shows in place of the commit subject.
  const wanted = [...new Set(listed.map((tag) => tag.commit))].filter(Boolean);
  const commits = new Map<string, CommitInfo>();
  if (wanted.length > 0) {
    const log = await git(repoPath, [
      'log',
      '--no-walk',
      `--date=format:${DATE_FORMAT}`,
      `--format=%H${SEP}%h${SEP}%an${SEP}%ad${SEP}%s`,
      ...wanted,
    ]);
    if (log.code === 0) {
      for (const line of log.stdout.split('\n')) {
        if (line.trim().length === 0) {
          continue;
        }
        const [full, sha, author, date, subject] = line.split(SEP);
        if (!full) {
          continue;
        }
        commits.set(full, { sha: sha ?? '', date: date ?? '', author: author ?? '', subject: subject ?? '' });
      }
    }
  }

  return listed.map((tag) => {
    const commit = commits.get(tag.commit);
    return {
      name: tag.name,
      sha: commit?.sha ?? tag.commit.slice(0, 7),
      date: commit?.date ?? '',
      author: commit?.author ?? '',
      subject: commit?.subject ?? '',
      ...(tag.annotation ? { annotation: tag.annotation } : {}),
    };
  });
}

/**
 * `git tag [-a -m <message>] <name> [<ref>]`. A missing ref means HEAD, so the
 * same command makes a tag on the current commit and on one picked in the
 * graph; a message makes it annotated, an empty one a lightweight tag.
 */
export function tagCreateArgs(name: string, message?: string, ref?: string): string[] {
  const trimmed = message?.trim();
  const args = trimmed ? ['tag', '-a', name, '-m', trimmed] : ['tag', name];
  if (ref) {
    args.push(ref);
  }
  return args;
}

export async function createTag(repoPath: string, name: string, message?: string, ref?: string): Promise<void> {
  const result = await git(repoPath, tagCreateArgs(name, message, ref));
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git tag failed (${result.code})`);
  }
}

/** Moves an existing tag onto HEAD (`git tag -f`). */
export async function moveTag(repoPath: string, name: string): Promise<void> {
  const result = await git(repoPath, ['tag', '-f', name, 'HEAD']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git tag -f failed (${result.code})`);
  }
}

/** What a tag is on a remote: the ref itself and the commit it peels to. */
export interface RemoteTag {
  /** The value of `refs/tags/<name>`: a tag object for an annotated tag. */
  ref: string;
  /** The commit, peeled — this is what a local `TagEntry.sha` compares with. */
  commit: string;
}

/**
 * `git ls-remote --tags <remote> refs/tags/<name>` prints the ref and, for an
 * annotated tag, a second `^{}` line with the commit it points at.
 */
export function parseRemoteTag(output: string, name: string): RemoteTag | undefined {
  let ref: string | undefined;
  let commit: string | undefined;
  for (const line of output.split('\n')) {
    const [sha, path] = line.trim().split(/\s+/);
    if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
      continue;
    }
    if (path === `refs/tags/${name}`) {
      ref = sha;
    } else if (path === `refs/tags/${name}^{}`) {
      commit = sha;
    }
  }
  return ref ? { ref, commit: commit ?? ref } : undefined;
}

/** The tag as the remote has it right now, or `undefined` when it is not there. */
export async function remoteTag(repoPath: string, remote: string, name: string): Promise<RemoteTag | undefined> {
  const result = await git(repoPath, ['ls-remote', '--tags', remote, `refs/tags/${name}`]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ls-remote failed (${result.code})`);
  }
  return parseRemoteTag(result.stdout, name);
}

/**
 * `git push` for one tag. A tag update is never a fast-forward, so the push has
 * to be forced — and the force is leased against the value the tag has on the
 * remote at this moment. The explicit `<refname>:<expect>` form is the only lease
 * that can work here: every other form compares with a remote-tracking ref, and a
 * tag has none, which is why a plain `--force-with-lease` is rejected with
 * "stale info". Without a lease the push overwrites whatever is on the remote.
 */
export function tagPushArgs(name: string, remote: string, expect?: string): string[] {
  const args = ['push'];
  if (expect) {
    args.push(`--force-with-lease=refs/tags/${name}:${expect}`);
  }
  args.push(remote, `refs/tags/${name}`);
  return args;
}

export async function pushTag(repoPath: string, remote: string, name: string): Promise<void> {
  const onRemote = await remoteTag(repoPath, remote, name);
  const result = await git(repoPath, tagPushArgs(name, remote, onRemote?.ref));
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git push failed (${result.code})`);
  }
}

/**
 * `git push <remote> --delete refs/tags/<name>`. The full ref is spelled out so a
 * branch of the same name is never what gets deleted.
 */
export function tagDeleteRemoteArgs(name: string, remote: string): string[] {
  return ['push', remote, '--delete', `refs/tags/${name}`];
}

/** Removes the tag on the remote; the local tag stays where it is. */
export async function deleteRemoteTag(repoPath: string, remote: string, name: string): Promise<void> {
  const result = await git(repoPath, tagDeleteRemoteArgs(name, remote));
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git push --delete failed (${result.code})`);
  }
}

export async function deleteTag(repoPath: string, name: string): Promise<void> {
  const result = await git(repoPath, ['tag', '-d', name]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git tag -d failed (${result.code})`);
  }
}
