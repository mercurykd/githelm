/**
 * Wire format between the extension host and the status webview.
 *
 * The host owns git and the translations; the webview owns layout, selection and
 * keys. Nothing here imports `vscode`, so both sides can share it and the tests can
 * import it directly.
 */

export type SectionKind = 'staged' | 'unstaged' | 'untracked' | 'conflict';

/**
 * The name of the colour a piece of text takes: the decoration kind the text
 * buffer would use for the very same text. The client turns it into a
 * `role-<name>` class, so the panel and the buffer are painted from one table.
 */
export type ColorRole =
  | 'section'
  | 'staged'
  | 'unstaged'
  | 'untracked'
  | 'conflict'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'meta'
  /** A hint line's text, painted like the buffers paint it. */
  | 'help'
  | 'hash'
  | 'date'
  | 'author'
  | 'refs'
  | 'branch'
  | 'upstream'
  | 'remotes'
  | 'worktrees'
  | 'hunk'
  /** The lines of `git log --graph`, which the buffer paints with `githelm.graph`. */
  | 'graph'
  /** A file path outside a section, and the hairline under a block: the buffer's own names. */
  | 'path'
  | 'rule'
  /** Not painted at all: the buffer leaves the text in the editor foreground. */
  | 'plain';

/** One file row of a section. */
export interface RowModel {
  /** Stable across refreshes: `<section>:<path>`, so the selection survives a reload. */
  id: string;
  section: SectionKind;
  path: string;
  /** Raw porcelain code, e.g. ` M`, `M `, `??`, `UU`. */
  xy: string;
  /** The same code trimmed for display: `M`, `??`, `UU`. */
  code: string;
  /** Colour of the code cell: the status letter, as the buffer's `xyKind()`. */
  codeRole: ColorRole;
  /** Colour of the path: the section, as the buffer's `sectionRole()`. */
  pathRole: ColorRole;
  /** Where a rename came from. */
  origPath?: string;
}

export interface HintModel {
  /** The literal key text, e.g. `alt+s`. */
  keys: string;
  label: string;
}

export interface SectionModel {
  kind: SectionKind;
  title: string;
  /** The keys of the block, as the text buffer prints them under its header. */
  hints: HintModel[];
  rows: RowModel[];
}

/** A row of a right-hand block; `inline` keeps the detail on the same line. */
export interface ColumnRowModel {
  id: string;
  text: string;
  /** Colour of `text`: the buffer paints remote, worktree and stash names as branches. */
  mainRole: ColorRole;
  detail?: string;
  /** Colour of `detail`; the buffer leaves a URL, a path and a stash subject unpainted. */
  detailRole?: ColorRole;
  inline?: boolean;
}

export interface ColumnBlockModel {
  title: string;
  /** Title colour: `remotes` for the worktree block too, `section` for the stash. */
  role: ColorRole;
  hints: HintModel[];
  rows: ColumnRowModel[];
  empty: string;
}

export interface CommitRowModel {
  sha: string;
  date: string;
  author: string;
  /** The refs pointing at the commit, as `[HEAD -> main tag: v0.0.4]`; empty when none. */
  refs: string;
  subject: string;
}

export interface CommitsBlockModel {
  title: string;
  hints: HintModel[];
  rows: CommitRowModel[];
}

/** A `LABEL: value` pair of the header. */
export interface FactPart {
  text: string;
  role: ColorRole;
  /** Spaces before the part: `2` after the value, `1` between two counters. */
  gap: 1 | 2;
}

export interface FactModel {
  label: string;
  value: string;
  /** Colour of the value, as the buffer paints the matching span. */
  role: ColorRole;
  /**
   * The rest of the value, painted piece by piece: a divergence, a head subject, a
   * remote URL. The buffer splits these the same way, so the panel does too.
   */
  parts?: FactPart[];
  /** Set for values that should read as secondary, such as `(no commits yet)`. */
  muted?: boolean;
}

export interface StatusModel {
  kind: 'status';
  title: string;
  facts: FactModel[];
  sections: SectionModel[];
  column: ColumnBlockModel[];
  commits: CommitsBlockModel;
  hints: HintModel[];
  /** Shown instead of the file list when nothing is staged, changed or untracked. */
  cleanText: string;
  /** Shown when a key needs rows and nothing is selected. */
  selectFirst: string;
  /** Shown when a key belongs to the text buffer, not to this panel yet. */
  notImplemented: string;
}

/** The screens that have a panel implementation. */
export type ScreenKind = 'status' | 'log' | 'branches' | 'tags' | 'submodules' | 'actionlog';

/** One painted piece of a row, after the row's main text. */
export interface RowPartModel {
  text: string;
  role: ColorRole;
  /** Spaces before the part, the way the buffer pads its columns. */
  gap?: 1 | 2;
}

/** A row of a screen that is a list of things rather than of files. */
export interface RowItemModel {
  /** Stable across refreshes, so the selection survives a reload. */
  id: string;
  text: string;
  role: ColorRole;
  /** A marker in front of the text, like the `*` of the current branch. */
  marker?: string;
  markerRole?: ColorRole;
  /** The rest of the row, painted piece by piece, as the buffer pads its columns. */
  parts?: RowPartModel[];
  /** A second line under the row: a branch's subject, a tag's annotation. */
  note?: string;
  noteRole?: ColorRole;
  /**
   * The row is a table row: its parts carry the buffer's column padding, so the columns
   * line up down the screen instead of being spaced one character apart.
   */
  aligned?: boolean;
}

export interface RowBlockModel {
  title: string;
  role: ColorRole;
  hints: HintModel[];
  rows: RowItemModel[];
  /** Shown instead of the rows when the block is empty. */
  empty?: string;
}

/** A screen made of lists: branches and tags. */
export interface ListModel {
  kind: 'branches' | 'tags' | 'submodules' | 'actionlog';
  title: string;
  facts: FactModel[];
  hints: HintModel[];
  blocks: RowBlockModel[];
  /** Shown when a key needs a row and nothing is selected. */
  selectFirst: string;
  /** Shown instead of the list when it has no rows at all. */
  emptyText: string;
}

/** One painted piece of a history row; the space between two pieces is `plain`. */
export interface LogSegmentModel {
  text: string;
  role: ColorRole;
}

/**
 * A row of `git log --graph`. The segments are the buffer's own spans of the buffer's own
 * string, so the graph, the columns and the colours are the ones the text buffer draws —
 * the panel only lays the row out again.
 */
export interface LogRowModel {
  /** `commit:<sha>` for a commit, `row:<n>` for a line of the graph without one. */
  id: string;
  segments: LogSegmentModel[];
  /** The commit under the row; a pure graph line (`|\`, `|/`) has none. */
  commit?: { sha: string; shortSha: string; refs: string[] };
  /**
   * Column where the subject starts: a subject too long for the panel wraps under this
   * column instead of under the graph, which is what a hanging indent of this width does.
   */
  subjectColumn?: number;
}

/** One field of the `## filters` block: the field's name, its value and its hint. */
export interface LogFilterRowModel {
  /** `field:<name>`, the id the field has everywhere else in the panel. */
  id: string;
  /** The field name, which is what a value typed into the input belongs to. */
  field: string;
  /** The buffer's label for the field — `message`, `code (-S)` — and the input's placeholder. */
  label: string;
  /** The value that is set, empty when the field is not filtering anything. */
  value: string;
  /** The value is set: the buffer paints it as a hunk, an empty field as muted text. */
  filled: boolean;
}

/** The history screen: the graph rows of `git log --graph` as a character grid. */
export interface LogModel {
  kind: 'log';
  title: string;
  facts: FactModel[];
  hints: HintModel[];
  filterTitle: string;
  filters: LogFilterRowModel[];
  rows: LogRowModel[];
  selectFirst: string;
  /** Shown instead of the rows when the repository has no commits yet. */
  emptyText: string;
  /** More commits than the limit were found: scrolling to the end asks for them. */
  more: boolean;
  /** The line under the last row while `more` is set. */
  moreText: string;
}

/**
 * A sub-screen: a whole document rather than a list of entries — a patch, a commit's
 * metadata and files, a stash's files, a conflict, a file's history. The panel draws the document's lines the
 * way the text buffer draws them, spans and all, so the two screens read the same.
 */
export type DocKind = 'commit' | 'stash' | 'conflict' | 'file' | 'init';

/** One painted piece of a document line. Segments concatenate to the line's text. */
export interface DocSegmentModel {
  text: string;
  role: ColorRole;
}

export interface DocLineModel {
  /** `line:<n>`, 0-based: the panel's rows are the document's lines. */
  id: string;
  /** The whole line, which is what copying a row copies. */
  text: string;
  segments: DocSegmentModel[];
}

/**
 * A run of rows that a click on its header takes at once — a file list. The header is a
 * document line (`## files (3)`) and the ids are the rows of the files it lists, so
 * clicking `files` selects the whole list and one `d` diffs all of it.
 */
export interface DocGroupModel {
  /** The `line:<n>` id of the header. */
  header: string;
  /** The `line:<n>` ids of the rows it lists, in document order. */
  ids: string[];
}

export interface DocModel {
  kind: 'doc';
  /** Which sub-screen this is: it decides the keys, not the shape. */
  screen: DocKind;
  title: string;
  facts: FactModel[];
  hints: HintModel[];
  lines: DocLineModel[];
  /**
   * The runs a header stands for. Empty on a document that has no list under a header
   * (a conflict, a file's history), which is most of them.
   */
  groups: DocGroupModel[];
  /** What to say when a key needs a line under it and none is selected. */
  selectFirst: string;
  /** Shown instead of the lines when the document is empty. */
  emptyText: string;
}

export type ScreenModel = StatusModel | ListModel | LogModel | DocModel;

/**
 * Actions of the screens that are lists. The panel dispatches by the model's `kind`,
 * so one name can mean the same thing on two screens (`remove`, `refresh`) and the
 * host routes it to the screen the key was pressed in.
 */
export type ScreenAction =
  | 'checkout'
  | 'create'
  | 'rename'
  | 'upstream'
  | 'remove'
  | 'removeRemote'
  | 'merge'
  | 'reset'
  | 'toggleRemote'
  | 'toggleAll'
  | 'show'
  | 'graph'
  | 'open'
  | 'update'
  | 'updateRemote'
  | 'move'
  | 'push'
  | 'tag'
  | 'filters'
  | 'resetFilters'
  | 'sort'
  | 'compare'
  | 'cherryPick'
  | 'revert'
  | 'fixup'
  | 'clearLog'
  | 'stage'
  | 'unstage'
  | 'openFile'
  | 'fileDiff'
  | 'filesAtRef'
  | 'ours'
  | 'theirs'
  | 'base'
  | 'mergeEditor'
  | 'resolve'
  | 'refresh'
  | 'close';

/**
 * Actions that work on the repository alone, with no row under them: the buffer
 * resolves the cursor for these only to find out *which* repository to act on. The
 * host implements each one once and both UIs call it.
 */
export type RepoAction =
  | 'amend'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'reset'
  | 'abort'
  | 'pulls'
  | 'remoteAdd'
  | 'worktreeAdd'
  | 'worktreePrune';

export type WebviewAction =
  | 'stage'
  | 'unstage'
  | 'stageAll'
  | 'unstageAll'
  | 'diff'
  | 'open'
  | 'ignore'
  | 'discard'
  | 'commit'
  | 'tag'
  | 'stash'
  | 'refresh'
  | 'close'
  | 'delete'
  | 'edit'
  | 'stashApply'
  | 'stashPop'
  | 'worktreeWindow'
  | 'worktreeHere'
  | RepoAction;

export type HostMessage =
  | { type: 'model'; model: ScreenModel }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'action'; action: WebviewAction; ids: string[] }
  /** A key of a list screen; the host routes it by the screen the panel shows. */
  | { type: 'screen'; action: ScreenAction; ids: string[] }
  /** `Tab` / `Shift+Tab`: the next or previous screen, a carousel of the panels. */
  | { type: 'cycle'; direction: 1 | -1 }
  /** The reader reached the end of the history: read the next page of commits. */
  | { type: 'more' }
  /** A filter input was submitted: `field` now holds `value` (empty clears it). */
  | { type: 'filter'; field: string; value: string }
  /** A screen opener; the host runs it only if it is on its allow-list. */
  | { type: 'command'; command: string };
