/**
 * Keyboard mapping of the status webview.
 *
 * Keys are matched by `event.code` — the physical key — and never by `event.key`,
 * which is what the layout produces: on a Russian layout the `s` key reports `ы`,
 * and every letter binding in the panel stopped matching. Modifiers decide the
 * variant (`Shift+T` is the tags screen, `T` alone tags HEAD).
 *
 * Pure on purpose: the mapping is easy to break and easy to test.
 */

import type { DocKind, ScreenAction, ScreenKind } from './protocol';

export interface KeyEventLike {
  /** Physical key, e.g. `KeyS`, `Enter`, `ArrowUp`. */
  code: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The physical key with the numeric keypad folded into the row above it: the keypad's
 * Enter is Enter, and its `/` is the same `/` the history screen uses for its filters.
 *
 * VS Code's own keybindings do this folding for the text buffers, so `enter` in the
 * manifest fires from either Enter. The DOM names the keypad key `NumpadEnter`, so a
 * panel that matched `code` alone did nothing when the reader pressed the keypad — the
 * key worked in a buffer and was silent in a panel.
 */
export function physicalCode(event: KeyEventLike): string {
  if (event.code === 'NumpadEnter') {
    return 'Enter';
  }
  if (event.code === 'NumpadDivide') {
    return 'Slash';
  }
  return event.code;
}

/** The keys the text buffer has and the panel does not yet. */
const BUFFER_ONLY = new Set<string>([]);

/** Screen openers; the host checks them against its own allow-list. */
const OPENERS: Record<string, string> = {
  KeyG: 'githelm.log.open',
  KeyB: 'githelm.branches.open',
  KeyT: 'githelm.tags.open',
  KeyS: 'githelm.submodules.open',
  KeyL: 'githelm.actionLog',
};

export type KeyCommand =
  | {
      kind: 'action';
      action:
        | 'stage'
        | 'unstage'
        | 'diff'
        | 'ignore'
        | 'discard'
        | 'commit'
        | 'tag'
        | 'stash'
        | 'stageAll'
        | 'unstageAll'
        | 'amend'
        | 'fetch'
        | 'pull'
        | 'push'
        | 'reset'
        | 'abort'
        | 'pulls'
        | 'stashApply'
        | 'stashPop'
        | 'delete'
        | 'edit'
        | 'remoteAdd'
        | 'worktreeAdd'
        | 'worktreePrune'
        | 'worktreeWindow'
        | 'worktreeHere'
        | 'refresh'
        | 'close';
    }
  | { kind: 'opener'; command: string }
  | { kind: 'open' }
  | { kind: 'selectAll' }
  | { kind: 'copy' }
  | { kind: 'clear' }
  | { kind: 'bufferOnly' }
  | { kind: 'move'; direction: 'up' | 'down'; extend: boolean };

export function resolveKey(event: KeyEventLike): KeyCommand | undefined {
  const code = physicalCode(event);
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  if (ctrl && !alt) {
    if (code === 'KeyA') {
      return { kind: 'selectAll' };
    }
    if (code === 'KeyC') {
      return { kind: 'copy' };
    }
    return undefined;
  }

  if (alt && !ctrl) {
    if (code === 'KeyS') {
      return { kind: 'action', action: 'stageAll' };
    }
    if (code === 'KeyU') {
      return { kind: 'action', action: 'unstageAll' };
    }
    if (code === 'Enter' && !shift) {
      // `Alt+Enter` reloads this window on the worktree under the cursor.
      return { kind: 'action', action: 'worktreeHere' };
    }
    return undefined;
  }

  if (ctrl) {
    return undefined;
  }

  if (code === 'Escape') {
    return { kind: 'clear' };
  }
  if (code === 'Enter') {
    // `Shift+Enter` opens the worktree under the cursor in a new window; anywhere
    // else both keys keep the buffer's meaning and `Enter` opens the entry.
    return shift ? { kind: 'action', action: 'worktreeWindow' } : { kind: 'open' };
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    return { kind: 'move', direction: code === 'ArrowDown' ? 'down' : 'up', extend: shift };
  }

  // Shift turns the same physical key into the "bigger" variant, exactly as the
  // buffer does: `t` tags HEAD, `T` opens the tags screen.
  if (shift) {
    switch (code) {
      case 'KeyT':
        return { kind: 'opener', command: 'githelm.tags.open' };
      case 'KeyS':
        return { kind: 'opener', command: 'githelm.submodules.open' };
      case 'KeyD':
        return { kind: 'action', action: 'discard' };
      case 'KeyP':
        return { kind: 'action', action: 'pull' };
      case 'KeyU':
        return { kind: 'action', action: 'push' };
      case 'KeyR':
        return { kind: 'action', action: 'reset' };
      case 'KeyM':
        return { kind: 'action', action: 'abort' };
      case 'KeyF':
        return { kind: 'action', action: 'pulls' };
      case 'KeyA':
        return { kind: 'action', action: 'remoteAdd' };
      case 'KeyW':
        return { kind: 'action', action: 'worktreePrune' };
      default:
        return undefined;
    }
  }

  switch (code) {
    case 'KeyS':
      return { kind: 'action', action: 'stage' };
    case 'KeyU':
      return { kind: 'action', action: 'unstage' };
    case 'KeyD':
      return { kind: 'action', action: 'diff' };
    case 'KeyI':
      return { kind: 'action', action: 'ignore' };
    case 'KeyC':
      return { kind: 'action', action: 'commit' };
    case 'KeyT':
      return { kind: 'action', action: 'tag' };
    case 'KeyZ':
      return { kind: 'action', action: 'stash' };
    case 'KeyM':
      return { kind: 'action', action: 'amend' };
    case 'KeyF':
      return { kind: 'action', action: 'fetch' };
    case 'KeyA':
      return { kind: 'action', action: 'stashApply' };
    case 'KeyP':
      return { kind: 'action', action: 'stashPop' };
    case 'KeyX':
      return { kind: 'action', action: 'delete' };
    case 'KeyE':
      return { kind: 'action', action: 'edit' };
    case 'KeyN':
      return { kind: 'action', action: 'worktreeAdd' };
    case 'KeyR':
      return { kind: 'action', action: 'refresh' };
    case 'KeyQ':
      return { kind: 'action', action: 'close' };
    default:
      break;
  }

  const opener = OPENERS[code];
  if (opener) {
    return { kind: 'opener', command: opener };
  }
  if (BUFFER_ONLY.has(code)) {
    return { kind: 'bufferOnly' };
  }
  return undefined;
}

/**
 * A key as one string: `n`, `shift+d`, `alt+enter`. The tables below are written in
 * the same notation the buffers' hints use, so a key map reads like the help screen.
 */
export function chordOf(event: KeyEventLike): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push('ctrl');
  }
  if (event.altKey) {
    parts.push('alt');
  }
  if (event.shiftKey) {
    parts.push('shift');
  }
  parts.push(physicalCode(event));
  return parts.join('+');
}

/**
 * The keys of the screens that are not the status screen, in the notation `chordOf()`
 * produces. Each one names an action of that screen; the same name can mean different
 * things on two screens (`t` creates a tag on the tags screen, tags HEAD on the status
 * screen), which is why the table belongs to the screen and not to the panel.
 */
export const SCREEN_KEYS: Record<Exclude<ScreenKind, 'status'>, Record<string, ScreenAction>> = {
  log: {
    Enter: 'show',
    KeyN: 'create',
    KeyC: 'checkout',
    KeyQ: 'close',
    KeyR: 'refresh',
    KeyA: 'toggleAll',
    KeyS: 'sort',
    KeyT: 'tag',
    KeyF: 'fixup',
    KeyX: 'resetFilters',
    KeyD: 'compare',
    Slash: 'filters',
    'shift+KeyC': 'cherryPick',
    'shift+KeyV': 'revert',
    'shift+KeyR': 'reset',
  },
  branches: {
    Enter: 'checkout',
    KeyC: 'checkout',
    KeyN: 'create',
    KeyE: 'rename',
    KeyU: 'upstream',
    KeyX: 'remove',
    KeyM: 'merge',
    KeyD: 'compare',
    KeyR: 'refresh',
    KeyQ: 'close',
    'shift+KeyR': 'toggleRemote',
    'shift+KeyD': 'removeRemote',
    'shift+KeyS': 'reset',
  },
  tags: {
    Enter: 'show',
    KeyT: 'create',
    KeyE: 'move',
    KeyX: 'remove',
    KeyR: 'refresh',
    KeyQ: 'close',
    'shift+KeyU': 'push',
    'shift+KeyD': 'removeRemote',
  },
  submodules: {
    // Enter opens the submodule as a repository of its own — the status screen of that
    // checkout, which is where its changes are staged or discarded.
    Enter: 'open',
    KeyU: 'update',
    KeyR: 'refresh',
    KeyQ: 'close',
    'shift+KeyU': 'updateRemote',
  },
  actionlog: {
    // `c` clears here instead of checking out: the log is not a screen of a repository.
    KeyC: 'clearLog',
    KeyR: 'refresh',
    KeyQ: 'close',
  },
};

/** The action a key has on one of the list screens, or `undefined` for a key it lacks. */
export function resolveScreenKey(screen: ScreenKind, event: KeyEventLike): ScreenAction | undefined {
  if (screen === 'status') {
    return undefined;
  }
  return SCREEN_KEYS[screen][chordOf(event)];
}

/**
 * The actions that act on the row under the cursor, so they need one. `refresh` and the
 * full-screen ones work with nothing selected, exactly as they do in the buffer.
 */
export const SCREEN_NEEDS_ROW: Record<Exclude<ScreenKind, 'status'>, ScreenAction[]> = {
  log: ['show', 'create', 'checkout', 'tag', 'fixup', 'cherryPick', 'revert', 'reset', 'compare'],
  branches: ['checkout', 'rename', 'upstream', 'remove', 'removeRemote', 'merge', 'reset', 'compare'],
  tags: ['show', 'move', 'push', 'remove', 'removeRemote'],
  submodules: ['open', 'update', 'updateRemote'],
  // The log is read, not worked in: every key is the screen's own.
  actionlog: [],
};

/**
 * The keys of the sub-screens: a document instead of a list, and the manifest's own
 * bindings for it. `d` diffs the file under a row of a file list, `o` takes our side of
 * a conflict — the same letters the text buffer binds for that view.
 */
export const DOC_KEYS: Record<DocKind, Record<string, ScreenAction>> = {
  // A commit: its metadata and the files it touched; `d` diffs the file under the row, `t`
  // opens it as a tab of its own, as the commit left it.
  commit: {
    KeyD: 'fileDiff',
    KeyT: 'filesAtRef',
    KeyR: 'refresh',
    KeyQ: 'close',
  },
  stash: {
    KeyD: 'fileDiff',
    KeyR: 'refresh',
    KeyQ: 'close',
  },
  conflict: {
    KeyO: 'ours',
    KeyM: 'mergeEditor',
    KeyS: 'resolve',
    'shift+KeyT': 'theirs',
    'shift+KeyB': 'base',
    KeyR: 'refresh',
    KeyQ: 'close',
  },
  file: {
    KeyR: 'refresh',
    KeyQ: 'close',
  },
  // A folder that is not a repository: the screen says so and offers `git init`, so `Enter`
  // is the one key of its one row.
  init: {
    Enter: 'open',
    KeyR: 'refresh',
    KeyQ: 'close',
  },
};

/** The actions of a sub-screen that need a line under them. */
export const DOC_NEEDS_LINE: Record<DocKind, ScreenAction[]> = {
  commit: ['fileDiff', 'filesAtRef'],
  stash: ['fileDiff'],
  conflict: ['ours', 'theirs', 'base', 'mergeEditor', 'resolve'],
  file: [],
  // The init screen needs no selected row: the screen is one action, and `Enter` without a
  // caret would otherwise answer "select a row first" on the one row there is.
  init: [],
};

/** The action a key has on a sub-screen, or `undefined` for a key it lacks. */
export function resolveDocKey(screen: DocKind, event: KeyEventLike): ScreenAction | undefined {
  return DOC_KEYS[screen][chordOf(event)];
}


/**
 * The keys every panel has, whatever screen it shows: selection, movement, copy and the
 * screen openers. A list screen consults its own table first, so `t` still creates a tag
 * on the tags screen instead of opening it again.
 */
export function resolveCommonKey(event: KeyEventLike): Exclude<KeyCommand, { kind: 'action' }> | undefined {
  const code = physicalCode(event);
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  if (ctrl && !alt) {
    if (code === 'KeyA') {
      return { kind: 'selectAll' };
    }
    if (code === 'KeyC') {
      return { kind: 'copy' };
    }
    return undefined;
  }
  if (ctrl) {
    return undefined;
  }
  if (alt) {
    // Alt chords belong to a screen, never to all of them.
    return undefined;
  }
  if (code === 'Escape') {
    return { kind: 'clear' };
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    return { kind: 'move', direction: code === 'ArrowDown' ? 'down' : 'up', extend: shift };
  }
  if (shift) {
    switch (code) {
      case 'KeyT':
        return { kind: 'opener', command: 'githelm.tags.open' };
      case 'KeyS':
        return { kind: 'opener', command: 'githelm.submodules.open' };
      default:
        return undefined;
    }
  }
  const opener = OPENERS[code];
  return opener ? { kind: 'opener', command: opener } : undefined;
}
