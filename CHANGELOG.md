# Changelog

All notable changes to **Git Helm** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] — 2026-11-19

### Added

- `alt+s` stages every change in the repository, deletions included, and `alt+u` takes all of it back out of the index. They sit next to `s` and `u`, which keep working per file, per section and per selection.

### Changed

- The `keys` column of the status screen sits a little left of the shared column: with two more keys the hints ran past the right edge of a normal window.

### Fixed

- The tag commands no longer appear in the Command Palette, where the extension keeps nothing but its three entry points.

## [0.0.3] — 2026-11-19

### Added

- Refreshing the status screen says so in the status bar: `r` used to be silent whenever nothing in the repository had changed, which reads as a dead key.

### Fixed

- Windows: after initialising a repository from the status buffer, the buffer kept showing the text of the first render — `r`, `s` and `u` reached git but the screen did not follow. The document was keyed by the folder in one spelling (`D:\…`, what VS Code hands over) and re-rendered in another (`D:/…`, what git prints); both are one path now, and a buffer remembers the folder it was opened for.
- The branches screen stayed empty in a repository without commits, although the status screen reported the branch: a branch that `HEAD` points at but that has no commit is not a ref yet, so there was nothing to list. It is shown now, with a `no commits yet` note.
- Stage, unstage, diff, discard and ignore answered "Not on a file or a section header" when the cursor was on an empty section header. An empty section now says so instead.

## [0.0.2] — 2026-11-18

### Added

- A tag can be given a message when it is created, which makes it an annotated tag — the kind `git push --follow-tags` sends.

### Changed

- The `keys` column of every screen is three lines tall, and the list screens (tags, branches, history) keep it closer to the text.
- The tags screen lists tags from the sixth line and shows the message of an annotated tag in a column of its own, next to the commit subject it keeps.
- The history screen starts its filter block on the sixth line, below the key hints.

## [0.0.1] — 2026-11-15

First public release. Everything described in the README is the baseline: status, diff,
history, branches, tags, stash, remotes, conflicts, commit buffers, the action log and
the en/ru/zh interface.
