import { t, MessageKey } from '../i18n';

export type HelpView =
  | 'status'
  | 'diff-unstaged'
  | 'diff-staged'
  | 'log'
  | 'commit'
  | 'branches'
  | 'tags'
  | 'submodules'
  | 'text';

export interface HelpEntry {
  key: string;
  action: string;
}

type Entry = [key: string, message: MessageKey];

const COMMON: Entry[] = [
  ['h', 'help.common.help'],
  ['q', 'help.common.close'],
  ['Ctrl+Shift+P', 'help.common.palette'],
];

const SCREENS: Record<HelpView, { title: MessageKey; entries: Entry[] }> = {
  status: {
    title: 'help.screen.status',
    entries: [
      ['s', 'help.status'],
      ['u', 'help.unstage'],
      ['d', 'help.diff'],
      ['D', 'help.discard'],
      ['i', 'help.ignore'],
      ['Enter', 'help.openFile'],
      ['Shift+Enter', 'help.worktreeOpenWindow'],
      ['Alt+Enter', 'help.worktreeOpenHere'],
      ['c', 'help.commit'],
      ['m', 'help.amend'],
      ['z', 'help.stash'],
      ['a / p', 'help.stashApplyPop'],
      ['t', 'help.tagCreate'],
      ['A', 'help.remoteAdd'],
      ['n', 'help.worktreeAdd'],
      ['W', 'help.worktreePrune'],
      ['x', 'help.delete'],
      ['e', 'help.edit'],
      ['f / P / U', 'help.fetch'],
      ['R', 'help.reset'],
      ['M', 'help.abortMerge'],
      ['b', 'help.branches'],
      ['g', 'help.history'],
      ['T', 'help.tags'],
      ['S', 'help.submodules'],
      ['F', 'help.forge'],
    ],
  },
  'diff-unstaged': {
    title: 'help.screen.diffUnstaged',
    entries: [
      ['s', 'help.stageHunk'],
      ['T', 'help.tags'],
      ['Enter', 'help.openAtLine'],
    ],
  },
  'diff-staged': {
    title: 'help.screen.diffStaged',
    entries: [
      ['u', 'help.unstageHunk'],
      ['T', 'help.tags'],
      ['Enter', 'help.openAtLine'],
    ],
  },
  log: {
    title: 'help.screen.log',
    entries: [
      ['Enter', 'help.showCommit'],
      ['n', 'help.createBranch'],
      ['c', 'help.checkout'],
      ['C', 'help.cherryPick'],
      ['V', 'help.revert'],
      ['f', 'help.fixup'],
      ['R', 'help.reset'],
      ['a', 'help.toggleAll'],
      ['/', 'help.search'],
      ['x', 'help.clearFilters'],
      ['t', 'help.tagCreate'],
      ['g', 'help.history'],
      ['T', 'help.tags'],
    ],
  },
  commit: {
    title: 'help.screen.commit',
    entries: [['q', 'help.common.close']],
  },
  branches: {
    title: 'help.screen.branches',
    entries: [
      // Enter runs the same command as c, so the help lists the key the
      // hint line advertises.
      ['c', 'help.checkout'],
      ['n', 'help.branchCreate'],
      ['e', 'help.branchRename'],
      ['u', 'help.branchUpstream'],
      ['x', 'help.branchDelete'],
      ['D', 'help.branchDeleteRemote'],
      ['m', 'help.merge'],
      ['S', 'help.reset'],
      ['R', 'help.branchToggleRemote'],
      ['g', 'help.history'],
      ['T', 'help.tags'],
    ],
  },
  tags: {
    title: 'help.screen.tags',
    entries: [
      ['Enter', 'help.tagShow'],
      ['t', 'help.tagCreate'],
      ['e', 'help.tagMove'],
      ['x', 'help.tagDelete'],
      ['D', 'help.tagDeleteRemote'],
      ['U', 'help.tagPush'],
      ['g', 'help.history'],
      ['T', 'help.tags'],
    ],
  },
  submodules: {
    title: 'help.screen.submodules',
    entries: [
      ['Enter', 'help.submoduleEnter'],
      ['u', 'help.submoduleUpdate'],
      ['U', 'help.submoduleUpdateRemote'],
      ['g', 'help.history'],
      ['T', 'help.tags'],
    ],
  },
  text: {
    title: 'help.screen.text',
    entries: [['q', 'help.common.close']],
  },
};

function screenOf(view: string): HelpView {
  return (view in SCREENS ? view : 'status') as HelpView;
}

export function helpKeys(view: string): { title: string; entries: HelpEntry[] } {
  const screen = SCREENS[screenOf(view)];
  return {
    title: t(screen.title),
    entries: [
      ...screen.entries.map(([key, message]) => ({ key, action: t(message) })),
      ...COMMON.map(([key, message]) => ({ key, action: t(message) })),
    ],
  };
}

export function helpText(view: string): string {
  const { title, entries } = helpKeys(view);
  const width = Math.max(...entries.map((entry) => entry.key.length)) + 3;

  const lines: string[] = [];
  lines.push(t('help.title', { app: t('app.name'), screen: title }));
  lines.push('');
  for (const entry of entries) {
    lines.push(`  ${entry.key.padEnd(width)}${entry.action}`);
  }
  lines.push('');
  lines.push(`  ${t('help.close')}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
