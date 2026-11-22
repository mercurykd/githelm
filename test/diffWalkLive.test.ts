import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createTempRepo } from './helpers/tempRepo';
import type { TempRepo } from './helpers/tempRepo';

/**
 * The walk driven the way VS Code drives it: a stub `vscode` module, a tab per test, and
 * the context keys read back the way the manifest reads them.
 *
 * The host half cannot be imported in a Node test otherwise — it asks `vscode` for the
 * active tab — so the module is patched in and the compiled `createDiffWalk` is loaded
 * afterwards. Everything below the API (git, the chains, the pair shapes) is the real
 * thing, run against a temporary repository.
 */

interface FakeUri {
  scheme: string;
  fsPath: string;
  path: string;
  query: string;
  toString: () => string;
}

class Uri implements FakeUri {
  scheme: string;
  fsPath: string;
  path: string;
  query = '';

  constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
  }

  static file(filePath: string): Uri {
    return new Uri('file', filePath);
  }

  static from(components: { scheme: string; path?: string; query?: string }): Uri {
    const uri = new Uri(components.scheme, components.path ?? '');
    uri.query = components.query ?? '';
    return uri;
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, [base.fsPath, ...parts].join('/'));
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

class TabInputText {
  constructor(readonly uri: FakeUri) {}
}

class TabInputWebview {
  constructor(readonly viewType: string) {}
}

class TabInputTextDiff {
  constructor(readonly original: FakeUri, readonly modified: FakeUri) {}
}

/** A tab as the extension host hands one over: a label, and an input that may be opaque. */
interface FakeTab {
  label: string;
  input: unknown;
}

interface FakeHost {
  tab: FakeTab | undefined;
  contexts: Map<string, unknown>;
  opened: Array<{ command: string; args: unknown[] }>;
  closed: FakeTab[];
}

const host: FakeHost = { tab: undefined, contexts: new Map(), opened: [], closed: [] };

const resetHost = (): void => {
  host.tab = undefined;
  host.contexts.clear();
  host.opened.length = 0;
  host.closed.length = 0;
};

const stub = {
  Uri,
  TabInputText,
  TabInputTextDiff,
  TabInputWebview,
  Selection: class {
    constructor(..._args: number[]) {}
  },
  Range: class {
    constructor(..._args: unknown[]) {}
  },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  ViewColumn: { Active: -1 },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]): Promise<unknown> => {
      if (command === 'setContext') {
        host.contexts.set(String(args[0]), args[1]);
        return undefined;
      }
      host.opened.push({ command, args });
      if (command === 'vscode.diff') {
        // The workbench opens `vscode.diff(original, modified, title)` as one tab.
        host.tab = { label: String(args[2]), input: new TabInputTextDiff(args[0] as FakeUri, args[1] as FakeUri) };
      }
      if (command === 'vscode.changes') {
        // `vscode.changes(title, [[resource, original, modified], ...])`: a multi-diff tab,
        // whose pairs the host reports back under `textDiffs` (`diffEditors` in newer ones).
        const list = args[1] as Array<[FakeUri, FakeUri, FakeUri]>;
        host.tab = {
          label: `${String(args[0])} (${list.length} files)`,
          input: {
            textDiffs: list.map((row) => new TabInputTextDiff(row[1], row[2])),
          },
        };
      }
      return undefined;
    },
  },
  env: { language: 'en' },
  window: {
    activeTextEditor: undefined,
    tabGroups: {
      get activeTabGroup() {
        return { activeTab: host.tab };
      },
      close: async (tab: FakeTab): Promise<void> => {
        host.closed.push(tab);
      },
      onDidChangeTabs: () => ({ dispose: () => undefined }),
      onDidChangeTabGroups: () => ({ dispose: () => undefined }),
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openTextDocument: async () => ({ uri: Uri.file('') }),
    showTextDocument: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
};

type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const loader = Module as unknown as Loader;
const loadModule = loader._load;

let loaded: { createDiffWalk: (options: { notice: (text: string) => void }) => DiffWalk } | undefined;

const load = (): { createDiffWalk: (options: { notice: (text: string) => void }) => DiffWalk } => {
  if (loaded !== undefined) {
    return loaded;
  }
  // `vscode` only exists inside an extension host, and the compiled module asks for it at
  // load, so the request is answered here and the real loader does everything else.
  loader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    return request === 'vscode' ? stub : loadModule.call(this, request, parent, isMain);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require('../src/views/diffWalk') as typeof loaded;
  } finally {
    loader._load = loadModule;
  }
  return loaded as NonNullable<typeof loaded>;
};

interface DiffWalk {
  run(step: 'older' | 'newer'): Promise<void>;
  sync(): Promise<void>;
}

/** The `git:` URI the panel builds for one side of a revision diff. */
const revisionUri = (repoPath: string, filePath: string, ref: string): Uri => {
  const file = Uri.file(path.join(repoPath, filePath));
  return Uri.from({
    scheme: 'git',
    path: file.path,
    query: JSON.stringify({ path: file.fsPath, ref }),
  });
};

/** Three commits, so a step never lands on the root (which opens files, not a diff). */
const threeCommits = (): TempRepo =>
  createTempRepo({ commits: [{ 'a.txt': 'one' }, { 'a.txt': 'two' }, { 'a.txt': 'three' }] });

/** A multi-diff tab of one commit against its parent, named the way VS Code names it. */
const multiDiffTab = (repo: TempRepo, label: string): FakeTab => {
  const sha = repo.git('rev-parse', 'HEAD').trim();
  const parent = repo.git('rev-parse', 'HEAD^').trim();
  return {
    label,
    input: {
      textDiffs: [new TabInputTextDiff(revisionUri(repo.dir, 'a.txt', parent), revisionUri(repo.dir, 'a.txt', sha))],
    },
  };
};

/** The same, for any list of files, so a tab can say "this commit changed three files". */
const multiDiffTabFor = (repo: TempRepo, files: readonly string[], label: string): FakeTab => {
  const sha = repo.git('rev-parse', 'HEAD').trim();
  const parent = repo.git('rev-parse', 'HEAD^').trim();
  return {
    label,
    input: {
      textDiffs: files.map(
        (file) => new TabInputTextDiff(revisionUri(repo.dir, file, parent), revisionUri(repo.dir, file, sha))
      ),
    },
  };
};

const key = (name: string): unknown => host.contexts.get(name);

describe('the walk as the host drives it', () => {
  after(() => {
    loader._load = loadModule;
  });

  it('sees a multi-diff whose pairs are under `textDiffs`, the installed host’s name', async () => {
    const repo = threeCommits();
    try {
      const { createDiffWalk } = load();
      resetHost();
      host.tab = multiDiffTab(repo, '0123abcd — 1 (1 file)');
      const walk = createDiffWalk({ notice: () => undefined });

      await walk.sync();

      assert.equal(key('githelm.diffWalk'), true, 'a multi-diff is a walkable tab');
      assert.equal(key('githelm.diffPrev'), true, 'the first commit has a parent');
      assert.equal(key('githelm.diffNext'), false, 'nothing is newer than the commit it shows');
    } finally {
      repo.dispose();
    }
  });

  it('sees the same tab when a newer host calls the pairs `diffEditors`', async () => {
    const repo = threeCommits();
    try {
      const { createDiffWalk } = load();
      resetHost();
      const sha = repo.git('rev-parse', 'HEAD').trim();
      const parent = repo.git('rev-parse', 'HEAD^').trim();
      host.tab = {
        label: '0123abcd — 1 (1 file)',
        input: {
          diffEditors: [new TabInputTextDiff(revisionUri(repo.dir, 'a.txt', parent), revisionUri(repo.dir, 'a.txt', sha))],
        },
      };
      const walk = createDiffWalk({ notice: () => undefined });

      await walk.sync();

      assert.equal(key('githelm.diffWalk'), true);
    } finally {
      repo.dispose();
    }
  });

  it('steps to the previous commit’s diff, and closes the tab it replaced', async () => {
    const repo = threeCommits();
    try {
      const { createDiffWalk } = load();
      resetHost();
      const tab = multiDiffTab(repo, '0123abcd — 1 (1 file)');
      host.tab = tab;
      const walk = createDiffWalk({ notice: () => undefined });
      await walk.sync();

      const parent = repo.git('rev-parse', 'HEAD^').trim();
      const grandParent = repo.git('rev-parse', 'HEAD^^').trim();
      await walk.run('older');

      const opened = host.opened.at(-1);
      assert.ok(opened, 'a step opens a tab');
      assert.equal(opened.command, 'vscode.diff');
      // The pair opened is the neighbouring commit against its first parent, as a `git:`
      // diff of the one file — the same pair the commit screen opens.
      const [left, right] = opened.args as [FakeUri, FakeUri];
      assert.deepEqual(JSON.parse(left.query), {
        path: path.join(repo.dir, 'a.txt'),
        ref: grandParent,
      });
      assert.deepEqual(JSON.parse(right.query), {
        path: path.join(repo.dir, 'a.txt'),
        ref: parent,
      });
      assert.deepEqual(host.closed, [tab], 'the diff it replaced is closed');
      // The new tab is a single-file diff, which describes itself: the arrows stay on.
      assert.equal(key('githelm.diffWalk'), true);
      assert.equal(key('githelm.diffNext'), true, 'there is a commit to come back to');
    } finally {
      repo.dispose();
    }
  });

  it('walks forward again into the commit it came from', async () => {
    const repo = threeCommits();
    try {
      const { createDiffWalk } = load();
      resetHost();
      const sha = repo.git('rev-parse', 'HEAD').trim();
      host.tab = multiDiffTab(repo, '0123abcd — 1 (1 file)');
      const walk = createDiffWalk({ notice: () => undefined });
      await walk.sync();
      await walk.run('older');

      await walk.run('newer');

      const opened = host.opened.at(-1);
      assert.ok(opened);
      assert.equal(opened.command, 'vscode.diff');
      const [, right] = opened.args as [FakeUri, FakeUri];
      assert.deepEqual(JSON.parse(right.query), { path: path.join(repo.dir, 'a.txt'), ref: sha });
    } finally {
      repo.dispose();
    }
  });

  it('leaves a webview alone, however its label reads', async () => {
    const repo = threeCommits();
    try {
      const { createDiffWalk } = load();
      resetHost();
      // A commit screen is a webview titled `<sha8> — <subject>`, which a multi-diff of
      // `<sha8> — <count>` reads like. It must never be taken for one: a step would close
      // the screen.
      host.tab = { label: '0123abcd — 1', input: new TabInputWebview('githelm.webview.commit') };
      const walk = createDiffWalk({ notice: () => undefined });

      await walk.sync();

      assert.equal(key('githelm.diffWalk'), false);
    } finally {
      repo.dispose();
    }
  });

  it('leaves a text tab alone, however its label reads', async () => {
    const repo = threeCommits();
    try {
      const { createDiffWalk } = load();
      resetHost();
      host.tab = { label: '0123abcd — 1 (1 file)', input: new TabInputText(Uri.file(path.join(repo.dir, 'a.txt'))) };
      const walk = createDiffWalk({ notice: () => undefined });

      await walk.sync();

      assert.equal(key('githelm.diffWalk'), false);
    } finally {
      repo.dispose();
    }
  });

  it('keeps walking commits when a step lands on a commit that changed one file', async () => {
    // The question this answers: a walk that started on a three-file diff steps back onto a
    // commit whose whole change is one file — does it carry on through the commits, or does
    // it quietly become that one file's history? It stays on the commits: the rule is fixed
    // when the walk starts and the tab is opened under it.
    const repo = createTempRepo({
      commits: [
        { 'b.txt': 'zero', 'c.txt': 'zero' },
        { 'b.txt': 'one', 'c.txt': 'one' },
        { 'a.txt': 'two' },
        { 'a.txt': 'three', 'b.txt': 'three', 'c.txt': 'three' },
      ],
    });
    try {
      const { createDiffWalk } = load();
      resetHost();
      host.tab = multiDiffTabFor(repo, ['a.txt', 'b.txt', 'c.txt'], '0123abcd — 3 (3 files)');
      const walk = createDiffWalk({ notice: () => undefined });
      await walk.sync();
      assert.equal(key('githelm.diffWalk'), true);

      const oneFile = repo.git('rev-parse', 'HEAD^').trim();
      const older = repo.git('rev-parse', 'HEAD^^').trim();
      const root = repo.git('rev-list', '--max-parents=0', 'HEAD').trim();
      await walk.run('older');

      // The step itself shows only the file that commit changed, under the commit pair.
      const first = host.opened.at(-1);
      assert.ok(first);
      assert.equal(first.command, 'vscode.diff');
      const [, right] = first.args as [FakeUri, FakeUri];
      assert.deepEqual(JSON.parse(right.query), { path: path.join(repo.dir, 'a.txt'), ref: oneFile });
      // Named after the commit, as every other step of this walk is: "<sha> — 1" says "this
      // commit, one file", where the pair title would say "this file, two revisions".
      assert.equal(first.args[2], `${oneFile.slice(0, 8)} — 1`, 'the tab names the commit it shows');
      assert.equal(key('githelm.diffPrev'), true, 'the repository chain still has a commit behind it');

      // `a.txt` itself has no earlier change than this one, so a file walk would stop here.
      // The commit before it changed two other files: that is the step that must open.
      await walk.run('older');

      const second = host.opened.at(-1);
      assert.ok(second);
      assert.equal(second.command, 'vscode.changes', 'a commit-wide diff of the two files it changed');
      const rows = second.args[1] as Array<[FakeUri, FakeUri, FakeUri]>;
      assert.equal(rows.length, 2);
      assert.deepEqual(JSON.parse(rows[0][1].query), {
        path: path.join(repo.dir, 'b.txt'),
        ref: root,
      });
      assert.deepEqual(JSON.parse(rows[0][2].query), {
        path: path.join(repo.dir, 'b.txt'),
        ref: older,
      });
      assert.equal(second.args[0], `${older.slice(0, 8)} — 2`, 'the tab names the commit it now shows');
    } finally {
      repo.dispose();
    }
  });

  it('and keeps a file walk on that file, however many files a step commits', async () => {
    const repo = createTempRepo({
      commits: [{ 'a.txt': 'one' }, { 'a.txt': 'two' }, { 'a.txt': 'three', 'b.txt': 'three' }],
    });
    try {
      const { createDiffWalk } = load();
      resetHost();
      const sha = repo.git('rev-parse', 'HEAD').trim();
      const parent = repo.git('rev-parse', 'HEAD^').trim();
      host.tab = {
        label: 'a.txt (0123abcd) ↔ a.txt (4567cdef)',
        input: new TabInputTextDiff(revisionUri(repo.dir, 'a.txt', parent), revisionUri(repo.dir, 'a.txt', sha)),
      };
      const walk = createDiffWalk({ notice: () => undefined });
      await walk.sync();

      await walk.run('older');

      // Started on one file, so every step is that file — not the whole commit, though the
      // commit before this one also touched `b.txt`.
      const opened = host.opened.at(-1);
      assert.ok(opened);
      assert.equal(opened.command, 'vscode.diff');
      const [left, right] = opened.args as [FakeUri, FakeUri];
      assert.deepEqual(JSON.parse(left.query), { path: path.join(repo.dir, 'a.txt'), ref: repo.git('rev-parse', 'HEAD^^').trim() });
      assert.deepEqual(JSON.parse(right.query), { path: path.join(repo.dir, 'a.txt'), ref: parent });
      // A file walk names its tab after the pair, not after a commit: it is one file.
      assert.match(String(opened.args[2]), /^a\.txt \(.+\) ↔ a\.txt \(.+\)$/);
    } finally {
      repo.dispose();
    }
  });

  it('has no walk for a pair that is not a commit and its parent', async () => {
    const repo = threeCommits();
    try {
      const { createDiffWalk } = load();
      resetHost();
      const head = repo.git('rev-parse', 'HEAD').trim();
      const root = repo.git('rev-list', '--max-parents=0', 'HEAD').trim();
      // A compare range: the left side is not the right side's first parent.
      host.tab = {
        label: 'main..main~2 (1 file)',
        input: {
          textDiffs: [new TabInputTextDiff(revisionUri(repo.dir, 'a.txt', root), revisionUri(repo.dir, 'a.txt', head))],
        },
      };
      const walk = createDiffWalk({ notice: () => undefined });

      await walk.sync();

      assert.equal(key('githelm.diffWalk'), false);
    } finally {
      repo.dispose();
    }
  });
});
