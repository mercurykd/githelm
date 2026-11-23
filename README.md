# Git Helm

**English** · [Русский](README.ru.md) · [中文](README.zh.md)

A keyboard-driven git UI for VS Code, drawn in webview panels.

Every screen is a webview panel — no trees, no mouse, and no second interface to keep in step. You open the status screen, move the cursor, and act with single keys — `s` to stage, `c` to commit, `i` to add a file to `.gitignore`. Panels stay in the editor area, so splits and the normal editor shortcuts keep working.

## What it does

![The status screen: the files on the left, `remotes` and `worktrees` in a column on the right, the commits and the recent actions below](media/demo/status.png)

*`alt+g` opens it: `s` stage, `d` diff, `c` commit, `Ctrl+S` records the commit.*

| Screen | Highlights |
| --- | --- |
| **Status** (`alt+g`) | staged / unstaged / untracked / conflicts, stage a file, a whole section or the selection, commit, amend, stash, remotes, worktrees, a local-branches block (checkout / create / merge / graph / reset), last-commit actions (open, branch, checkout, cherry-pick, revert, fixup, reset, tag), fetch/pull/push, abort merge, diff, open file |
| **Diff** | stage or unstage the hunk under the cursor or the selected lines, `Enter` opens the file at that line |
| **History** | ASCII graph, commit details, branch/checkout/cherry-pick/revert, fixup + autosquash, filters by message/author/branch/date and `git log -S` / `-G`, sort cycles, compare two commits, reset to a commit |
| **Branches** | local and remote (toggle), upstream and divergence, checkout / create / rename / delete / set-upstream / merge / reset, and `G` opens the graph of one branch |
| **Tags** | list, show the commit, create, move to `HEAD`, delete |
| **Commit** | metadata, stat and the full patch of the commit you are writing |
| **File** | `git log --follow` and `git blame` for the current file |
| **Conflict** | take ours / theirs / base per file, mark resolved, or jump into the built-in merge editor |
| **Action log** | every `git` invocation the extension made, with timing and exit code |

## Install

Requires VS Code 1.85 or newer and a `git` binary on `PATH`.

From the Marketplace: search for **Git Helm**, or

```bash
code --install-extension <publisher>.githelm
```

From a VSIX:

```bash
code --install-extension githelm-X.Y.Z.vsix
```

From source:

```bash
npm install
npm run build
```

Then either press `F5` (Extension Development Host) or install the packaged build. The launch config passes `--disable-extensions`, so installed extensions stay inactive in the dev host and an installed copy of Git Helm cannot collide with the development copy — including after you open another folder.

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension githelm-X.Y.Z.vsix --force
```

For a fast edit loop, link the working copy into VS Code instead of repackaging:

```bat
mklink /J "%USERPROFILE%\.vscode\extensions\mercurykd.githelm" "D:\path\to\githelm"
```

then `npm run build` → **Developer: Restart Extension Host**.

The folder name has to be `<publisher>.<name>`, so it matches the manifest — an older `local.githelm` folder from before the publisher was renamed is a *second* extension for VS Code, and the two fight over the same commands and schemes. Remove it: `rmdir "%USERPROFILE%\.vscode\extensions\local.githelm"`.

## Quick start

`alt+g` opens the status screen. That is the only shortcut you have to remember: from it, `g` opens history, `b` branches, `t` tags, `S` submodules, `F` pull requests, `l` the action log.

Every screen is a webview panel; there is no other interface to switch to, and no mode setting. The sub-screens are panels too — a commit, a stash's files, a conflict and a file's log — each drawn by a renderer of its own (see [docs/webview-status.md](docs/webview-status.md)). Every diff in a panel is VS Code's own diff editor — a selection opens as one multi-diff tab, and the files of a commit or a stash compare their parent against them — so there is no generated patch view anywhere. Each tab says what it compares, the way the built-in git names its own: `src/a.ts (Index)`, `src/a.ts (Working Tree)`, `src/a.ts (Untracked)`, or `src/a.ts (a1b2c3d) ↔ src/a.ts (dc3ba5e)`. Two more arrows in that editor's toolbar step the diff itself through the history — one commit back, one commit forward (`alt+[` / `alt+]`) — see [Stepping a diff through commits](#stepping-a-diff-through-commits). `Enter` on a commit opens a screen of its own: who wrote it and when, what it says, and the files it touched, with `d` onto the diff of the file under the cursor or of every file when the `## files` header is clicked. Blame is the file itself: it opens in a real editor as its own code — the same lines, highlighted by the language of that file, as wide as its longest line — with the metadata drawn *in front of* each line as a decoration: a fixed-width gutter of the sha, the author, the date and the commit's subject once per block, which the code scrolls under instead of wrapping around. Hovering a line shows the commit message in full, body and all, in VS Code's own hover box. Blame is the one screen that is not a panel, because a webview has no grammar to highlight the code with.

## Keys

Every screen is headed the same way: one line naming it — the repository, an em dash, the screen (`D:/work/app — branches`) — with the keys of that screen in a column of their own that starts at the middle of the panel, so the first key holds the same place on every screen, wrapping in that column — three lines on a full panel — and a blank line under it parts the header from the rows, with no rule between them. The header is the same shape and the same height everywhere, the status screen included: what that screen says about where it is looking stands under the header, as the first block of the column — two lines, the branch with its tracking state and `HEAD`. No screen counts its rows up there: the block heading carries the count (`## local (2)`), and the rows are the list. The hints are printed as `key label` pairs with no `keys` heading over them, and a panel narrower than 820 pixels puts them back under the title, full width, rather than squeezing the two columns.


### Status — `alt+g`

| Key | Action |
| --- | --- |
| `s` | stage: the file under the cursor · the whole section when the cursor is on a header · every file in the selection |
| `u` | unstage — the same three modes |
| `alt+s` | stage everything: the whole repository, deletions included |
| `alt+u` | unstage everything that is in the index |
| `d` | diff of the file under the cursor — a section header diffs the whole section, and every extra cursor adds its file |
| `D` | discard the row under the cursor, one layer at a time (same cursor rules as `d`, and it asks first): a **staged** row puts the index back to HEAD, an **unstaged** row restores the working tree from the index, a **new** file is deleted from disk, a **conflict** keeps the HEAD version. The same file can sit in several sections at once — each row is discarded on its own |
| `i` | add to `.gitignore`: file under the cursor · selected files · whole section on a header (tracked files are reported instead of written — they need `git rm --cached`) |
| `Enter` | open the file |
| `c` | commit: message buffer, `Ctrl+S` commits |
| `m` | amend the last commit |
| `z` | stash: with files under the cursors only those files are stashed, otherwise a list asks for `--staged` (the index alone) or `-u` (untracked files too) — at most one of them, and Enter with nothing picked stashes the working tree |
| `a` / `p` | apply / pop the stash under the cursor |
| `t` | create a tag: on the commit under the cursor when the cursor is on one of the last commits, otherwise on `HEAD` (`T` opens the tags screen) |
| `A` | add a remote (name + URL) |
| `n` | add a worktree: path, then branch / tag / commit (a missing branch is created from `HEAD`) |
| `W` | prune worktree entries whose directory is gone |
| `f` / `P` / `U` | fetch / pull / push |
| `R` | reset: one mode picker whose prompt says `Reset to HEAD` — choose soft/mixed/hard and the reset runs |
| `M` | abort the merge, revert or cherry-pick in progress — it asks first, the resolutions of the conflicts are lost |
| `x` | delete the stash / tag / remote / worktree under the cursor; every one of them asks first, and a dropped stash is gone — the list is the only place it lived |
| `e` | edit the remote URL or move the tag to `HEAD` |
| `b` | branches screen |
| `S` | submodules screen |
| `F` | open pull requests / merge requests of the remote — or open the page that creates one |
| `g` | commit history |
| `r` | refresh |
| `q` | close the panel |

The staged, unstaged and untracked sections are always on screen, even when empty: a section that disappears would move every row under it and drop the cursor on a different file. Only conflicts comes and goes, because its absence is the normal state.

The status header is `D:/work/app — status` — the path, the em dash, the screen — with the screen's key hints in their column at the middle, exactly like every other header; under it, as the first block of the column, two lines: the branch with its tracking state (`origin/main: +2 −1` — the counters that moved, a counter at zero is left out) and `HEAD`. The repository is the title's own word and the remote is a block of its own, so neither is repeated among those lines. The `remotes`, `worktrees` and `stash` blocks share one column on the right, in that order, beside the file sections: the files keep the left half, a six-column gutter separates the two halves, and one blank row separates two blocks of the column the way it does on the file side. A title of the column can share a line with a title of the file side (`## staged` beside `## remotes`); the cursor column decides which of the two a key acts on.

Every hint is one `key label` pair, and the line wraps when the panel is narrow: the header is as wide as the panel, so no key list has to be read in two places. The `remotes` block lists every remote with its URL; the "last commits" block always shows subject, author and date, with the tags and branches of a commit as the first words of its message (`[HEAD -> main tag: v0.0.4] feat: …`) — the tag is part of the message, not a column, so a long message wraps under the message column and the tags are never cut short.

The bottom of the status screen is two blocks: `## branches (n)` on the left and `## last commits (n)` on the right, the commits keeping 60% of the width. The branch block lists local branches only — the current one marked `*`, with its tracking label and the subject of its last commit. While a branch row is selected it answers to the branches screen's keys: `Enter` or `c` checks out, `n` creates a new branch from the selected one, `m` merges it into the current branch, `R` resets to it (one mode picker with prompt `Reset to <name>`), and `G` opens that branch's graph. The commit rows are selectable too and keep the history screen's keys: `Enter` opens the commit, `n` branches from it, `c` checks out its branch (or the commit itself in detached HEAD when no branch points at it), `C` cherry-picks it, `V` reverts it, `f` fixups staged changes into it, `R` resets to it and `t` tags it; `g` still opens the whole history. Everywhere else the same keys keep their status meaning (`c` commit, `m` amend, `n` add a worktree), so the row under the cursor decides and each block's hint line names that reading.

The `stash` block lists the stashes of the repository and is drawn even when there are none, because its keys (`z stash`, `enter files`, `d diff`, `a apply`, `p pop`, `x drop`) are the only place the status buffer says how to make the first one. `z` decides what to stash from the cursors: files under them go in and nothing else, so no question is asked. With the cursor on a section title the whole section goes in; with no file under the cursor a list offers `--staged` (the index alone) and `-u` (untracked files as well), at most one of the two, and Enter with nothing picked stashes the working tree. Nothing is on by default: an untracked file is stashed only when `-u` says so.

Nothing that deletes or drops happens without a question first: `D` discard, `x` delete (stash, tag, remote, worktree), `x` on the branches and tags screens, `D` on the branches screen for a remote branch, `R` hard reset, `V` revert, `M` abort, `c` clear the action log. `p` pop does not ask: it applies the stash before dropping the entry, so the changes are in the working tree either way.

The `worktrees` block lists every checkout of the repository with a `*` on the one the panel belongs to; the cursor column decides which row a key acts on. `Enter` on a row switches to that worktree (its own status buffer), `Shift+Enter` opens that folder in a new window, `Alt+Enter` reopens this window on it — it asks first, since the current folder, layout and unsaved editors are lost — `n` adds one, `x` removes the worktree under the cursor — a dirty one asks for `--force` instead of failing, and the current worktree can only be removed from another one. `W` drops entries whose directory is already gone. When the active buffer belongs to a linked worktree, the status bar names it next to the branch.

The author column is shared with the history graph: its width is the longest login plus two characters, so subjects line up across both screens instead of leaving a fixed gap.

### Diff

| Key | Action |
| --- | --- |
| `s` | stage: without a selection the **whole hunk under the cursor**, with a selection only those lines |
| `u` | unstage — same rules, in the staged diff |
| `Enter` | open the file at that line |
| `r` | refresh |
| `q` | close |

### History

![The history screen: ASCII graph, refs, author and date columns, the filter block and key hints](media/demo/log.png)

*`g` opens the graph: `Enter` commit, `/` filters, `a` all branches, `f` fixup into a commit.*

| Key | Action |
| --- | --- |
| `Enter` | open the commit screen: author, date, message, and the files it touched |
| `n` | branch from the commit |
| `t` | create a tag on the commit under the cursor — the row shows the new ref right away |
| `c` | checkout the branch of the commit — or the commit itself in detached HEAD when no branch points at it |
| `C` | cherry-pick the commit onto the current branch |
| `V` | revert the commit: a new commit that undoes it (confirm first; merge commits ask for the mainline parent; a conflict is aborted with `M` on the status screen) |
| `f` | fixup the staged changes into the commit, then autosquash |
| `R` | reset to the commit: one mode picker whose prompt says `Reset to commit <sha>` |
| `a` | toggle all branches |
| `/` | filters: message, author, branch, date range, `git log -S` / `-G` |
| `x` | clear the filters |
| `s` | cycle the sort order (topo / date / author date) |
| `d` | compare commits: one commit gives `<commit>..HEAD`, two give `A..B` or `A...B` with left/right markers — and the menu offers both directions (`B..A`) for the diff and for the history graph |
| `g` | open the graph — the key works in every screen, and the status, branches, tags, submodules and action-log screens show it in their hint lines |
| `T` | tags screen |
| `r` | refresh |

The commit screen the `Enter` opens keeps `d` for the change of every file under the selection and binds `t` to those same files as the commit left them: one read-only tab each, which is how a file is read at an old revision without checking it out.

The `branch` filter reads the history of one branch the way `git log <branch>` does, so it narrows the walk instead of joining it: it takes a local branch, `origin/main`, a tag or a sha, and it wins over `a`, whose union of every ref would put the other branches back. Typing a branch turns `a` off, and pressing `a` with a branch set lifts the filter and turns every ref on — the last of the two asked for is the walk, so the title never claims `all branches` for a history `git log` was given one branch of. A name that resolves to nothing is answered with a notice — the input returns to the filter that is still set — rather than a page of `fatal: ambiguous argument`. Comparing a range clears the branch, because the range is then the walk.

### Branches

| Key | Action |
| --- | --- |
| `c` (or `Enter`) | checkout — one command, two keys; the hint line names `c`, so the same action is not listed twice |
| `n` | create |
| `e` | rename |
| `u` | set upstream |
| `x` | delete |
| `D` | delete a remote branch |
| `m` | merge into the current branch |
| `d` | compare — one branch against `HEAD`, two against each other; `diff …` opens the patch, `log …` the graph of the range |
| `R` | reset the branch: one mode picker whose prompt says `Reset to <name>` |
| `a` | toggle local/remote branches |
| `g` | open the graph |
| `G` | the graph of the branch under the cursor: the history screen opens with its `branch` filter already set to that branch — local, remote, a tag or a sha, the same field and the same `git log <branch>` behind it |
| `T` | tags screen |
| `r` | refresh |

`G` is the bigger variant of the graph key, as the capital letters are on every screen: `g` opens the history of everything, `G` opens the same screen asked about one branch. Nothing is copied into a second view — the panel hands the branch name to the `branch` filter it already has, so the reader lands on a history `git log <branch>` produced, can read a commit, and clears the field to widen the walk. The row may be a remote branch (`origin/main`) or a tag; the name is what `git rev-parse` resolves, exactly as when it is typed into the field.

### Tags

| Key | Action |
| --- | --- |
| `Enter` | show the tagged commit |
| `t` | create a tag on `HEAD`; a message makes it annotated — the same key as on the status screen and in the graph |
| `e` | move the tag to `HEAD` |
| `x` | delete |
| `D` | delete the tag on the remote — the local tag stays |
| `U` | push the tag to the remote |
| `g` | open the graph |
| `r` | refresh |

A tag update is never a fast-forward, so pushing a tag is always a forced update — and the force is *leased*: `U` first asks the remote what the tag points at there and sends that value as the expected one, so a tag somebody else moved in the meantime is refused instead of overwritten. A tag the remote does not have yet is pushed without any force.

A row is the commit row of the history screen with the tag name standing where the graph goes: name, short sha, date, author, subject, in the same columns and with the same colours. An annotated tag shows its own message in a column of its own right after the name, and the commit subject stays at the end of the row. The rows follow the header directly: the title, the key hints, the rule and one blank line, and then the list. A lightweight tag has no message, so that column stays empty.

### Submodules — `S`

| Key | Action |
| --- | --- |
| `Enter` | open the submodule as its own repository: it gets its own status screen, where its changes are staged, diffed and committed |
| `u` | check the submodule out at the commit the parent records (`git submodule update --init`) |
| `U` | move it to the head of the branch configured in `.gitmodules` (`git submodule update --init --remote`) |
| `g` | open the graph |
| `T` | tags screen |
| `r` | refresh |

Each row carries the same marker `git submodule status` prints: a space when the checkout matches the recorded commit, `+` when it sits on a different commit, `-` when it is not initialized, `U` on a conflict. The screen lists nested submodules too, and the status buffer marks every gitlink row with `sub` (`sub+` when the checkout moved), so a submodule change is not mistaken for an ordinary file.

### Pull requests — `F`

`F` lists the open pull requests (GitHub) or merge requests (GitLab) of the remote and opens the one you pick in the browser; the first item opens the page that creates a new one. The remote URL alone decides the forge: `git@github.com:owner/repo.git`, `ssh://…`, `https://…`, GitLab subgroups (`group/sub/project`) all work, and `githelm.forge.kind` names the forge when a self-hosted host has a neutral name.

Listing needs a token, because the API does — a fine-grained GitHub token with `Pull requests: read`, or a GitLab token with `read_api`; set it in the settings or in `GITHUB_TOKEN` / `GITLAB_TOKEN`. Without a token `F` says so and offers to open the settings instead of failing silently. Creating a request needs no token at all: that page opens in the browser, where you are already signed in. The base branch is whatever `origin/HEAD` points at, `main` when git has no such ref.

### Git LFS

LFS keeps big blobs on its own server and commits a small pointer file instead. The status screen tags such rows with `lfs`, and a diff that contains a pointer starts with a note explaining that oid and size are all git can show — the content comes from `git lfs pull`. Pointer recognition is a text check (`version https://git-lfs.github.com/spec/v1` plus `oid` and `size`), so it works with or without the LFS client installed; without the client the `git lfs ls-files` call simply returns nothing and no row is tagged.

### Conflict

| Key | Action |
| --- | --- |
| `o` | take ours |
| `T` | take theirs — the one screen where `T` is not the tags screen |
| `B` | take base |
| `m` | open the VS Code merge editor |
| `s` | mark resolved |

### Global

| Key | Action |
| --- | --- |
| `alt+g` | the status screen |
| `alt+[` / `alt+]` | step an open diff to the commit before / after it |
| `l` | action log |
| `q` | close the panel |

## Messages

A confirmation or a hint ("Staged: 2", "Cursor is not on a file or a section header") appears in the
status bar for four seconds and goes away. A refused action ("Cannot delete the branch you are on")
also raises a notification, and a failure — a git command that answered with an error, a patch that did
not apply, a panel that could not be opened at start-up — is written to the **Git Helm** output
channel with its stack *and* repeated as a notification, so a failure never ends as a line that faded
before it was read. The channel keeps the detail; the notification carries the message.

## Folders without a repository

`alt+g` does not fail outside a git repository. The status screen opens with an `init` section instead : `Enter` on the `git init` row (or the notification button, or the `git init` item in the status bar) creates the repository and repaints the screen, a panel taking the place of the init panel. A repository without commits (`git init`, empty history) opens normally — the log is simply empty.

## Stepping a diff through commits

A diff in VS Code's own diff editor carries two more arrows in its toolbar, next to **Previous Change** and **Next Change**: `←` moves it one commit back, `→` one commit forward, and `alt+[` / `alt+]` do the same from the keyboard.

The diff of a commit is always that commit's first parent against the commit — the pair the commit screen and the file log open — so a step and an open land on the same tabs. What the walk follows depends on what the tab shows:

| The tab shows | `←` / `→` walk |
| --- | --- |
| one file | that file's own history (`git log --follow`), so a commit that never touched the file is skipped |
| a list of files (the `## files` of a commit, or several status rows) | the repository's first-parent history, one whole commit per step — the tab is named `<sha8> — <n>`, one file included, because the commit is what it shows |
| the working tree (a status diff) | up to the last commit that touched the file (or the last commit at all, for a list), and back down to the working tree |

The choice is made once, when the walk starts, and every step keeps it: a commit that changed three files can be followed by one that changed a single file, and the walk still goes on through the commits instead of turning into that file's history.

A root commit, the working tree as the newest end, and a commit off the checked-out branch's first-parent chain have no arrow to show: they are greyed out rather than guessed at. The arrows appear only where the two sides really are a commit and its parent (or the working tree and `HEAD`/the index) — a compare range `A..B`, a stash, a conflict stage and a diff of two files on disk get none, because there is no commit to step to.

VS Code cannot change the sides of an open diff, so a step opens the neighbouring pair as a new tab in the same column and closes the one it replaced. The tab count stays at one and the cursor line is carried over; the tab itself ends up at the end of its group.

## Palette and settings

Three commands are intentionally visible in the command palette: **Git Helm: Status**, **Git Helm: Actions for Current File** and **Git Helm: Interface Language**. Everything else is deliberately hidden — the keys of a screen are the interface, and the `editor/context` menu exposes the actions that make sense with a right click.

The interface language can be `en`, `ru` or `zh`; it is stored per user and applied to every panel on the spot.

| Setting | Default | Meaning |
| --- | --- | --- |
| `githelm.log.dateFormat` | `%Y-%m-%d %H:%M` | date format for the history screen, passed to `git --date=format:…` |
| `githelm.log.includeAllRefs` | `false` | show every ref in history, including `refs/stash` and refs created by other tools |
| `githelm.forge.kind` | `auto` | `auto` / `github` / `gitlab` — `auto` reads the forge from the remote host name |
| `githelm.forge.githubToken` | — | GitHub token for the pull request list; falls back to `GITHUB_TOKEN` |
| `githelm.forge.gitlabToken` | — | GitLab token for the merge request list; falls back to `GITLAB_TOKEN` |

All colors are theme-aware and can be overridden in `workbench.colorCustomizations`. The defaults are a warm, chalky "pencil" palette — muted olive for additions, ochre for modifications, brick for deletions, coral for authors and untracked files, sage and honey for the two change sections — with separate values for dark and light themes. Nothing is neon: the colours sit at a low chroma, like strokes of a coloured pencil, and all but the decorative graph lines and the deliberately quiet hints clear WCAG AA contrast against the editor background:

```json
{
  "workbench.colorCustomizations": {
    "githelm.added": "#92a271",
    "githelm.deleted": "#c56f62",
    "githelm.graph": "#8a8073"
  }
}
```

A section is one colour: its heading and the paths of its rows share it — `githelm.staged` sage, `githelm.unstaged` honey, `githelm.untracked` coral, `githelm.conflict` for a merge in progress — so "already staged" reads off the list itself. `githelm.section` stays the neutral colour for headings that have no section of their own (stash, last commits, the other buffers), while the `remotes` and `worktrees` blocks of the right-hand column share `githelm.remotes` — `githelm.worktrees` carries the same value, because they stand one under the other and read as one block, and the `stash` block under them keeps the neutral `githelm.section`. The same brightness is used for the stash file list and the submodule paths (`githelm.path`), while the `##` marker, the hairline under the key hints and the trailing details stay quiet (`githelm.rule`, `githelm.meta`), and the hints themselves are comment-grey (`githelm.help`). On the divergence label the `+ahead` counter takes the add colour and `−behind` the delete colour, so the direction is readable at a glance.

The text of a row is not painted at all: a stash message, a remote URL and a worktree path read at the same weight as the subject of a commit in the history buffer. What the row *is* stays coloured — the stash ref, the remote name and the short hash keep `githelm.branch`, and the branch-to-remote mapping (`origin/main: +2 −1`) has its own coral, `githelm.upstream`, so it is not mistaken for the URL above it or for a ref of a commit.

Available ids: `githelm.added`, `githelm.modified`, `githelm.deleted`, `githelm.conflict`, `githelm.hash`, `githelm.date`, `githelm.author`, `githelm.refs`, `githelm.upstream`, `githelm.graph`, `githelm.hunk`, `githelm.meta`, `githelm.path`, `githelm.section`, `githelm.staged`, `githelm.unstaged`, `githelm.untracked`, `githelm.remotes`, `githelm.worktrees`, `githelm.branch`, `githelm.help`, `githelm.rule`.

## Development

Node 22.8+ is needed: `npm test` uses the test runner flag `--experimental-test-isolation`, which older runtimes reject. CI runs Node 24.

```bash
npm run build        # compile to dist/ and copy the git editor shims
npm run watch        # rebuild on change
npm run typecheck    # tsc --noEmit
npm test             # build the extension and the test tree, validate the manifest, run the suite
```

`npm test` runs **573 tests** (568 passing, 5 skipped) directly against real temporary git repositories — the `git` binary is never mocked. The same command also runs `npm run validate`, which fails when a keybinding or a menu entry points at an unknown command, or when `main`, the icon, the shims, `CHANGELOG.md` or one of the READMEs is missing, or a README lost the link to another language.

The screenshots in this README are demos of the status and history screens, kept in `media/demo/`. They are snapshots, not captures produced by the test suite, so a layout change means making new ones by hand.

## Releases

A tag matching `v*` publishes the extension automatically: the workflow runs the tests, packages one VSIX, publishes that file to the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mercurykd.githelm) and to [Open VSX](https://open-vsx.org/extension/mercurykd/githelm), and attaches it to a GitHub release — so the same build is what everyone downloads.

```bash
npm version patch -m "release %s"   # version, commit and tag
git push --follow-tags              # the tag publishes it
```

The tag can be made from the editor as well: `t` on the tags screen asks for a message — that is what makes the tag annotated — and `U` sends it to the remote. The version in `package.json` still has to be bumped by hand, which is the one thing `npm version` does for you.

The Marketplace publish uses trusted publishing, so no token is stored. Open VSX publishes with the `OVSX_PAT` secret until a trusted publisher is registered for this repository there.
## Architecture

```
src/
  extension.ts        commands, status bar, activation
  git/                thin typed wrappers over the git CLI (status, log, diff, stage,
                      stash, tags, remotes, ops, rewrite, conflicts, compare, …)
  views/              one module per screen: the renderers (`*Doc.ts` for the
                      commit, stash, conflict and file-history screens,
                      `initRender.ts` for `git init`), the shared row labels,
                      the log filters and the blame gutter
  forge/              GitHub / GitLab: remote URL parsing and the REST calls
  webview/            the panels: the host side (`panel.ts`, `keys.ts`), the models
                      that draw a screen, and the browser client
  views/highlight.ts  span colours for the blame editor
  i18n/               en / ru / zh dictionaries with a shared key set
  fs/                 editable virtual documents (commit messages)
  rebase/             GIT_EDITOR bridge for interactive rebase
  util/               process helpers, spans
media/shims/          git editor shims used by the rebase bridge
```

A panel never patches itself: it is redrawn from what git just reported, and a key goes to the host as a message, so the panel cannot drift from the repository. The one virtual document left is the blame (`githelm:` scheme), which has to be a real editor to be highlighted by the file’s grammar.

## Limitations

- One repository at a time: the first one found from the active panel (or the workspace root).
- Fixup and autosquash go through a `GIT_EDITOR` bridge: the todo list can be edited, but there is no per-step progress and a conflict in the middle of the rebase is not guided.
- Conflict resolution is per file (ours / theirs / base) or through the merge editor; there is no hunk-level three-way editor.
- A stash diff is per file — you cannot apply a single hunk from a stash.
- LFS support is recognition, not a client: pointer files get a badge and a note in the diff, but fetching the blobs is still `git lfs pull` on a terminal.
- Pull requests are listed through the API and created in the browser; the extension does not comment, review or merge.
- The test suite is unit-level against real git repositories; there are no extension-host integration tests in CI.

## License

MIT — see [LICENSE](LICENSE).
