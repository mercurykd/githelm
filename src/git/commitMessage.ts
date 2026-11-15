import { t } from '../i18n';
import { StatusEntry } from './status';

/**
 * Commit buffer template: an empty area for the message followed by `#`
 * comments. We strip `#` lines before committing because the message goes
 * through `-F`, which does not run git's cleanup rules.
 */
export function buildCommitTemplate(staged: StatusEntry[]): string {
  const lines: string[] = ['', ''];
  lines.push(t('commit.hint'));
  lines.push(t('commit.saveHint'));
  lines.push('#');
  if (staged.length > 0) {
    lines.push(t('commit.stagedHeader', { count: staged.length }));
    for (const entry of staged) {
      lines.push(`#   ${entry.xy} ${entry.path}`);
    }
  } else {
    lines.push(t('commit.noStaged'));
  }
  return `${lines.join('\n')}\n`;
}

/** Drops `#` comment lines and blank edges; returns '' when nothing is left. */
export function cleanCommitMessage(raw: string): string {
  const kept = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return kept.trim();
}
