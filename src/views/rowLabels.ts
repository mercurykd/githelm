import type { BranchEntry } from '../git/actions';
import { t } from '../i18n';

/**
 * The text a branch row carries after its name: what it tracks and how far it has drifted.
 * A remote branch and a branch with no commit behind it have nothing to say.
 */
export function trackingLabel(entry: BranchEntry): string {
  if (entry.isRemote) {
    return '';
  }
  if (entry.unborn) {
    // A branch HEAD points at, with no commit behind it: nothing tracks it yet.
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

/** A git error, cut to one line a row can show. */
const REASON_LIMIT = 120;

export function shortSubmoduleReason(message: string): string {
  const line =
    message
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? message;
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length > REASON_LIMIT ? `${collapsed.slice(0, REASON_LIMIT - 1)}…` : collapsed;
}

/** `c commit   alt+s stage all` → `['c commit', 'alt+s stage all']`. */
export function keySegments(keysLine: string): string[] {
  return keysLine
    .split(/\s{3,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}
