export interface ActionRecord {
  at: number;
  args: string[];
  code: number;
  ms: number;
  error?: string;
}

const MAX_RECORDS = 300;
const records: ActionRecord[] = [];
const listeners = new Set<(record: ActionRecord) => void>();

/** Every `git` call made by the extension ends up here. */
export function recordAction(record: ActionRecord): void {
  records.push(record);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
  for (const listener of listeners) {
    listener(record);
  }
}

export function allActions(): ActionRecord[] {
  return [...records];
}

export function recentActions(limit = 5): ActionRecord[] {
  return records.slice(-limit).reverse();
}

export function clearActions(): void {
  records.length = 0;
}

export function subscribe(listener: (record: ActionRecord) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'rev-list',
  'for-each-ref',
  'blame',
  'cat-file',
  'symbolic-ref',
]);

/** Read-only plumbing (polls, refreshes) is noisy; the status bar hides it. */
export function isMutating(args: string[]): boolean {
  const [command, sub] = args;
  if (!command) {
    return false;
  }
  if (READ_ONLY.has(command)) {
    return false;
  }
  if (command === 'stash' && sub === 'list') {
    return false;
  }
  if (command === 'tag' && (args.length === 1 || sub === '-l' || sub === '--list')) {
    return false;
  }
  if (command === 'remote' && (args.length === 1 || args.includes('-v'))) {
    return false;
  }
  if (command === 'branch' && (args.length === 1 || sub === '--show-current')) {
    return false;
  }
  return true;
}

/** Local wall-clock time of a record: `20:15:03`. */
export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatAction(record: ActionRecord, maxLength = 120): string {
  const command = `git ${record.args.join(' ')}`;
  const status = record.code === 0 ? `→ 0 (${record.ms} ms)` : `→ ${record.code}`;
  const error = record.error ? `  ✗ ${record.error.split('\n')[0]}` : '';
  const text = `${command}  ${status}${error}`;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Short label for the status bar: `fetch origin --prune`. */
export function shortLabel(record: ActionRecord, maxLength = 40): string {
  const text = record.args.join(' ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * The whole command, never cut: the recent-actions section of the status buffer
 * has a column of its own, so a long `-m "…"` message must be readable instead
 * of turning into an ellipsis that hides what was actually run.
 */
export function actionLabel(record: ActionRecord): string {
  return record.args.join(' ');
}
