# Changelog

All notable changes to **Git Helm** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
