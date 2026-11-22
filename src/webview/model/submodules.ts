import type { Submodule, SubmoduleState } from '../../git/submodules';
import { t } from '../../i18n';
import type { ColorRole, FactModel, ListModel, RowItemModel, RowPartModel } from '../protocol';
import { shortSubmoduleReason } from '../../views/rowLabels';
import { parseHints } from './status';

/** Same single-character markers `git submodule status` uses, and the buffer prints. */
const MARK: Record<SubmoduleState, string> = {
  ok: ' ',
  modified: '+',
  uninitialized: '-',
  conflict: 'U',
};

/**
 * The marker's colour is the buffer's: `submodulesRender` paints the same three marks
 * with the add, branch and del spans, so a modified submodule is amber in both UIs.
 */
const MARK_ROLE: Record<SubmoduleState, ColorRole> = {
  ok: 'added',
  modified: 'branch',
  uninitialized: 'deleted',
  conflict: 'deleted',
};

/**
 * The submodules screen as the panel draws it: one row per submodule, in the order git
 * lists them — the marker in its state colour, the path, the commit it is checked out
 * at, and the note the buffer adds beside it (its `describe`, or "not initialized").
 *
 * The input is `readSubmoduleStatus()` and the strings are the buffer's, so the two
 * screens say the same thing about a submodule, including why the list is unavailable.
 */
export function buildSubmodulesModel(repoPath: string, submodules: Submodule[], error?: string): ListModel {
  // No count line: the block heading carries `(n)` and an empty screen says so in its own
  // words. git's reason for not listing them at all stays — that is not a count.
  const facts: FactModel[] = error
    ? [{ label: '', value: t('submodules.reason', { message: shortSubmoduleReason(error) }), role: 'meta' }]
    : [];

  const rows: RowItemModel[] = submodules.map((sub) => {
    const note = sub.describe
      ? sub.describe
      : sub.state === 'uninitialized'
        ? t('submodules.note.notInitialized')
        : sub.state === 'conflict'
          ? t('submodules.note.conflict')
          : '';
    const parts: RowPartModel[] = [{ text: sub.sha, role: 'hash', gap: 2 }];
    if (note) {
      parts.push({ text: note, role: 'meta', gap: 2 });
    }
    return {
      id: `submodule:${sub.path}`,
      // The path alone is the row's text, so copying a row gives a path that can be
      // pasted into a terminal — the marker and the sha are decoration.
      text: sub.path,
      role: 'plain',
      marker: MARK[sub.state],
      markerRole: MARK_ROLE[sub.state],
      parts,
      aligned: true,
    };
  });

  return {
    kind: 'submodules',
    title: t('submodules.title', { repo: repoPath }),
    facts,
    hints: parseHints(t('submodules.keys')),
    blocks: [
      {
        title: t('submodules.section'),
        role: 'section',
        hints: [],
        rows,
        empty: error ? t('submodules.unavailableHint') : t('submodules.empty'),
      },
    ],
    selectFirst: t('webview.selectItem'),
    // An empty screen of submodules says there are none, not that there is nothing to see.
    emptyText: error ? t('submodules.unavailable') : t('submodules.empty'),
  };
}
