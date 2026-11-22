import { refsLabel } from '../../git/log';
import { RemoteEntry, UpstreamInfo } from '../../git/remotes';
import { RepoStatus, StatusEntry, sectionTitle } from '../../git/status';
import { StashEntry } from '../../git/stash';
import { WorktreeEntry } from '../../git/worktree';
import { t } from '../../i18n';
import { keySegments } from '../../views/rowLabels';
import type { FileTarget } from '../../views/discardPlan';
import {
  ColorRole,
  ColumnBlockModel,
  CommitRowModel,
  FactModel,
  FactPart,
  HintModel,
  RowModel,
  SectionKind,
  SectionModel,
  StatusModel,
} from '../protocol';

/** Conflicts first, then the three sections that are always on screen. */
const SECTION_ORDER: SectionKind[] = ['conflict', 'staged', 'unstaged', 'untracked'];

export interface StatusModelInput {
  repoPath: string;
  status: RepoStatus;
  remotes: RemoteEntry[];
  stashes: StashEntry[];
  worktrees: WorktreeEntry[];
  /** The last commits, as the `last commits` block prints them. */
  commits: { shortSha: string; date: string; author: string; subject: string; refs?: string[] }[];
  upstream?: UpstreamInfo;
  /** The remote `upstream` points at, when it is configured. */
  remote?: RemoteEntry;
}

export function rowId(entry: Pick<StatusEntry, 'section' | 'path'>): string {
  return `${entry.section}:${entry.path}`;
}

/** `c commit   alt+s stage all` → `{ keys: 'c', label: 'commit' }`, `{ keys: 'alt+s', label: 'stage all' }`. */
export function parseHints(keysLine: string): HintModel[] {
  return keySegments(keysLine)
    .map((segment) => {
      const space = segment.indexOf(' ');
      return space < 0
        ? { keys: segment, label: '' }
        : { keys: segment.slice(0, space), label: segment.slice(space + 1).trim() };
    })
    .filter((hint) => hint.keys.length > 0);
}

/**
 * The tail of the branch value, split the way `divergenceSpans()` splits it in the
 * buffer: the ref in the upstream colour, the `+n` of a lead in the "added" green and
 * the `−n` of a lag in the "deleted" red. Without a configured upstream the buffer
 * prints `(ahead n, behind m)` in the metadata colour, and so does the panel. `gap` is
 * the number of spaces before a part: two open the tail, one sits between counters.
 */
function divergenceParts(upstream: UpstreamInfo | undefined, ahead: number, behind: number): FactPart[] {
  if (upstream) {
    if (upstream.ahead > 0 || upstream.behind > 0) {
      const parts: FactPart[] = [{ text: `${upstream.ref}:`, role: 'upstream', gap: 2 }];
      if (upstream.ahead > 0) {
        parts.push({ text: `+${upstream.ahead}`, role: 'added', gap: 1 });
      }
      if (upstream.behind > 0) {
        parts.push({ text: `−${upstream.behind}`, role: 'deleted', gap: 1 });
      }
      return parts;
    }
    return [{ text: t('status.upToDate', { ref: upstream.ref }), role: 'upstream', gap: 2 }];
  }
  const tracking: string[] = [];
  if (ahead > 0) {
    tracking.push(`ahead ${ahead}`);
  }
  if (behind > 0) {
    tracking.push(`behind ${behind}`);
  }
  return tracking.length === 0 ? [] : [{ text: `(${tracking.join(', ')})`, role: 'meta', gap: 2 }];
}

function facts(input: StatusModelInput): FactModel[] {
  const branch = input.status.branch ?? t('status.detached');
  const head = input.status.head;
  const remote = input.remote;
  // The buffer paints these values part by part: the branch name and the remote
  // name with the branch colour, a head commit with the hash colour and its subject
  // with the metadata colour, the repository path as metadata. The labels themselves
  // stay in the plain foreground, as they do in the buffer.
  return [
    {
      label: t('status.branchLabel'),
      value: branch,
      role: 'branch',
      parts: divergenceParts(input.upstream, input.status.ahead, input.status.behind),
    },
    head
      ? {
          label: t('status.headLabel'),
          value: head,
          role: 'hash',
          ...(input.status.headSubject
            ? { parts: [{ text: input.status.headSubject, role: 'meta' as ColorRole, gap: 1 as const }] }
            : {}),
        }
      : { label: t('status.headLabel'), value: t('status.noCommits'), role: 'meta', muted: true },
    { label: t('status.repoLabel'), value: input.repoPath, role: 'meta' },
    remote
      ? {
          label: t('status.remoteLabel'),
          value: remote.name,
          role: 'branch',
          parts: [{ text: remote.url, role: 'plain' as ColorRole, gap: 2 as const }],
        }
      : { label: t('status.remoteLabel'), value: t('status.noRemote'), role: 'meta', muted: true },
  ];
}

/**
 * The colour of a row's code: the same choice `xyKind()` makes in the buffer, where
 * the letter decides, not the section — so `??` is green and a new file in the
 * unstaged section is green too, while its path keeps the section colour.
 */
function codeRoleOf(entry: StatusEntry): ColorRole {
  if (entry.section === 'conflict') {
    return 'conflict';
  }
  if (entry.xy.includes('?')) {
    return 'added';
  }
  const code = entry.xy.trim().charAt(0) || 'M';
  switch (code) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    default:
      return 'modified';
  }
}

function rowsOf(status: RepoStatus, kind: SectionKind): RowModel[] {
  return status.entries
    .filter((entry) => entry.section === kind)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => ({
      id: rowId(entry),
      section: entry.section,
      path: entry.path,
      xy: entry.xy,
      code: entry.xy.trim(),
      codeRole: codeRoleOf(entry),
      // `sectionRole()` in the buffer: the section itself, conflicts included.
      pathRole: entry.section,
      ...(entry.origPath ? { origPath: entry.origPath } : {}),
    }));
}

function sections(status: RepoStatus): SectionModel[] {
  const hints = parseHints(t('hints.files'));
  return SECTION_ORDER.map((kind) => ({ kind, title: sectionTitle(kind), hints, rows: rowsOf(status, kind) }))
    // Conflicts come and go; the other three stay even when empty, so a row never
    // moves under the pointer when one of them becomes empty.
    .filter((section) => section.kind !== 'conflict' || section.rows.length > 0);
}

function column(input: StatusModelInput): ColumnBlockModel[] {
  return [
    {
      title: t('status.section.remotes'),
      role: 'remotes',
      hints: parseHints(t('hints.remotes')),
      empty: t('status.noRemotes'),
      // `codeberg  ssh://…` on one line, as the buffer prints it.
      rows: input.remotes.map((remote) => ({
        id: `remote:${remote.name}`,
        text: remote.name,
        mainRole: 'branch',
        detail: remote.url,
        detailRole: 'plain',
        inline: true,
      })),
    },
    {
      title: t('status.section.worktrees'),
      // The buffer paints this title with the remotes colour.
      role: 'remotes',
      hints: parseHints(t('hints.worktrees')),
      empty: '',
      // `* dev  D:/domains/vpn` on one line: the branch first, the path after it.
      rows: input.worktrees.map((worktree) => ({
        id: `worktree:${worktree.path}`,
        text: `${worktree.path === input.repoPath ? '* ' : '  '}${worktree.branch ?? (worktree.detached ? t('status.detached') : '')}`,
        mainRole: 'branch',
        detail: worktree.path,
        detailRole: 'plain',
        inline: true,
      })),
    },
    {
      title: t('status.section.stash'),
      role: 'section',
      hints: parseHints(t('hints.stash')),
      empty: t('status.noStash'),
      rows: input.stashes.map((stash) => ({
        id: `stash:${stash.ref}`,
        text: stash.ref,
        mainRole: 'branch',
        detail: stash.subject,
        detailRole: 'plain',
        inline: true,
      })),
    },
  ];
}

function commits(input: StatusModelInput): { title: string; hints: HintModel[]; rows: CommitRowModel[] } {
  return {
    title: t('status.section.commits'),
    hints: parseHints(t('hints.commits')),
    rows: input.commits.map((commit) => ({
      sha: commit.shortSha,
      date: commit.date,
      author: commit.author,
      // The tags and branches pointing at the commit belong on its row: `v0.0.4` on the
      // head commit is how a reader tells a release from a plain commit.
      refs: refsLabel(commit.refs ?? []),
      subject: commit.subject,
    })),
  };
}

export function buildStatusModel(input: StatusModelInput): StatusModel {
  return {
    kind: 'status',
    title: `${t('app.name')} — ${input.status.branch ?? t('status.detached')}`,
    facts: facts(input),
    sections: sections(input.status),
    column: column(input),
    commits: commits(input),
    hints: parseHints(t('hints.global')),
    keysTitle: t('status.keysHeader'),
    cleanText: t('status.clean'),
    selectFirst: t('webview.selectFirst'),
    notImplemented: t('webview.notImplemented'),
  };
}

/** Flat row order of a model: what Shift ranges run over. */
export function rowOrder(model: StatusModel): string[] {
  return model.sections.flatMap((section) => section.rows.map((row) => row.id));
}

/** Paths behind a set of ids, in model order and without duplicates. */
export function pathsOf(model: StatusModel, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const paths: string[] = [];
  for (const section of model.sections) {
    for (const row of section.rows) {
      if (wanted.has(row.id) && !paths.includes(row.path)) {
        paths.push(row.path);
      }
    }
  }
  return paths;
}

/** The same rows as status-screen file targets, for the code that already plans discards. */
export function fileTargetsOf(model: StatusModel, ids: readonly string[]): FileTarget[] {
  const wanted = new Set(ids);
  const targets: FileTarget[] = [];
  for (const section of model.sections) {
    for (const row of section.rows) {
      if (!wanted.has(row.id)) {
        continue;
      }
      targets.push({
        kind: 'file',
        section: row.section,
        path: row.path,
        entry: { section: row.section, xy: row.xy, path: row.path },
      });
    }
  }
  return targets;
}

/** Sections the ids belong to, so an action can tell conflicts from plain files. */
export function sectionsOf(model: StatusModel, ids: readonly string[]): Set<SectionKind> {
  const wanted = new Set(ids);
  const kinds = new Set<SectionKind>();
  for (const section of model.sections) {
    for (const row of section.rows) {
      if (wanted.has(row.id)) {
        kinds.add(section.kind);
      }
    }
  }
  return kinds;
}
