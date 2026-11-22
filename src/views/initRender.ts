import { t } from '../i18n';
import type { Span } from '../util/span';

/**
 * The `git init` screen, as a document a panel can draw.
 *
 * A folder that is not a repository has no `git status`, so the status model cannot be
 * built for it; this screen is the whole of what such a folder can be asked, which is why
 * it is a renderer of its own and not a branch inside the status model.
 */
export interface InitScreen {
  text: string;
  spans: Span[];
  /** The 1-based line of the `git init` row: the only row that carries an action. */
  row: number;
}

/** The hairline under a hint, kept short enough to leave the right-hand column alone. */
const RULE_WIDTH = 60;

/** The text and the spans of the screen: one row, `git init`, and the keys of the screen. */
export function renderInit(folderPath: string): InitScreen {
  const lines: string[] = [];
  const spans: Span[] = [];

  const repoLine = `${t('status.repoLabel')} ${folderPath}`;
  lines.push(repoLine);
  spans.push({ line: 0, start: 0, end: repoLine.length, kind: 'meta' });

  const notRepoLine = `  ${t('status.notRepoHint')}`;
  lines.push(notRepoLine);
  spans.push({ line: 1, start: 2, end: notRepoLine.length, kind: 'meta' });
  lines.push('');

  const headerText = `## ${t('status.section.init')} (1)`;
  const headerLine = lines.length;
  lines.push(headerText);
  spans.push({ line: headerLine, start: 0, end: 2, kind: 'meta' });
  spans.push({ line: headerLine, start: 3, end: headerText.length, kind: 'section' });

  // The hints of the screen, closed by a hairline instead of a blank row: the rule draws
  // the group boundary without spending a line on empty space.
  const hint = `  ${t('status.initKeys')}`;
  lines.push(hint);
  spans.push({ line: lines.length - 1, start: 2, end: hint.length, kind: 'help' });
  const rule = `  ${'─'.repeat(Math.max(1, Math.min(t('status.initKeys').length, RULE_WIDTH - 2)))}`;
  lines.push(rule);
  spans.push({ line: lines.length - 1, start: 2, end: rule.length, kind: 'rule' });

  const actionLine = lines.length;
  const actionText = `  ${t('status.initAction')}`;
  lines.push(actionText);
  spans.push({ line: actionLine, start: 2, end: actionText.length, kind: 'branch' });
  lines.push('');

  // No keys column here: it lists the keys of a repository (`c commit`, `b branches`,
  // `R reset`), and this screen has one row and one key, already printed under its header.
  return { text: `${lines.join('\n')}\n`, spans, row: actionLine + 1 };
}

/** Whether a 1-based line of the screen is its `git init` row. */
export function isInitRow(folderPath: string, row: number): boolean {
  return renderInit(folderPath).row === row;
}
