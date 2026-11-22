/**
 * Selection model of the file list, kept out of the webview so it can be tested.
 *
 * The list is flat: every row of every section, in the order the host sends them,
 * so a Shift range can cross section borders the way a text selection does in the
 * old buffer.
 */

export interface SelectionState {
  /** Selected ids, in the order they were chosen. */
  ids: string[];
  /** The other end of a Shift range: the last row clicked without Shift. */
  anchor?: string;
}

export const EMPTY_SELECTION: SelectionState = { ids: [] };

export interface ClickModifiers {
  shift?: boolean;
  /** Ctrl on Windows and Linux, Cmd on macOS. */
  ctrl?: boolean;
}

export function selectedSet(state: SelectionState): Set<string> {
  return new Set(state.ids);
}

/** Every id between `from` and `to` in list order, both ends included. */
export function rangeIds(order: readonly string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start < 0 || end < 0) {
    return end >= 0 ? [to] : [];
  }
  const [low, high] = start <= end ? [start, end] : [end, start];
  return order.slice(low, high + 1);
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Selection after a click.
 *
 * - plain click: only that row, and it becomes the anchor;
 * - `Ctrl+Click`: toggle one row, the anchor stays where it was;
 * - `Shift+Click`: the range from the anchor to the row, replacing the selection;
 * - `Ctrl+Shift+Click`: the same range, added to what is already selected.
 */
export function click(state: SelectionState, order: readonly string[], id: string, modifiers: ClickModifiers = {}): SelectionState {
  if (!order.includes(id)) {
    return state;
  }
  if (modifiers.shift) {
    const anchor = state.anchor && order.includes(state.anchor) ? state.anchor : id;
    const range = rangeIds(order, anchor, id);
    return {
      ids: modifiers.ctrl ? unique([...state.ids, ...range]) : range,
      anchor,
    };
  }
  if (modifiers.ctrl) {
    const ids = state.ids.includes(id) ? state.ids.filter((selected) => selected !== id) : [...state.ids, id];
    return { ids, anchor: id };
  }
  return { ids: [id], anchor: id };
}

/** Drag selection: the range from the row where the drag started, replacing the selection. */
export function drag(order: readonly string[], anchor: string, id: string): SelectionState {
  return { ids: rangeIds(order, anchor, id), anchor };
}

export function selectAll(order: readonly string[]): SelectionState {
  return { ids: [...order], anchor: order[0] };
}

export function clear(): SelectionState {
  return { ...EMPTY_SELECTION };
}

/**
 * The row the keyboard is on: the anchor of the selection, which is the row the caret
 * sits on in the text buffer. `retain` keeps the anchor inside the list, so an id that
 * left the screen never stays active.
 */
export function activeId(state: SelectionState): string | undefined {
  return state.anchor ?? state.ids[state.ids.length - 1];
}

/**
 * The DOM id of a row. A row id is a name, not a valid HTML id — `line:3`, `src/a.ts` —
 * so it is slugged; `aria-activedescendant` can only point at an id, and the client
 * needs one that the browser will accept verbatim.
 */
export function rowDomId(id: string): string {
  return `row-${id.replace(/[^\w-]+/g, '_')}`;
}

/** Drops ids that are no longer on screen, keeping the order and the anchor. */
export function retain(state: SelectionState, order: readonly string[]): SelectionState {
  const present = new Set(order);
  const ids = state.ids.filter((id) => present.has(id));
  const anchor = state.anchor && present.has(state.anchor) ? state.anchor : ids[ids.length - 1];
  return anchor ? { ids, anchor } : { ids };
}
