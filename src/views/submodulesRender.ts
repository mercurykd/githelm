import { t } from '../i18n';
import type { Submodule, SubmoduleState } from '../git/submodules';
import { hintEntries, mergeColumns } from './columns';
import type { Span } from '../util/span';

export interface RenderedSubmodules {
  text: string;
  targets: Map<number, Submodule>;
  spans: Span[];
}

export function submodulesKeys(): string {
  return t('submodules.keys');
}

/** Same single-character markers `git submodule status` uses. */
const MARK: Record<SubmoduleState, string> = {
  ok: ' ',
  modified: '+',
  uninitialized: '-',
  conflict: 'U',
};

const MARK_KIND: Record<SubmoduleState, Span['kind']> = {
  ok: 'add',
  modified: 'branch',
  uninitialized: 'del',
  conflict: 'del',
};

const REASON_LIMIT = 120;

function shortReason(message: string): string {
  const line = message.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? message;
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length > REASON_LIMIT ? `${collapsed.slice(0, REASON_LIMIT - 1)}…` : collapsed;
}

export function renderSubmodules(repoPath: string, submodules: Submodule[], error?: string): RenderedSubmodules {
  const lines: string[] = [];
  const targets = new Map<number, Submodule>();
  const spans: Span[] = [];

  lines.push(t('submodules.title', { repo: repoPath }));
  spans.push({ line: 0, start: 0, end: lines[0].length, kind: 'title' });

  const counts = submodules.reduce<Record<string, number>>((acc, sub) => {
    acc[sub.state] = (acc[sub.state] ?? 0) + 1;
    return acc;
  }, {});
  const parts = (Object.keys(counts) as SubmoduleState[]).map((state) =>
    t(`submodules.state.${state}` as const, { count: counts[state] })
  );
  const summary = error
    ? t('submodules.unavailable')
    : submodules.length === 0
      ? t('submodules.empty')
      : t('submodules.count', { count: submodules.length, states: parts.join(', ') });
  lines.push(summary);
  spans.push({ line: 1, start: 0, end: summary.length, kind: 'meta' });
  lines.push('');

  if (error) {
    lines.push(`  ${t('submodules.unavailableHint')}`);
    // git's own words are worth keeping, but a raw stderr line can be hundreds
    // of characters of shell noise, so only its first useful sentence is shown.
    lines.push(`  ${t('submodules.reason', { message: shortReason(error) })}`);
  } else if (submodules.length === 0) {
    lines.push(`  ${t('submodules.empty')}`);
  }

  for (const sub of submodules) {
    const lineNumber = lines.length + 1;
    const note = sub.describe
      ? sub.describe
      : sub.state === 'uninitialized'
        ? t('submodules.note.notInitialized')
        : sub.state === 'conflict'
          ? t('submodules.note.conflict')
          : '';
    const text = ` ${MARK[sub.state]} ${sub.path}  ${sub.sha}${note ? `  ${note}` : ''}`;
    lines.push(text);
    targets.set(lineNumber, sub);
    spans.push({ line: lineNumber - 1, start: 1, end: 2, kind: MARK_KIND[sub.state] });
    const pathStart = 4;
    spans.push({ line: lineNumber - 1, start: pathStart, end: pathStart + sub.path.length, kind: 'path' });
    const shaStart = pathStart + sub.path.length + 2;
    spans.push({ line: lineNumber - 1, start: shaStart, end: shaStart + sub.sha.length, kind: 'hash' });
    if (note) {
      spans.push({ line: lineNumber - 1, start: shaStart + sub.sha.length + 2, end: text.length, kind: 'meta' });
    }
  }

  const merged = mergeColumns(lines, hintEntries(submodulesKeys(), t('status.keysHeader')));
  for (const span of merged.spans) {
    spans.push(span);
  }

  return { text: `${merged.lines.join('\n')}\n`, targets, spans };
}
