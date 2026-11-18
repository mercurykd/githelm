import { t } from '../i18n';
import { BranchEntry } from '../git/actions';
import { hintEntries, mergeColumns, narrowHintColumn } from './columns';
import { Span } from '../util/span';

export interface RenderedBranches {
  text: string;
  targets: Map<number, BranchEntry>;
  spans: Span[];
}

export function branchesKeys(): string {
  return t('branches.keys');
}

/** Local branches first (current one marked with `*`), then remote ones. */
export function renderBranches(repoPath: string, entries: BranchEntry[], showRemote: boolean): RenderedBranches {
  const lines: string[] = [];
  const targets = new Map<number, BranchEntry>();
  const spans: Span[] = [];

  const local = entries.filter((entry) => !entry.isRemote);
  const remote = entries.filter((entry) => entry.isRemote);

  lines.push(t('branches.title', { repo: repoPath }) + (showRemote ? t('log.titleAll') : ''));
  spans.push({ line: 0, start: 0, end: lines[0].length, kind: 'title' });

  const summary = t('branches.count', { local: local.length }) + (showRemote ? t('branches.countRemote', { count: remote.length }) : '');
  lines.push(summary);
  spans.push({ line: 1, start: 0, end: summary.length, kind: 'meta' });
  lines.push('');

  const section = (title: string, list: BranchEntry[]): void => {
    if (list.length === 0) {
      return;
    }
    const headerLine = lines.length;
    lines.push(`## ${title} (${list.length})`);
    spans.push({ line: headerLine, start: 0, end: lines[headerLine].length, kind: 'section' });
    lines.push('');

    for (const entry of list) {
      const lineNumber = lines.length + 1;
      const marker = entry.current ? '*' : ' ';
      const tracking = trackingLabel(entry);
      const text = `${marker} ${entry.name}${tracking}`;
      lines.push(text);
      targets.set(lineNumber, entry);

      spans.push({
        line: lineNumber - 1,
        start: 2,
        end: 2 + entry.name.length,
        kind: entry.current ? 'branch' : entry.isRemote ? 'meta' : 'file-modified',
      });
      if (tracking) {
        spans.push({ line: lineNumber - 1, start: text.length - tracking.length, end: text.length, kind: 'hunk' });
      }
      if (entry.subject) {
        lines.push(`    ${entry.subject}`);
        spans.push({ line: lines.length - 1, start: 4, end: 4 + entry.subject.length, kind: 'meta' });
      }
    }
    lines.push('');
  };

  section(t('branches.section.local'), local);
  if (showRemote) {
    const groups = new Map<string, BranchEntry[]>();
    for (const entry of remote) {
      const slash = entry.name.indexOf('/');
      const remoteName = slash > 0 ? entry.name.slice(0, slash) : entry.name;
      const list = groups.get(remoteName) ?? [];
      list.push(entry);
      groups.set(remoteName, list);
    }
    for (const [remoteName, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      section(`${t('branches.section.remote')}: ${remoteName}`, list);
    }
  }

  const merged = mergeColumns(lines, hintEntries(branchesKeys(), t('status.keysHeader')), narrowHintColumn());
  for (const span of merged.spans) {
    spans.push(span);
  }

  return { text: `${merged.lines.join('\n')}\n`, targets, spans };
}

function trackingLabel(entry: BranchEntry): string {
  if (entry.isRemote) {
    return '';
  }
  if (!entry.upstream) {
    return entry.current ? `   ${t('branches.noUpstream')}` : '';
  }
  if (entry.ahead === 0 && entry.behind === 0) {
    return `   ${t('branches.upstream', { ref: entry.upstream })}  =`;
  }
  return `   ${t('branches.upstreamDiverged', { ref: entry.upstream, ahead: entry.ahead, behind: entry.behind })}`;
}
