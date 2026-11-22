import { allActions, formatAction, formatClock } from '../../git/actionLog';
import { t } from '../../i18n';
import type { FactModel, ListModel, RowItemModel } from '../protocol';
import { parseHints } from './status';

/**
 * The action log as the panel draws it: every `git` call the extension made, newest
 * first, with the clock on the left and the command with its exit code and duration on
 * the right — the two columns the text buffer prints.
 *
 * The screen has no repository of its own: it is a log, not a screen of a checkout, so
 * the model takes nothing. The buffer's lines are painted plain, and so are the rows;
 * only the clock takes the date colour the other screens give a time.
 */
export function buildActionLogModel(): ListModel {
  // Newest first: the last thing that happened is what you look for.
  const records = [...allActions()].reverse();

  const facts: FactModel[] = [
    { label: '', value: t('actionLog.count', { count: records.length }), role: 'meta' },
  ];

  const rows: RowItemModel[] = records.map((record, index) => ({
    // The record's place in the log is its id. A refresh that only appends leaves the
    // older rows in place, so the selection stays on the row the user was reading.
    id: `action:${records.length - 1 - index}`,
    text: formatAction(record),
    role: 'plain',
    marker: formatClock(record.at),
    markerRole: 'date',
  }));

  return {
    kind: 'actionlog',
    title: t('actionLog.title', { app: t('app.name') }),
    facts,
    keysTitle: t('status.keysHeader'),
    hints: parseHints(t('actionLog.keys')),
    blocks: [
      {
        title: t('actionLog.section'),
        role: 'section',
        hints: [],
        rows,
        empty: t('actionLog.empty'),
      },
    ],
    selectFirst: t('webview.selectItem'),
    emptyText: t('webview.emptyList'),
  };
}
