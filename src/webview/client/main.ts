import {
  DOC_NEEDS_LINE,
  resolveCommonKey,
  resolveDocKey,
  resolveScreenKey,
  resolveStatusKey,
  SCREEN_NEEDS_ROW,
  type KeyCommand,
} from '../keys.js';
import { autoscrollDelta } from '../pointer.js';

import { activeId, click, clear, drag, retain, rowDomId, selectAll, selectedSet, type SelectionState } from '../selection.js';
import type {
  ClientMessage,
  ColorRole,
  ColumnRowModel,
  CommitsBlockModel,
  DocLineModel,
  DocModel,
  DocSegmentModel,
  FactModel,
  HintModel,
  HostMessage,
  ListModel,
  LogModel,
  LogRowModel,
  RowBlockModel,
  RowItemModel,
  RowModel,
  ScreenAction,
  ScreenModel,
  StatusModel,
  WebviewAction,
} from '../protocol.js';

interface WebviewApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): WebviewApi;

const api = acquireVsCodeApi();
const root = document.getElementById('app');
if (!root) {
  throw new Error('the status webview has no #app element');
}
const app: HTMLElement = root;
app.tabIndex = -1;
app.focus();

let model: ScreenModel | undefined;
let selection: SelectionState = { ids: [] };
let dragAnchor: string | undefined;
/** A drag is in progress: the button went down on a row and has not come up yet. */
let dragging = false;
/** Where the pointer is, in viewport pixels: the drag autoscroll reads it every frame. */
let pointerX = 0;
let pointerY = 0;
let scrollFrame: number | undefined;
/** Set once the panel has asked for the next page of history, cleared by its arrival. */
let moreAsked = false;


/** Only the actions that need rows; `refresh`, `close` and the two "all" work always. */
const NEEDS_SELECTION = new Set<WebviewAction>(['stage', 'unstage', 'diff', 'open', 'ignore']);

function post(message: ClientMessage): void {
  api.postMessage(message);
}

function save(): void {
  api.setState({ selection });
}

function order(): string[] {
  if (!model) {
    return [];
  }
  switch (model.kind) {
    case 'status': {
      const files = model.sections.flatMap((section) => section.rows.map((row) => row.id));
      // The right-hand column is part of the same screen, so the arrows walk into it
      // exactly as the caret does in the text buffer.
      const column = model.column.flatMap((block) => block.rows.map((row) => row.id));
      // And so is the branch block under the files: its rows are selectable, and their
      // keys are the branches screen's (see `resolveStatusKey`).
      const branches = model.branches.rows.map((row) => row.id);
      // The last commits are rows of the same kind: the history screen's keys act on them.
      const commits = model.commits.rows.map((row) => row.id);
      return [...files, ...column, ...branches, ...commits];
    }
    case 'log':
      // The filters are inputs above the list, not rows, so the arrows walk the history.
      return model.rows.map((row) => row.id);
    case 'doc':
      // Every line is a row, so the arrows walk the document the caret walks the buffer.
      return model.lines.map((line) => line.id);
    default:
      return model.blocks.flatMap((block) => block.rows.map((row) => row.id));
  }
}

// ---------------------------------------------------------------- rendering

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function toast(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const box = element('div', `toast toast-${level}`, text);
  app.append(box);
  setTimeout(() => box.remove(), 4000);
}

function send(action: WebviewAction): void {
  if (NEEDS_SELECTION.has(action) && selection.ids.length === 0) {
    if (model) {
      toast(model.selectFirst);
    }
    return;
  }
  post({ type: 'action', action, ids: selection.ids });
}

/** A key of a list screen; the host routes it to the screen this panel shows. */
function sendScreen(action: ScreenAction): void {
  const needsRow =
    model !== undefined &&
    (model.kind === 'doc'
      ? DOC_NEEDS_LINE[model.screen].includes(action)
      : model.kind !== 'status' && SCREEN_NEEDS_ROW[model.kind].includes(action));
  if (needsRow && selection.ids.length === 0) {
    if (model) {
      toast(model.selectFirst);
    }
    return;
  }
  post({ type: 'screen', action, ids: selection.ids });
}

/** The key line of a block, printed the way the text buffer prints it (`s stage  u unstage`). */
function hintLine(hints: HintModel[]): HTMLElement {
  const line = element('p', 'hint-line');
  for (const hint of hints) {
    const item = element('span', 'hint-item');
    item.append(element('kbd', 'hint-keys', hint.keys));
    if (hint.label) {
      item.append(element('span', 'hint-label', hint.label));
    }
    line.append(item);
  }
  return line;
}

/** A block header, painted with the role the buffer gives the same title. */
/**
 * A `## title (n)` heading. The buffer prints the count for a list of rows; a heading
 * that summarises something else (the history's filters) passes `undefined` and gets
 * the bare `## title` the buffer prints for it.
 */
function blockTitle(title: string, count: number | undefined, role: ColorRole): HTMLElement {
  // A heading with no rows under it is not a target, so it does not look like one.
  const header = element('h2', count === undefined ? `block-title static role-${role}` : `block-title role-${role}`);
  header.append(element('span', 'block-name', title));
  if (count !== undefined) {
    header.append(element('span', 'count', `(${count})`));
    header.dataset.section = title;
  }
  return header;
}

/**
 * The key hints of the header, in the column that starts at the middle of the panel, right of
 * the screen's own line — the repository, an em dash, the screen. They have no word of their
 * own in front, because there is only one list of keys on a screen and a heading over it would
 * name what is already plain, and they wrap in that column instead of running off the panel.
 */
function renderKeys(container: HTMLElement, hints: HintModel[]): void {
  if (hints.length === 0) {
    return;
  }
  const block = element('section', 'keys-block');
  const list = element('ul', 'hint-list');
  for (const hint of hints) {
    const item = element('li', 'hint');
    item.append(element('kbd', 'hint-keys', hint.keys));
    if (hint.label) {
      item.append(element('span', 'hint-label', hint.label));
    }
    list.append(item);
  }
  block.append(list);
  container.append(block);
}

/**
 * The lines that say where the screen is looking, drawn under the header and above the rows.
 * Only the status screen has them — the list screens count their own rows in the block
 * headings — so an empty list adds no element and no gap.
 */
function renderFacts(container: HTMLElement, facts: FactModel[]): void {
  if (facts.length === 0) {
    return;
  }
  const list = element('dl', 'facts');
  for (const fact of facts) {
    list.append(element('dt', 'fact-label', fact.label));
    const value = element('dd', `fact-value${fact.muted ? ' muted' : ''}`);
    value.append(element('span', `fact-main role-${fact.role}`, fact.value));
    for (const part of fact.parts ?? []) {
      value.append(element('span', `fact-part role-${part.role} gap-${part.gap}`, part.text));
    }
    list.append(value);
  }
  container.append(list);
}

function renderRow(row: RowModel, selected: Set<string>): HTMLLIElement {
  const item = element('li', selected.has(row.id) ? 'row selected' : 'row');
  item.dataset.id = row.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', selected.has(row.id) ? 'true' : 'false');
  // The code cell takes its colour from the status letter, the path from the
  // section — the two choices statusRender.ts makes for the text buffer.
  item.append(element('span', `code role-${row.codeRole}`, row.xy));
  item.append(element('span', `path role-${row.pathRole}`, row.path));
  if (row.origPath) {
    item.append(element('span', 'orig-path', row.origPath));
  }
  return item;
}

function renderSections(container: HTMLElement, current: StatusModel): void {
  const selected = selectedSet(selection);
  const files = element('div', 'files');
  let visible = 0;
  for (const section of current.sections) {
    const block = element('section', 'block');
    block.dataset.kind = section.kind;
    block.append(blockTitle(section.title, section.rows.length, section.kind));
    block.append(hintLine(section.hints));
    if (section.rows.length > 0) {
      const list = element('ul', 'rows');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-multiselectable', 'true');
      list.dataset.kind = section.kind;
      for (const row of section.rows) {
        list.append(renderRow(row, selected));
      }
      block.append(list);
      visible += section.rows.length;
    }
    files.append(block);
  }
  if (visible === 0) {
    files.append(element('p', 'clean', current.cleanText));
  }
  container.append(files);
}

function renderColumnRow(row: ColumnRowModel, selected: Set<string>): HTMLLIElement {
  const item = element('li', row.inline ? 'column-row inline' : 'column-row');
  item.dataset.id = row.id;
  item.classList.toggle('selected', selected.has(row.id));
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', selected.has(row.id) ? 'true' : 'false');
  item.append(element('span', `column-text role-${row.mainRole}`, row.text));
  if (row.detail) {
    item.append(element('span', `column-detail role-${row.detailRole ?? 'plain'}`, row.detail));
  }
  return item;
}

function renderColumn(container: HTMLElement, current: StatusModel): void {
  const aside = element('aside', 'column');
  const selected = selectedSet(selection);
  for (const block of current.column) {
    const section = element('section', 'block');
    section.append(blockTitle(block.title, block.rows.length, block.role));
    section.append(hintLine(block.hints));
    if (block.rows.length === 0) {
      if (block.empty) {
        section.append(element('p', 'block-empty', block.empty));
      }
    } else {
      const list = element('ul', 'column-rows');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-multiselectable', 'true');
      for (const row of block.rows) {
        list.append(renderColumnRow(row, selected));
      }
      section.append(list);
    }
    aside.append(section);
  }
  container.append(aside);
}

function renderCommits(container: HTMLElement, block: CommitsBlockModel, selected: Set<string>): void {
  if (block.rows.length === 0) {
    return;
  }
  const section = element('section', 'block commits');
  section.append(blockTitle(block.title, block.rows.length, 'section'));
  section.append(hintLine(block.hints));
  const list = element('ul', 'commit-rows');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');
  // Each row is its own grid so it can be selected and hovered as one box; the author
  // column is measured by the model so every row still starts its message together.
  list.style.setProperty('--commit-author-width', `${Math.max(1, block.authorWidth)}ch`);
  for (const commit of block.rows) {
    const classes = selected.has(commit.id) ? 'row commit-row selected' : 'row commit-row';
    const item = element('li', classes);
    item.dataset.id = commit.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', selected.has(commit.id) ? 'true' : 'false');
    // The buffer leaves the subject unpainted, so the panel does too.
    item.append(element('span', 'commit-sha role-hash', commit.sha));
    item.append(element('span', 'commit-date role-meta', commit.date));
    item.append(element('span', 'commit-author role-author', commit.author));
    // The refs sit in front of the subject, on the row of the commit they point at, so
    // a tag on the head commit is visible without opening the history.
    const message = element('span', 'commit-message');
    if (commit.refs.length > 0) {
      message.append(element('span', 'commit-refs role-refs', commit.refs));
    }
    message.append(element('span', 'commit-subject', commit.subject));
    item.append(message);
    list.append(item);
  }
  section.append(list);
  container.append(section);
}

/** A row of a list screen: a marker, the name, parts of the row, then a note under it. */
function renderItemRow(row: RowItemModel, selected: Set<string>): HTMLLIElement {
  const classes = ['row', 'item-row'];
  // A table row keeps the buffer's column padding instead of a flex gap.
  if (row.aligned) {
    classes.push('aligned');
  }
  if (selected.has(row.id)) {
    classes.push('selected');
  }
  const item = element('li', classes.join(' '));
  item.dataset.id = row.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', selected.has(row.id) ? 'true' : 'false');
  if (row.marker !== undefined) {
    item.append(element('span', `item-marker role-${row.markerRole ?? 'plain'}`, row.marker));
  }
  item.append(element('span', `item-text role-${row.role}`, row.text));
  for (const part of row.parts ?? []) {
    item.append(element('span', `item-part role-${part.role} gap-${part.gap ?? 1}`, part.text));
  }
  if (row.note) {
    item.append(element('span', `item-note role-${row.noteRole ?? 'meta'}`, row.note));
  }
  return item;
}

function renderRowBlock(container: HTMLElement, block: RowBlockModel, selected: Set<string>): void {
  const section = element('section', 'block');
  section.append(blockTitle(block.title, block.rows.length, block.role));
  section.append(hintLine(block.hints));
  if (block.rows.length === 0) {
    if (block.empty) {
      section.append(element('p', 'block-empty', block.empty));
    }
  } else {
    const list = element('ul', 'rows item-rows');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    for (const row of block.rows) {
      list.append(renderItemRow(row, selected));
    }
    section.append(list);
  }
  container.append(section);
}

function renderList(container: HTMLElement, list: ListModel): void {
  const selected = selectedSet(selection);
  const visible = list.blocks.reduce((count, block) => count + block.rows.length, 0);
  if (visible === 0) {
    container.append(element('p', 'clean', list.emptyText));
    return;
  }
  for (const block of list.blocks) {
    renderRowBlock(container, block, selected);
  }
}

/**
 * A history row: the buffer's own string, already split into painted segments. The graph
 * is a character grid, so the row keeps its spacing (`pre-wrap`) and its own font.
 */
function renderLogRow(row: LogRowModel, selected: Set<string>): HTMLLIElement {
  const item = element('li', selected.has(row.id) ? 'row log-row selected' : 'row log-row');
  item.dataset.id = row.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', selected.has(row.id) ? 'true' : 'false');
  const line = element('span', 'log-line');
  // The row is one string, so its wrap point cannot be a second element: the hanging
  // indent is told the subject column and does the rest (see `.log-line` in the style
  // sheet), which keeps a long subject under the subject column instead of under the graph.
  line.style.setProperty('--subject-column', String(row.subjectColumn ?? 0));
  for (const segment of row.segments) {
    line.append(element('span', `log-segment role-${segment.role}`, segment.text));
  }
  item.append(line);
  return item;
}

/**
 * The `## filters` block: one input per field, laid out in a row above the history.
 *
 * Each input carries the buffer's field label as its placeholder — `message`, `author`,
 * `code (-S)` — so the row stays one line of compact fields instead of a label with a
 * box under it. `Enter` asks the host for that field, and `/` puts the caret in the
 * first one.
 */
function renderLogFilters(history: LogModel): HTMLElement {
  const section = element('section', 'block log-filters');
  section.append(blockTitle(history.filterTitle, undefined, 'section'));
  const form = element('form', 'filter-inputs');
  // The inputs apply themselves; a submit would reload the panel.
  form.addEventListener('submit', (event) => event.preventDefault());
  for (const row of history.filters) {
    const input = element('input', row.filled ? 'filter-input filled' : 'filter-input');
    input.type = 'text';
    input.id = `filter-${row.field}`;
    input.dataset.field = row.field;
    input.value = row.value;
    // The name of the field is the placeholder: no second line of labels. A set field
    // hides its name behind its value, so the name stays a tooltip too.
    input.placeholder = row.label;
    input.title = row.label;
    input.setAttribute('aria-label', row.label);
    input.autocomplete = 'off';
    input.spellcheck = false;
    // `change` fires on Enter and on leaving the field, which is exactly when a value
    // is ready to be asked for; typing never touches the history until then.
    input.addEventListener('change', () => submitFilter(input));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitFilter(input);
        return;
      }
      if (event.key === 'Escape') {
        // Back to what the history is actually filtered by; the model is the truth.
        event.preventDefault();
        input.value = row.value;
        input.blur();
      }
    });
    form.append(input);
  }
  section.append(form);
  return section;
}

/** Sends one typed filter to the host; an emptied field lifts the filter. */
function submitFilter(input: HTMLInputElement): void {
  const field = input.dataset.field;
  if (!field) {
    return;
  }
  const value = input.value.trim();
  if (value === (model?.kind === 'log' ? (model.filters.find((row) => row.field === field)?.value ?? '') : '')) {
    return;
  }
  post({ type: 'filter', field, value });
}

/** `/`: the first filter input takes focus, the place `/` walks to in the buffer. */
function focusFirstFilter(): void {
  const first = app.querySelector<HTMLInputElement>('.log-filters .filter-input');
  if (first) {
    first.focus();
    first.select();
  }
}

function renderLog(container: HTMLElement, history: LogModel): void {
  const selected = selectedSet(selection);
  container.append(renderLogFilters(history));

  const section = element('section', 'block');
  if (history.rows.length === 0) {
    section.append(element('p', 'block-empty', history.emptyText));
    container.append(section);
    return;
  }
  const list = element('ul', 'rows log-rows');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');
  for (const row of history.rows) {
    list.append(renderLogRow(row, selected));
  }
  section.append(list);
  if (history.more) {
    // The reader's marker that the history goes on: scrolling past it asks for more.
    section.append(element('p', 'log-more', history.moreText));
  }
  container.append(section);
}

/** The painted pieces of one line or one cell, in order, each with its colour role. */
function docSegments(parent: HTMLElement, segments: readonly DocSegmentModel[]): void {
  for (const segment of segments) {
    parent.append(element('span', `doc-segment role-${segment.role}`, segment.text));
  }
}

/**
 * A sub-screen: the buffer's own lines, each one already split into painted segments. A
 * patch is a character grid like the graph, so the lines keep their spacing (`pre-wrap`)
 * and their own font instead of being laid out as cells.
 */
function renderDocLine(line: DocLineModel, selected: Set<string>, group: boolean): HTMLLIElement {
  const item = element('li', selected.has(line.id) ? 'row doc-row selected' : 'row doc-row');
  item.dataset.id = line.id;
  if (group) {
    // A file list's header: a click on it takes the whole list, the way a click on a
    // status section's title takes the section.
    item.classList.add('doc-group');
  }
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', selected.has(line.id) ? 'true' : 'false');
  const text = element('span', 'doc-line');
  docSegments(text, line.segments);
  item.append(text);
  return item;
}

function renderDoc(container: HTMLElement, doc: DocModel): void {
  const selected = selectedSet(selection);
  if (doc.lines.length === 0) {
    container.append(element('p', 'clean', doc.emptyText));
    return;
  }
  const headers = new Set(doc.groups.map((group) => group.header));
  const section = element('section', 'block');
  const list = element('ul', 'rows doc-rows');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');

  for (const line of doc.lines) {
    list.append(renderDocLine(line, selected, headers.has(line.id)));
  }
  section.append(list);
  container.append(section);
}

/** The rows a header stands for, or nothing when the line is not a file list's header. */
function docGroupIds(id: string | undefined): string[] {
  if (id === undefined || model?.kind !== 'doc') {
    return [];
  }
  return model.groups.find((group) => group.header === id)?.ids ?? [];
}

function render(): void {
  // The list is rebuilt from scratch, which loses where the user had scrolled to.
  // A live refresh arrives after a save or a `git` run and must not jump the panel
  // back to the top while it is being read.
  const scrolled = window.scrollY;
  // It loses the caret too: a filter input that asked the host for a value is rebuilt
  // when the answer arrives, and typing must continue where it stopped.
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : undefined;
  const focusedField = focused?.dataset.field;
  const caret = focused?.selectionStart ?? null;
  while (app.firstChild) {
    app.removeChild(app.firstChild);
  }

  if (!model) {
    return;
  }
  const header = element('header', 'header');
  header.append(element('h1', 'title', model.title));
  renderKeys(header, model.hints);
  app.append(header);

  // The facts are the screen's preamble, not part of its header: the header is the same on
  // every screen — the screen's line with its keys beside it — and the status screen says
  // where it is looking under it, on the column's own blank line, before the rows.
  renderFacts(app, model.facts);

  if (model.kind === 'status') {
    const main = element('main', 'main');
    renderSections(main, model);
    renderColumn(main, model);
    app.append(main);
    // The bottom half is two columns: the local branches on the left, the last commits
    // on the right. The commits keep the larger share (60%), because their rows carry a
    // sha, a date, an author and a message and lose their alignment first.
    const bottom = element('div', 'bottom');
    renderRowBlock(bottom, model.branches, selectedSet(selection));
    renderCommits(bottom, model.commits, selectedSet(selection));
    app.append(bottom);
  } else if (model.kind === 'log') {
    // Filters above the history, one under the other: the history is a character grid
    // and needs the whole width, so it is not squeezed into a second column.
    const main = element('main', 'main log-main');
    renderLog(main, model);
    app.append(main);
  } else if (model.kind === 'doc') {
    const main = element('main', 'main doc-main');
    renderDoc(main, model);
    app.append(main);
  } else {
    const main = element('main', 'main');
    renderList(main, model);
    app.append(main);
  }
  // Rows get their DOM ids here, once, so every renderer that draws `.row` is covered —
  // and the caret row is announced, which is what a listbox with `aria-activedescendant`
  // needs and what `aria-selected` alone does not say.
  markRows();
  // Shorter content clamps this itself; a taller one keeps the reader where they were.
  window.scrollTo(0, scrolled);
  if (focusedField) {
    const again = app.querySelector<HTMLInputElement>(`input[data-field="${focusedField}"]`);
    if (again) {
      again.focus();
      if (caret !== null) {
        again.setSelectionRange(caret, caret);
      }
    }
  }
  // The history arrives a page at a time: a page that does not fill the panel has no
  // scrollbar to reach the end with, so ask for the next one right away.
  requestAnimationFrame(moreIfAtEnd);
}

/** Asks the host for the next page of the history when the end of this one is in sight. */
function moreIfAtEnd(): void {
  if (moreAsked || !model || model.kind !== 'log' || !model.more || model.rows.length === 0) {
    return;
  }
  const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  if (height - window.scrollY - window.innerHeight < 240) {
    moreAsked = true;
    post({ type: 'more' });
  }
}

/** The row element the pointer is on, if it is on one. */
function rowAt(target: EventTarget | null): HTMLElement | undefined {
  const found = target instanceof Element ? target.closest('.row, .column-row') : null;
  return found instanceof HTMLElement ? found : undefined;
}
// ---------------------------------------------------------------- selection

function rowIdAt(target: EventTarget | null): string | undefined {
  return rowAt(target)?.dataset.id;
}

function applySelection(next: SelectionState): void {
  selection = retain(next, order());
  save();
  for (const item of document.querySelectorAll<HTMLElement>('.row, .column-row')) {
    const selected = selection.ids.includes(item.dataset.id ?? '');
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  markActive();
}

/**
 * `aria-activedescendant`, for a listbox that keeps the focus on itself.
 *
 * The panel never moves the DOM focus to a row — the keys are handled on the document —
 * so a screen reader has no way to tell which row the arrows are on: it announces the
 * list and then nothing, however the selection moves. The ARIA answer for that shape is
 * `aria-activedescendant` on the listbox, pointing at the row that acts as the caret
 * (the selection's anchor, which is the row a click or an arrow last landed on). Rows are
 * given a slugged `id` for it, because a row id is a name (`line:3`, `src/a.ts`) and an
 * HTML id may not contain those characters.
 */
function markActive(): void {
  for (const list of app.querySelectorAll<HTMLElement>('[role="listbox"]')) {
    list.removeAttribute('aria-activedescendant');
  }
  const id = activeId(selection);
  if (id === undefined) {
    return;
  }
  const item = document.getElementById(rowDomId(id));
  const list = item?.closest('[role="listbox"]');
  if (item && list) {
    list.setAttribute('aria-activedescendant', item.id);
  }
}

/** Gives every row the DOM id `aria-activedescendant` needs, and marks the active one. */
function markRows(): void {
  for (const item of app.querySelectorAll<HTMLElement>('.row, .column-row')) {
    const id = item.dataset.id;
    if (id !== undefined) {
      item.id = rowDomId(id);
    }
  }
  markActive();
}

/** Ids of the rows drawn in one block, in model order. */
function blockIds(block: Element): string[] {
  return [...block.querySelectorAll<HTMLElement>('.row, .column-row')]
    .map((item) => item.dataset.id ?? '')
    .filter((id) => id.length > 0 && model !== undefined);
}

app.addEventListener('mousedown', (event) => {
  // A click on a block header means "this whole block", like a cursor on the header in
  // the text buffer: a file section there, the branch or tag list here.
  const header = event.target instanceof Element ? event.target.closest('.block-title') : null;
  if (header instanceof HTMLElement) {
    const block = header.closest('.block');
    const ids = block ? blockIds(block) : [];
    if (ids.length > 0) {
      event.preventDefault();
      app.focus();
      const withCtrl = event.ctrlKey || event.metaKey;
      applySelection(withCtrl ? { ids: [...new Set([...selection.ids, ...ids])], anchor: ids[0] } : { ids, anchor: ids[0] });
      return;
    }
  }

  const id = rowIdAt(event.target);
  if (!id || !model) {
    return;
  }
  // A file list's header is the whole list, exactly as a section's title is its section:
  // one click, every file, and one `d` for all of them.
  const groupHeader = event.target instanceof Element ? event.target.closest<HTMLElement>('.doc-group') : null;
  const groupIds = docGroupIds(groupHeader?.dataset.id);
  if (groupIds.length > 0) {
    event.preventDefault();
    app.focus();
    const withCtrl = event.ctrlKey || event.metaKey;
    applySelection(
      withCtrl
        ? { ids: [...new Set([...selection.ids, ...groupIds])], anchor: groupIds[0] }
        : { ids: groupIds, anchor: groupIds[0] }
    );
    return;
  }
  event.preventDefault();
  app.focus();
  const withShift = event.shiftKey;
  const withCtrl = event.ctrlKey || event.metaKey;
  if (withShift || withCtrl) {
    // A click with a modifier is a range or a toggle, not the start of a drag.
    dragAnchor = undefined;
    applySelection(click(selection, order(), id, { shift: withShift, ctrl: withCtrl }));
    return;
  }
  dragAnchor = id;
  dragging = true;
  pointerX = event.clientX;
  pointerY = event.clientY;
  applySelection(click(selection, order(), id));
  maybeAutoscroll();
});

document.addEventListener('mousemove', (event) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
  maybeAutoscroll();
});

/**
 * A drag that reaches the edge of the window scrolls the list, so a range can be grown
 * past what is on screen. The rows under the pointer arrive as it scrolls, and the
 * selection is rebuilt from the anchor to them — the same `drag()` a mouseover uses.
 */
function maybeAutoscroll(): void {
  if (scrollFrame === undefined && dragging && dragAnchor) {
    scrollFrame = requestAnimationFrame(autoscrollTick);
  }
}

function autoscrollTick(): void {
  scrollFrame = undefined;
  if (!dragging || !dragAnchor) {
    return;
  }
  const delta = autoscrollDelta(pointerY, 0, window.innerHeight);
  if (delta === 0) {
    // Back in the middle of the panel: the next mouseover grows the range, no scrolling.
    return;
  }
  const before = window.scrollY;
  window.scrollBy(0, delta);
  if (window.scrollY === before) {
    // The end of the list: scrolling further would spin without moving anything.
    return;
  }
  const under = document.elementFromPoint(pointerX, pointerY);
  const id = rowIdAt(under);
  if (id && id !== dragAnchor) {
    applySelection(drag(order(), dragAnchor, id));
  }
  maybeAutoscroll();
}

app.addEventListener('mouseover', (event) => {
  const id = rowIdAt(event.target);
  if (!dragAnchor || !id || dragAnchor === id) {
    return;
  }
  if (!(event.buttons & 1)) {
    dragAnchor = undefined;
    return;
  }
  applySelection(drag(order(), dragAnchor, id));
});

document.addEventListener('mouseup', () => {
  dragAnchor = undefined;
  dragging = false;
  if (scrollFrame !== undefined) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
  }
});

// ---------------------------------------------------------------- keyboard

function openFirst(): void {
  if (selection.ids.length === 0) {
    if (model) {
      toast(model.selectFirst);
    }
    return;
  }
  post({ type: 'action', action: 'open', ids: [selection.ids[0]] });
}

function copySelection(): void {
  if (!model || selection.ids.length === 0) {
    return;
  }
  const wanted = new Set(selection.ids);
  // The status screen copies file paths, the buffers' habit; a branch row copies the
  // branch's name and a commit row its short sha and subject. A list screen copies the
  // name of what is selected — a branch, a tag, a key.
  const texts =
    model.kind === 'status'
      ? [
          ...model.sections
            .flatMap((section) => section.rows)
            .filter((row) => wanted.has(row.id))
            .map((row) => row.path),
          ...model.branches.rows.filter((row) => wanted.has(row.id)).map((row) => row.text),
          ...model.commits.rows
            .filter((row) => wanted.has(row.id))
            .map((row) => `${row.sha} ${row.subject}`),
        ]
      : model.kind === 'log'
        ? model.rows
            .filter((row) => wanted.has(row.id))
            .map((row) => row.segments.map((segment) => segment.text).join(''))
        : model.kind === 'doc'
          ? model.lines.filter((line) => wanted.has(line.id)).map((line) => line.text)
          : model.blocks
            .flatMap((block) => block.rows)
            .filter((row) => wanted.has(row.id))
            .map((row) => row.text);
  void navigator.clipboard?.writeText(texts.join('\n')).catch(() => undefined);
}

/** Runs one resolved command; the status screen and the list screens share the plumbing. */
function handle(resolved: Exclude<KeyCommand, { kind: 'action' }>, event: KeyboardEvent): void {
  switch (resolved.kind) {
    case 'opener':
      event.preventDefault();
      post({ type: 'command', command: resolved.command });
      return;
    case 'open':
      event.preventDefault();
      openFirst();
      return;
    case 'selectAll':
      event.preventDefault();
      applySelection(selectAll(order()));
      return;
    case 'copy':
      event.preventDefault();
      copySelection();
      return;
    case 'clear':
      applySelection(clear());
      return;
    case 'bufferOnly':
      event.preventDefault();
      if (model) {
        toast(model.kind === 'status' ? model.notImplemented : model.selectFirst);
      }
      return;
    case 'move': {
      event.preventDefault();
      const ids = order();
      const currentIndex = selection.anchor ? ids.indexOf(selection.anchor) : -1;
      const nextIndex = resolved.direction === 'down' ? currentIndex + 1 : currentIndex - 1;
      if (ids[nextIndex] !== undefined) {
        applySelection(click(selection, ids, ids[nextIndex], { shift: resolved.extend }));
        // The caret walks off the screen in the buffer too, and the buffer scrolls after
        // it: the row that just became active is brought into view, not further.
        document.getElementById(rowDomId(ids[nextIndex]))?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    default:
      return;
  }
}

document.addEventListener('keydown', (event) => {
  // Matched by physical key (event.code), so the layout — Cyrillic included — does
  // not matter. See src/webview/keys.ts.
  //
  // A filter input owns the keyboard while it has focus: `s`, `c` and the rest are
  // letters being typed there, `Tab` moves to the next field, and the input's own
  // listeners handle `Enter` and `Escape`.
  if (event.target instanceof HTMLInputElement) {
    return;
  }
  //
  // `Tab` is the carousel: the next screen *in this tab*, `Shift+Tab` the previous one —
  // the host closes the screen you leave, so no tab is added. It cannot be a manifest
  // keybinding — from inside the panel the keymap does not fire — and it must not steal
  // `Ctrl+Tab`/`Alt+Tab`, which belong to VS Code.
  if (event.code === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (model) {
      event.preventDefault();
      post({ type: 'cycle', direction: event.shiftKey ? -1 : 1 });
    }
    return;
  }
  // The status screen keeps its own map. A list screen asks its table first, so `t`
  // creates a tag there instead of tagging HEAD, and falls back to the keys every
  // panel has: movement, selection, copy and the screen openers.
  if (!model || model.kind === 'status') {
    const resolved = resolveStatusKey(selection.ids[0], event);
    if (!resolved) {
      return;
    }
    if (resolved.kind === 'action') {
      event.preventDefault();
      send(resolved.action);
      return;
    }
    handle(resolved, event);
    return;
  }

  // A sub-screen is a document: its keys are the manifest's bindings for that view, so
  // a patch stages with s and a conflict takes our side with o, as in the buffer.
  const screen = model.kind === 'doc' ? resolveDocKey(model.screen, event) : resolveScreenKey(model.kind, event);
  if (screen) {
    event.preventDefault();
    // `/` is navigation in the history screen, as it is in the buffer: it walks to the
    // filters. There they are inputs, so it puts the caret in the first one.
    if (screen === 'filters' && model.kind === 'log') {
      focusFirstFilter();
      return;
    }
    sendScreen(screen);
    return;
  }
  const common = resolveCommonKey(event);
  if (common) {
    handle(common, event);
  }
});

// ---------------------------------------------------------------- host messages

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === 'model') {
    model = message.model;
    // A page that just arrived has no request outstanding any more.
    moreAsked = false;
    selection = retain(selection, order());
    render();
    return;
  }
  if (message.type === 'notice') {
    toast(message.text, message.level);
  }
});

// Scrolling to the end of the history is the reader's request for the page behind it.
window.addEventListener('scroll', moreIfAtEnd);

const saved = api.getState() as { selection?: SelectionState } | undefined;
if (saved?.selection) {
  selection = saved.selection;
}
post({ type: 'ready' });
