import { BranchEntry } from '../../git/actions';
import { t } from '../../i18n';
import { trackingLabel } from '../../views/rowLabels';
import type { ColorRole, FactModel, ListModel, RowBlockModel, RowItemModel } from '../protocol';
import { parseHints } from './status';

/**
 * The branches screen as the panel draws it: one block of local branches (the current
 * one marked with `*`) and one block per remote when remote branches are shown, each
 * row carrying the tracking label the buffer prints after the name and the subject of
 * the branch's last commit underneath it.
 *
 * The input is the same `listBranchEntries()` result the text buffer renders, and the
 * strings are the buffer's, so the two screens say the same thing about a branch.
 */
export function buildBranchesModel(
  repoPath: string,
  entries: BranchEntry[],
  showRemote: boolean
): ListModel {
  const local = entries.filter((entry) => !entry.isRemote);
  const remote = entries.filter((entry) => entry.isRemote);

  const summary =
    t('branches.count', { local: local.length }) +
    (showRemote ? t('branches.countRemote', { count: remote.length }) : '');
  const facts: FactModel[] = [{ label: '', value: summary, role: 'meta' }];

  const blocks: RowBlockModel[] = [];
  const sections: { title: string; list: BranchEntry[] }[] = [
    { title: t('branches.section.local'), list: local },
  ];
  if (showRemote) {
    // Remote branches are grouped by the remote they came from, in name order, the
    // way the buffer groups them.
    const groups = new Map<string, BranchEntry[]>();
    for (const entry of remote) {
      const slash = entry.name.indexOf('/');
      const name = slash > 0 ? entry.name.slice(0, slash) : entry.name;
      groups.set(name, [...(groups.get(name) ?? []), entry]);
    }
    for (const [name, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      sections.push({ title: `${t('branches.section.remote')}: ${name}`, list });
    }
  }

  for (const section of sections) {
    if (section.list.length === 0) {
      continue;
    }
    blocks.push({
      // `local`, `remote: origin`: the panel prints the count itself, as `## local (2)`
      // does in the buffer, so the title carries only the name.
      title: section.title,
      role: 'section',
      hints: [],
      rows: section.list.map((entry) => rowOf(entry)),
    });
  }

  return {
    kind: 'branches',
    title: t('branches.title', { repo: repoPath }) + (showRemote ? t('log.titleAll') : ''),
    facts,
    keysTitle: t('status.keysHeader'),
    hints: parseHints(t('branches.keys')),
    blocks,
    selectFirst: t('webview.selectItem'),
    emptyText: t('webview.emptyList'),
  };
}

function rowOf(entry: BranchEntry): RowItemModel {
  const tracking = trackingLabel(entry);
  const nameRole: ColorRole = entry.current ? 'branch' : entry.isRemote ? 'meta' : 'modified';
  const row: RowItemModel = {
    id: `branch:${entry.name}`,
    text: entry.name,
    role: nameRole,
    marker: entry.current ? '*' : ' ',
    markerRole: 'branch',
  };
  if (tracking) {
    // The label comes with the buffer's column padding; in the panel the gap between
    // the parts is the layout's job, so only the inner spacing stays (`→ origin/main  =`).
    row.parts = [{ text: tracking.trim(), role: 'hunk', gap: 2 }];
  }
  if (entry.subject || entry.unborn) {
    row.note = entry.unborn ? t('branches.unborn') : entry.subject;
    row.noteRole = 'meta';
  }
  return row;
}
