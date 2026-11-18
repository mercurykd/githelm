import { t, MessageKey } from '../i18n';
import { RemoteEntry, UpstreamInfo } from '../git/remotes';
import { authorColumnWidth, refsLabel, truncateAuthor } from '../git/log';
import { StatusEntry, StatusSection, RepoStatus, entriesOf } from '../git/status';
import { StashEntry } from '../git/stash';
import type { LfsFile } from '../git/lfs';
import type { Submodule } from '../git/submodules';
import { samePath, WorktreeEntry } from '../git/worktree';
import { Span } from '../util/span';
import { hintColumn, hintEntries, keySegments, mergeColumns } from './columns';

export type BufferSection = StatusSection | 'stash' | 'remotes' | 'worktrees' | 'init';

export type StatusTarget =
  | { kind: 'file'; section: StatusSection; path: string; entry: StatusEntry }
  | { kind: 'stash'; section: 'stash'; ref: string; subject: string }
  | { kind: 'remote'; section: 'remotes'; name: string; url: string }
  | { kind: 'worktree'; section: 'worktrees'; path: string; current: boolean; prunable: boolean }
  /** The `git init` row of a folder that is not a repository yet. */
  | { kind: 'init'; section: 'init' };

export interface StatusExtras {
  stashes: StashEntry[];
  /** Files stored through Git LFS; their diffs show pointers, not content. */
  lfs?: LfsFile[];
  /** Submodules of this repository, used to mark gitlink rows. */
  submodules?: Submodule[];
  remotes: RemoteEntry[];
  /** All worktrees of the repository; the current one is marked with `*`. */
  worktrees?: WorktreeEntry[];
  upstream?: UpstreamInfo;
  /** Remote of the tracked branch, shown in the header. */
  remote?: { name: string; url: string };
  /** Last commits of the current branch, already formatted. */
  commits?: { sha?: string; shortSha: string; date: string; author: string; subject: string; refs?: string[] }[];
}

export interface StatusCell {
  /** Column where the cell starts, 0-based, in characters. */
  start: number;
  target: StatusTarget;
}

export interface RenderedStatus {
  text: string;
  /** Target of the leftmost cell of a line (1-based line numbers). */
  targets: Map<number, StatusTarget>;
  /** Every actionable cell of a line, left to right — side-by-side sections need it. */
  cells: Map<number, StatusCell[]>;
  sectionLines: Map<number, BufferSection>;
  /**
   * Section of a title that belongs to the right-hand column, by line. A line
   * can carry a title of each side (`## staged` and `## remotes`), and only the
   * cursor column says which one the user means.
   */
  columnSections: Map<number, BufferSection>;
  /**
   * The commit a line of `## last commits` shows, so `t` can put a tag on the
   * commit under the cursor instead of on HEAD.
   */
  commitLines: Map<number, { ref: string; shortSha: string; subject: string }>;
  /** Column where the right-hand blocks begin; 0 when the screen has none. */
  columnStart: number;
  spans: Span[];
}

/** One block of a section, rendered on its own before being placed. */
interface RenderBlock {
  section: BufferSection;
  lines: string[];
  /** `line` is 0-based inside the block. */
  cells: { line: number; start: number; target: StatusTarget }[];
  spans: { line: number; start: number; end: number; kind: Span['kind'] }[];
}

export const SECTION_ORDER: StatusSection[] = ['conflict', 'staged', 'unstaged', 'untracked'];

/**
 * Columns between the widest line of the file area and the right-hand column.
 * The gutter is what tells the eye that the two halves of the screen are two
 * lists and not one table.
 */
const COLUMN_GAP = 6;

function sectionLabel(section: BufferSection): string {
  return t(`status.section.${section}` as MessageKey);
}

export function renderStatus(
  repoPath: string,
  status: RepoStatus,
  extras?: StatusExtras,
  recent: string[] = []
): RenderedStatus {
  const lines: string[] = [];
  const targets = new Map<number, StatusTarget>();
  const cells = new Map<number, StatusCell[]>();
  const sectionLines = new Map<number, BufferSection>();
  const columnSections = new Map<number, BufferSection>();
  const commitLines = new Map<number, { ref: string; shortSha: string; subject: string }>();
  let columnStart = 0;
  const spans: Span[] = [];

  const branchLabel = `${t('status.branchLabel')} `;
  const headLabel = `${t('status.headLabel')} `;
  const repoLabel = `${t('status.repoLabel')} `;

  const branch = status.branch ?? t('status.detached');
  // The divergence of the tracked branch is a fact about the branch, so it sits
  // on the `BRANCH:` line: named when the upstream is known (`origin/main: +2
  // −1`), and as plain counters when only `git status` answered.
  const divergence = extras?.upstream ? divergenceText(extras.upstream) : undefined;
  const tracking: string[] = [];
  if (status.ahead > 0) {
    tracking.push(`ahead ${status.ahead}`);
  }
  if (status.behind > 0) {
    tracking.push(`behind ${status.behind}`);
  }
  const branchSuffix = divergence
    ? `  ${divergence}`
    : tracking.length > 0
      ? `  (${tracking.join(', ')})`
      : '';

  lines.push(`${branchLabel}${branch}${branchSuffix}`);
  spans.push({ line: 0, start: branchLabel.length, end: branchLabel.length + branch.length, kind: 'branch' });
  if (divergence) {
    divergenceSpans(spans, 0, divergence, branchLabel.length + branch.length + 2, extras?.upstream);
  } else if (tracking.length > 0) {
    spans.push({ line: 0, start: branchLabel.length + branch.length + 2, end: lines[0].length, kind: 'meta' });
  }

  const headLine = status.head
    ? `${headLabel}${status.head} ${status.headSubject ?? ''}`.trimEnd()
    : `${headLabel}${t('status.noCommits')}`;
  lines.push(headLine);
  if (status.head) {
    spans.push({ line: 1, start: headLabel.length, end: headLabel.length + status.head.length, kind: 'hash' });
    if (status.headSubject) {
      spans.push({ line: 1, start: headLabel.length + status.head.length + 1, end: headLine.length, kind: 'meta' });
    }
  } else {
    spans.push({ line: 1, start: headLabel.length, end: headLine.length, kind: 'meta' });
  }

  lines.push(`${repoLabel}${repoPath}`);
  spans.push({ line: 2, start: repoLabel.length, end: lines[2].length, kind: 'meta' });

  const remoteLabel = `${t('status.remoteLabel')} `;
  const remote = extras?.remote;
  const remoteLine = remote
    ? `${remoteLabel}${remote.name}  ${remote.url}`
    : `${remoteLabel}${t('status.noRemote')}`;
  lines.push(remoteLine);
  if (remote) {
    spans.push({ line: 3, start: remoteLabel.length, end: remoteLabel.length + remote.name.length, kind: 'branch' });
    const urlStart = remoteLabel.length + remote.name.length + 2;
    spans.push({ line: 3, start: urlStart, end: remoteLine.length, kind: 'meta' });
  } else {
    spans.push({ line: 3, start: remoteLabel.length, end: remoteLine.length, kind: 'meta' });
  }
  lines.push('');

  /**
   * Section title, its key hints and the hairline that closes the pair. The
   * `##` stays quiet so the title itself carries the colour.
   */
  const header = (title: string, count: number, section: BufferSection, hint: string, role: Span['kind'] = 'section'): void => {
    const headerLine = lines.length;
    const text = `## ${title} (${count})`;
    lines.push(text);
    spans.push({ line: headerLine, start: 0, end: 2, kind: 'meta' });
    spans.push({ line: headerLine, start: 3, end: text.length, kind: role });
    sectionLines.set(headerLine + 1, section);
    pushHint(lines, spans, hint);
  };

  const lfsPaths = new Set((extras?.lfs ?? []).map((file) => file.path));
  const submodulePaths = new Map((extras?.submodules ?? []).map((sub) => [sub.path, sub.state] as const));

  // A section that vanishes moves everything under it: the cursor lands on a
  // different row, and the eye has to re-find the file it was looking at. The
  // three file sections therefore keep their header, their hint line and their
  // separating blank line even when they are empty; only `conflict` stays
  // conditional, because its absence is the normal state.
  const alwaysShown = new Set<StatusSection>(['staged', 'unstaged', 'untracked']);
  // The right-hand column starts level with `staged`, so the file list and the
  // repository metadata read as two columns of one screen.
  let stagedTop = 0;

  for (const section of SECTION_ORDER) {
    const entries = entriesOf(status, section);
    if (entries.length === 0 && !alwaysShown.has(section)) {
      continue;
    }
    // A section's title and its rows share one colour, so the heading and the
    // files under it read as a single block.
    const role: Span['kind'] = sectionRole(section);
    if (section === 'staged') {
      stagedTop = lines.length;
    }
    header(sectionLabel(section), entries.length, section, t('hints.files'), role);
    for (const entry of entries) {
      const lineNumber = lines.length + 1;
      const suffix = entry.origPath ? t('status.copySuffix', { orig: entry.origPath }) : '';
      // The badges are independent: a path is tracked by LFS, is a gitlink, or
      // neither, so each one is decided on its own and appended after the path.
      const badges: string[] = [];
      if (lfsPaths.has(entry.path)) {
        badges.push(t('status.badge.lfs'));
      }
      const subState = submodulePaths.get(entry.path);
      if (subState) {
        badges.push(t(subState === 'ok' ? 'status.badge.submodule' : 'status.badge.submoduleModified'));
      }
      const badgeText = badges.length > 0 ? `  ${badges.join(' ')}` : '';
      const base = `  ${entry.xy} ${entry.path}`;
      const text = `${base}${suffix}${badgeText}`;
      lines.push(text);
      addTarget(targets, cells, lineNumber, { kind: 'file', section, path: entry.path, entry });
      spans.push({ line: lineNumber - 1, start: 2, end: 4, kind: xyKind(section, entry) });
      const pathStart = 5;
      if (text.length > pathStart) {
        spans.push({ line: lineNumber - 1, start: pathStart, end: pathStart + entry.path.length, kind: sectionRole(section) });
      }
      if (suffix) {
        spans.push({ line: lineNumber - 1, start: base.length, end: base.length + suffix.length, kind: 'meta' });
      }
      if (badgeText) {
        spans.push({ line: lineNumber - 1, start: text.length - badgeText.length, end: text.length, kind: 'meta' });
      }
    }
    // One blank line after the rows — and after the hairline of an empty
    // section — so every block ends the same way whatever it contains.
    lines.push('');
  }

  if (status.entries.length === 0) {
    lines.push(`  ${t('status.clean')}`);
    lines.push('');
  }
  const fileAreaEnd = lines.length;

  if (extras) {
    // `remotes`, `worktrees` and `stash` are all repository metadata: one column
    // of their own, beside the file sections. Every block keeps its own keys and
    // hairline, and every hint of the screen is a single line, so the column is
    // exactly as wide as its widest hint. The `remotes` block is drawn even when
    // the repository has none: `A` adds the first remote, and the keys have to be
    // reachable from the status buffer.
    const leftWidth = Math.max(0, ...lines.slice(stagedTop, fileAreaEnd).map((line) => line.length));
    const start = leftWidth + COLUMN_GAP;
    const area: RenderBlock[] = [
      remoteBlock(extras.remotes),
      // The stash block is always drawn, empty or not: its keys are the only
      // place the status buffer says how to make the first stash.
      stashBlock(extras.stashes),
    ];
    // `listWorktrees` always answers with at least the current checkout, so this
    // block is on screen in practice; it is left out only when a caller has
    // nothing to say about worktrees.
    if (extras.worktrees && extras.worktrees.length > 0) {
      // The blocks read in the order the metadata matters: where the branch
      // pushes to, which checkouts exist, what is set aside.
      area.splice(1, 0, worktreeBlock(extras.worktrees, repoPath));
    }
    columnStart = placeColumn(cells, sectionLines, columnSections, spans, lines, area, targets, stagedTop, start);

    // The blocks end with their own blank line — no extra one here.
  }

  if (extras?.commits && extras.commits.length > 0) {
    const headerLine = lines.length;
    const text = `## ${t('status.section.commits')} (${extras.commits.length})`;
    lines.push(text);
    spans.push({ line: headerLine, start: 0, end: text.length, kind: 'section' });
    // The keys that act on a commit belong to the block that lists them: `g`
    // opens the graph of the commits shown. (`n` is a worktree key on this
    // screen, not a branch key, so it stays with the worktrees block.)
    pushHint(lines, spans, t('hints.commits'));
    // Author column shared with the history graph (see git/log.ts): as wide as
    // the longest login, so the subject starts right after it.
    const authorWidth = authorColumnWidth(extras.commits.map((commit) => commit.author));
    for (const commit of extras.commits) {
      const lineNumber = lines.length + 1;
      const label = refsLabel(commit.refs ?? []);
      const labelText = label.length > 0 ? `${label} ` : '';
      const author = truncateAuthor(commit.author);
      const dateStart = 4 + commit.shortSha.length;
      const authorStart = dateStart + commit.date.length + 2;
      const subjectStart = authorStart + authorWidth;
      const row = `  ${commit.shortSha}  ${commit.date}  ${author.padEnd(authorWidth)}${labelText}${commit.subject}`;
      lines.push(row);
      // The row is not a target — no file action applies to a commit — but `t`
      // reads this map to tag the commit the cursor points at.
      commitLines.set(lineNumber, {
        ref: commit.sha ?? commit.shortSha,
        shortSha: commit.shortSha,
        subject: commit.subject,
      });
      spans.push({ line: lineNumber - 1, start: 2, end: 2 + commit.shortSha.length, kind: 'hash' });
      spans.push({ line: lineNumber - 1, start: dateStart, end: dateStart + commit.date.length, kind: 'meta' });
      if (author.length > 0) {
        spans.push({ line: lineNumber - 1, start: authorStart, end: authorStart + author.length, kind: 'author' });
      }
      if (label.length > 0) {
        spans.push({ line: lineNumber - 1, start: subjectStart, end: subjectStart + label.length, kind: 'refs' });
      }
    }
    lines.push('');
  }

  if (recent.length > 0) {
    const headerLine = lines.length;
    const text = `## ${t('status.recentHeader')} (${recent.length})`;
    lines.push(text);
    spans.push({ line: headerLine, start: 0, end: text.length, kind: 'section' });
    pushHint(lines, spans, t('hints.recent'));
    for (const action of recent) {
      const lineNumber = lines.length + 1;
      lines.push(`  ${action}`);
      spans.push({ line: lineNumber - 1, start: 2, end: lines[lineNumber - 1].length, kind: 'meta' });
    }
    lines.push('');
  }

  // The column comes from `githelm.ui.hintColumn` (see columns.ts), so every
  // screen aligns its hints at the same place.
  const merged = mergeColumns(
    lines,
    hintEntries(t('hints.global'), t('status.keysHeader'))
  );
  for (const span of merged.spans) {
    spans.push(span);
  }

  return { text: `${merged.lines.join('\n')}\n`, targets, cells, sectionLines, columnSections, commitLines, columnStart, spans };
}

function pushHint(lines: string[], spans: Span[], text: string): void {
  const line = `  ${text}`;
  lines.push(line);
  spans.push({ line: lines.length - 1, start: 2, end: line.length, kind: 'help' });
  // The hairline closes the hint block instead of a blank line: the hints
  // belong to the title above them, and the rule draws that group boundary
  // without spending a row on empty space.
  const rule = `  ${'─'.repeat(ruleWidth(text.length))}`;
  lines.push(rule);
  spans.push({ line: lines.length - 1, start: 2, end: rule.length, kind: 'rule' });
}

/** The hairline stops before the hint column, so merging never clips it. */
function ruleWidth(hintLength: number): number {
  return Math.max(1, Math.min(hintLength, hintColumn() - 2));
}

/** Records an actionable cell: `targets` keeps the leftmost one for line-only lookups. */
function addTarget(
  targets: Map<number, StatusTarget>,
  cells: Map<number, StatusCell[]>,
  lineNumber: number,
  target: StatusTarget,
  start = 0
): void {
  const list = cells.get(lineNumber) ?? [];
  list.push({ start, target });
  list.sort((a, b) => a.start - b.start);
  cells.set(lineNumber, list);
  targets.set(lineNumber, list[0].target);
}

/**
 * Title, key hints and the hairline under them — the same shape the file
 * sections use, so a block reads like a section that happens to sit in a
 * column. `role` decides the colour of the title. The hints stay on one line:
 * the column is sized for its widest hint, so nothing has to wrap.
 */
function blockHeader(
  block: RenderBlock,
  title: string,
  count: number,
  hint: string,
  role: Span['kind']
): void {
  const text = `## ${title} (${count})`;
  block.spans.push({ line: block.lines.length, start: 0, end: 2, kind: 'meta' });
  block.spans.push({ line: block.lines.length, start: 3, end: text.length, kind: role });
  block.lines.push(text);
  const hintLine = oneLineHint(hint);
  block.spans.push({ line: block.lines.length, start: 2, end: hintLine.length + 2, kind: 'help' });
  block.lines.push(`  ${hintLine}`);
  const rule = `  ${'─'.repeat(Math.max(1, hintLine.length))}`;
  block.spans.push({ line: block.lines.length, start: 2, end: rule.length, kind: 'rule' });
  block.lines.push(rule);
}

/** The hint as one line, with the key groups separated by the usual gutter. */
function oneLineHint(hint: string): string {
  return keySegments(hint).join('   ');
}

function remoteBlock(remotes: RemoteEntry[]): RenderBlock {
  const block: RenderBlock = { section: 'remotes', lines: [], cells: [], spans: [] };
  blockHeader(block, sectionLabel('remotes'), remotes.length, t('hints.remotes'), 'remotes');
  if (remotes.length === 0) {
    // A repository without remotes still shows the block: the `A` hint above it
    // is the only place the status buffer tells you how to add the first one.
    const line = block.lines.length;
    const text = `  ${t('status.noRemotes')}`;
    block.lines.push(text);
    block.spans.push({ line, start: 2, end: text.length, kind: 'meta' });
  }
  for (const remote of remotes) {
    const line = block.lines.length;
    const text = `  ${remote.name}  ${remote.url}`;
    block.lines.push(text);
    block.cells.push({
      line,
      start: 2,
      target: { kind: 'remote', section: 'remotes', name: remote.name, url: remote.url },
    });
    block.spans.push({ line, start: 2, end: 2 + remote.name.length, kind: 'branch' });
    // The URL stays unpainted on purpose: it reads as ordinary text, the same
    // weight as a commit subject in the history screen.
  }
  block.lines.push('');
  return block;
}

/**
 * The stash list. It shares the right-hand column with the remotes and the
 * worktrees, and it is drawn even when empty, so the keys that make a stash are
 * always on screen.
 */
function stashBlock(stashes: StashEntry[]): RenderBlock {
  const block: RenderBlock = { section: 'stash', lines: [], cells: [], spans: [] };
  blockHeader(block, sectionLabel('stash'), stashes.length, t('hints.stash'), 'section');
  if (stashes.length === 0) {
    const line = block.lines.length;
    const text = `  ${t('status.noStash')}`;
    block.lines.push(text);
    block.spans.push({ line, start: 2, end: text.length, kind: 'meta' });
  }
  for (const stash of stashes) {
    const line = block.lines.length;
    const text = `  ${stash.ref}  ${stash.subject}`;
    block.lines.push(text);
    block.cells.push({
      line,
      start: 2,
      target: { kind: 'stash', section: 'stash', ref: stash.ref, subject: stash.subject },
    });
    block.spans.push({ line, start: 2, end: 2 + stash.ref.length, kind: 'branch' });
    // The message is left unpainted on purpose: it should read like the subject
    // of a commit, not like the metadata around it.
  }
  block.lines.push('');
  return block;
}

function worktreeBlock(worktrees: WorktreeEntry[], repoPath: string): RenderBlock {
  const block: RenderBlock = { section: 'worktrees', lines: [], cells: [], spans: [] };
  // The blocks stand one under the other in the same column, so they share one
  // heading colour; `githelm.worktrees` carries the value of `githelm.remotes`.
  blockHeader(block, sectionLabel('worktrees'), worktrees.length, t('hints.worktrees'), 'remotes');
  const refs = worktrees.map((worktree) => worktreeRef(worktree));
  const refWidth = Math.max(...refs.map((ref) => ref.length));
  worktrees.forEach((worktree, index) => {
    const line = block.lines.length;
    const current = samePath(worktree.path, repoPath);
    const flags: string[] = [];
    if (worktree.locked) {
      flags.push(t('status.worktreeLocked'));
    }
    if (worktree.prunable) {
      flags.push(t('status.worktreePrunable'));
    }
    const flagsText = flags.length > 0 ? `   ${flags.join(' ')}` : '';
    // `  * branch  path`: the star marks the worktree this buffer belongs to.
    const text = `  ${current ? '*' : ' '} ${refs[index].padEnd(refWidth)}  ${worktree.path}${flagsText}`;
    block.lines.push(text);
    block.cells.push({
      line,
      start: 2,
      target: { kind: 'worktree', section: 'worktrees', path: worktree.path, current, prunable: worktree.prunable },
    });
    block.spans.push({ line, start: 2, end: 3, kind: 'branch' });
    block.spans.push({ line, start: 4, end: 4 + refWidth, kind: 'branch' });
    // The path stays unpainted, so it reads like the subject of a commit.
    if (flagsText) {
      block.spans.push({ line, start: text.length - flagsText.length + 3, end: text.length, kind: 'hunk' });
    }
  });
  block.lines.push('');
  return block;
}

/**
 * Writes the blocks one under the other in a column of its own, beside the file
 * sections: `remotes`, `worktrees` and `stash` next to the files. The left side
 * keeps the width it needs and `start` is chosen after it, so the file rows are
 * never cut to make room. A block title may share a line with a title of the file
 * side; `columnSections` keeps the two apart, and the cursor column decides.
 */
function placeColumn(
  cells: Map<number, StatusCell[]>,
  sectionLines: Map<number, BufferSection>,
  columnSections: Map<number, BufferSection>,
  spans: Span[],
  lines: string[],
  blocks: RenderBlock[],
  targets: Map<number, StatusTarget>,
  top: number,
  start: number
): number {
  const column: RenderBlock = { section: blocks[0].section, lines: [], cells: [], spans: [] };
  const titles: { line: number; section: BufferSection }[] = [];
  // The key hints own the top right corner of the screen: the column starts
  // below them, even when that is a line or two under the `staged` title.
  const begin = Math.max(top, hintEntries(t('hints.global'), t('status.keysHeader')).length);
  for (const block of blocks) {
    // The blocks keep the blank line they end with, so the column reads like the
    // file side: one empty row between two blocks. The blank of the last block is
    // dropped at the end — the column does not need to trail into space.
    const kept: number[] = [];
    const titleLine = column.lines.length;
    for (let index = 0; index < block.lines.length; index++) {
      kept[index] = column.lines.length;
      column.lines.push(block.lines[index]);
    }
    titles.push({ line: titleLine, section: block.section });
    for (const cell of block.cells) {
      const line = kept[cell.line];
      if (line !== undefined) {
        column.cells.push({ ...cell, line });
      }
    }
    for (const span of block.spans) {
      const line = kept[span.line];
      if (line !== undefined) {
        column.spans.push({ ...span, line });
      }
    }
  }
  while (column.lines.length > 0 && column.lines[column.lines.length - 1] === '') {
    column.lines.pop();
  }

  while (lines.length < begin + column.lines.length) {
    lines.push('');
  }
  for (let index = 0; index < column.lines.length; index++) {
    const text = column.lines[index];
    if (!text) {
      continue;
    }
    const line = begin + index;
    const left = lines[line];
    lines[line] = `${left}${' '.repeat(Math.max(2, start - left.length))}${text}`;
  }

  for (const span of column.spans) {
    spans.push({ line: begin + span.line, start: span.start + start, end: span.end + start, kind: span.kind });
  }
  for (const cell of column.cells) {
    addTarget(targets, cells, begin + cell.line + 1, cell.target, cell.start + start);
  }
  // A block title answers for its own section. It records itself in both maps:
  // `columnSections` always, so a cursor inside the column reaches it even when
  // the file side has a title on the same line, and `sectionLines` only when the
  // line has no title of the file side — the file side keeps its line.
  for (const title of titles) {
    const lineNumber = begin + title.line + 1;
    columnSections.set(lineNumber, title.section);
    if (!sectionLines.has(lineNumber)) {
      sectionLines.set(lineNumber, title.section);
    }
  }
  return start;
}

/** Resolves the cell under a cursor column; `line` is 1-based, like the targets. */
export function targetAtCell(rendered: RenderedStatus, line: number, character = 0): StatusTarget | undefined {
  const list = rendered.cells.get(line);
  if (!list || list.length === 0) {
    return rendered.targets.get(line);
  }
  let hit = list[0];
  for (const cell of list) {
    if (cell.start <= character) {
      hit = cell;
    }
  }
  return hit.target;
}

/**
 * Status buffer for a folder that is not a repository yet: the usual screen
 * cannot render, so show what the folder is and a way to initialise it.
 */
export function renderUninitialized(folderPath: string): RenderedStatus {
  const lines: string[] = [];
  const spans: Span[] = [];
  const targets = new Map<number, StatusTarget>();
  const cells = new Map<number, StatusCell[]>();
  const sectionLines = new Map<number, BufferSection>();

  const repoLine = `${t('status.repoLabel')} ${folderPath}`;
  lines.push(repoLine);
  spans.push({ line: 0, start: 0, end: repoLine.length, kind: 'meta' });

  const notRepoLine = `  ${t('status.notRepoHint')}`;
  lines.push(notRepoLine);
  spans.push({ line: 1, start: 2, end: notRepoLine.length, kind: 'meta' });
  lines.push('');

  const headerLine = lines.length;
  const headerText = `## ${sectionLabel('init')} (1)`;
  lines.push(headerText);
  spans.push({ line: headerLine, start: 0, end: 2, kind: 'meta' });
  spans.push({ line: headerLine, start: 3, end: headerText.length, kind: 'section' });
  sectionLines.set(headerLine + 1, 'init');
  pushHint(lines, spans, t('status.initKeys'));

  const actionLine = lines.length;
  const actionText = `  ${t('status.initAction')}`;
  lines.push(actionText);
  spans.push({ line: actionLine, start: 2, end: actionText.length, kind: 'branch' });
  addTarget(targets, cells, actionLine + 1, { kind: 'init', section: 'init' });
  lines.push('');

  const merged = mergeColumns(lines, hintEntries(t('hints.global'), t('status.keysHeader')));
  for (const span of merged.spans) {
    spans.push(span);
  }

  return {
    text: `${merged.lines.join('\n')}\n`,
    targets,
    cells,
    sectionLines,
    columnSections: new Map(),
    commitLines: new Map(),
    columnStart: 0,
    spans,
  };
}

/** Label of a worktree row: its branch, or why it has none. */
function worktreeRef(worktree: WorktreeEntry): string {
  if (worktree.bare) {
    return t('status.worktreeBare');
  }
  return worktree.branch ?? t('status.detached');
}

/**
 * How far the tracked branch moved: `origin/main: +2 −1`. A counter that is zero
 * is left out — `+2 −0` states a fact that is not there.
 */
function divergenceText(upstream: UpstreamInfo): string {
  if (upstream.ahead > 0 && upstream.behind > 0) {
    return t('status.diverged', { ref: upstream.ref, ahead: upstream.ahead, behind: upstream.behind });
  }
  if (upstream.ahead > 0) {
    return t('status.aheadOnly', { ref: upstream.ref, ahead: upstream.ahead });
  }
  if (upstream.behind > 0) {
    return t('status.behindOnly', { ref: upstream.ref, behind: upstream.behind });
  }
  return t('status.upToDate', { ref: upstream.ref });
}

/**
 * Colours a divergence label: the ref is the mapping between the branch and its
 * remote, and each counter carries its own direction — one flat colour would
 * hide which way the branch moved. `start` is the column the text begins at.
 */
function divergenceSpans(
  spans: Span[],
  line: number,
  text: string,
  start: number,
  upstream: UpstreamInfo | undefined
): void {
  const counters: { text: string; kind: Span['kind']; at: number }[] = [];
  if (upstream && upstream.ahead > 0) {
    counters.push({ text: `+${upstream.ahead}`, kind: 'add', at: text.indexOf(`+${upstream.ahead}`) });
  }
  if (upstream && upstream.behind > 0) {
    counters.push({ text: `−${upstream.behind}`, kind: 'del', at: text.indexOf(`−${upstream.behind}`) });
  }
  const present = counters.filter((counter) => counter.at >= 0).sort((left, right) => left.at - right.at);
  const refEnd = present.length > 0 ? present[0].at : text.length;
  spans.push({ line, start, end: start + refEnd, kind: 'upstream' });
  for (const counter of present) {
    spans.push({
      line,
      start: start + counter.at,
      end: start + counter.at + counter.text.length,
      kind: counter.kind,
    });
  }
}

/**
 * One colour per section, used for its title and for the paths of its rows:
 * matcha for what is staged, honey for what is not, rose tea for what git has
 * never seen, and the conflict colour for a merge in progress.
 */
function sectionRole(section: StatusSection): Span['kind'] {
  return section === 'conflict' ? 'file-conflict' : section;
}

function xyKind(section: StatusSection, entry: StatusEntry): Span['kind'] {
  if (section === 'conflict') {
    return 'file-conflict';
  }
  if (entry.xy.includes('?')) {
    return 'file-untracked';
  }
  const code = entry.xy.trim().charAt(0) || 'M';
  switch (code) {
    case 'A':
    case 'C':
      return 'file-added';
    case 'D':
      return 'file-deleted';
    default:
      return 'file-modified';
  }
}

export interface ResolvedTargets {
  kind: 'section' | 'files' | 'none';
  section?: BufferSection;
  targets: StatusTarget[];
}

/** Every target of the screen, in line order — side-by-side cells included. */
function allTargets(rendered: RenderedStatus): StatusTarget[] {
  const result: StatusTarget[] = [];
  for (const list of rendered.cells.values()) {
    for (const cell of list) {
      result.push(cell.target);
    }
  }
  return result;
}

/**
 * Resolves what an action applies to: section header, selection, or one entry.
 *
 * A single cursor passes its column, because one line can hold a title or a file
 * row of the file side *and* a title or a row of the right-hand column at once.
 * The cursor's half decides which of the two is meant, and a title only answers
 * when it belongs to that half: a file row sharing its line with the `## stash`
 * title of the column is still that file.
 */
export function resolveTargets(
  rendered: RenderedStatus,
  fromLine: number,
  toLine: number,
  character?: number
): ResolvedTargets {
  const from = Math.min(fromLine, toLine);
  const to = Math.max(fromLine, toLine);

  if (from === to) {
    // A cursor without a known column sits at the left edge of its line: one
    // entry answers, never the two halves of the line at once.
    const at = character ?? 0;
    const cells = rendered.cells.get(from);
    const leftTitle = rendered.sectionLines.get(from);
    const columnTitle = rendered.columnSections.get(from);
    // A title of the file side is one the column did not put on the line: when
    // both maps agree, the title belongs to the column (`## stash` next to a row
    // of files), and the row under the cursor answers instead.
    const onFileTitle = leftTitle !== undefined && leftTitle !== columnTitle;
    const inColumn = rendered.columnStart > 0 && at >= rendered.columnStart;
    const title = inColumn ? columnTitle : onFileTitle ? leftTitle : undefined;
    if (title) {
      return { kind: 'section', section: title, targets: allTargets(rendered).filter((target) => target.section === title) };
    }
    if (cells && cells.length > 0) {
      const target = targetAtCell(rendered, from, at);
      return target ? { kind: 'files', targets: [target] } : { kind: 'none', targets: [] };
    }
    // No cells and no title of that half: a title alone on the line still answers,
    // whichever half the cursor is in — clicking `## remotes` at the left edge
    // means the remotes block.
    const alone = columnTitle ?? leftTitle;
    if (alone) {
      return { kind: 'section', section: alone, targets: allTargets(rendered).filter((target) => target.section === alone) };
    }
  }

  const targets = [...rendered.cells.entries()]
    .filter(([line]) => line >= from && line <= to)
    .flatMap(([, list]) => list.map((cell) => cell.target));

  return targets.length > 0 ? { kind: 'files', targets } : { kind: 'none', targets: [] };
}

/** Stable identity of a target, so overlapping cursors do not act twice on it. */
export function targetKey(target: StatusTarget): string {
  switch (target.kind) {
    case 'file':
      return `file:${target.section}:${target.path}`;
    case 'stash':
      return `stash:${target.ref}`;
    case 'remote':
      return `remote:${target.name}`;
    case 'worktree':
      return `worktree:${target.path}`;
    case 'init':
      return 'init';
  }
}

export interface SelectionRange {
  /** 1-based, inclusive. */
  fromLine: number;
  toLine: number;
  /** Cursor column of a one-line range: it picks the cell on that line. */
  character?: number;
}

/**
 * Resolves every cursor and selection of the buffer into one set of targets.
 * A single selection keeps the exact semantics of `resolveTargets` (a section
 * header still reports `kind: 'section'`); several are merged, and a target hit
 * by overlapping cursors is reported once.
 */
export function resolveSelections(
  rendered: RenderedStatus,
  ranges: readonly SelectionRange[]
): ResolvedTargets {
  if (ranges.length === 1) {
    return resolveTargets(rendered, ranges[0].fromLine, ranges[0].toLine, ranges[0].character);
  }

  const seen = new Set<string>();
  const targets: StatusTarget[] = [];
  for (const range of ranges) {
    for (const target of resolveTargets(rendered, range.fromLine, range.toLine, range.character).targets) {
      const key = targetKey(target);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push(target);
    }
  }

  if (targets.length === 0) {
    return { kind: 'none', targets: [] };
  }
  const sections = new Set(targets.map((target) => target.section));
  const section = sections.size === 1 ? targets[0].section : undefined;
  return { kind: 'files', ...(section ? { section } : {}), targets };
}
