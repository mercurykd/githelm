import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The panel's keys must report in the status bar exactly as the buffer commands do:
 * `f` spins `fetching` and ends with `$(check) fetched`. That comes from the
 * `PROGRESS` table in `activate()`, which a registered command reaches through
 * `guarded()` and the panel reaches through `runWithProgress()` in its deps. Neither
 * the table nor the deps can be imported without an extension host, so the rule is
 * checked against the source: every progress id the panel names must exist in the
 * table, and every slow key must go through the wrapper.
 */
const SOURCE = fs.readFileSync(path.join('src', 'extension.ts'), 'utf8');
const PANEL = fs.readFileSync(path.join('src', 'webview', 'panel.ts'), 'utf8');

/** The `{ … }` block assigned to `header`, up to its closing line. */
function blockOf(header: string, source = SOURCE): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} is in the source`);
  const end = source.indexOf('\n  };', start);
  assert.ok(end > start, `${header} is closed`);
  return source.slice(start, end);
}

/** The quoted ids inside a block. */
function idsIn(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((id) => id.includes('.'));
}

const progress = idsIn(blockOf('const PROGRESS: Record<string, { spin: string; done?: string }> = {'));

describe('the panel reports like the buffer', () => {
  it('names only progress lines that exist', () => {
    const named = [
      ...idsIn(blockOf('const PROGRESS_FOR_REPO: Partial<Record<RepoAction, string>> = {')),
      ...idsIn(blockOf('const PROGRESS_FOR_TARGET: Partial<Record<TargetAction, string>> = {')),
    ];
    assert.ok(named.length >= 9, `the panel names its slow keys (${named.join(', ')})`);
    for (const id of named) {
      assert.ok(progress.includes(id), `${id} has a progress line the buffer uses`);
    }
  });

  it('routes every slow key through the progress wrapper', () => {
    // The deps block: from the constructor call to the closing `});`.
    const deps = blockOf('const statusWebview = new StatusWebview({');
    for (const key of ['commit', 'stash', 'runRepo', 'runTarget']) {
      const at = deps.indexOf(`${key}: `);
      assert.ok(at >= 0, `${key} is one of the panel's deps`);
      // The arrow may wrap, so the wrapper is looked for just past the key.
      assert.match(deps.slice(at, at + 200), /runWithProgress\(/, `${key} reports through runWithProgress`);
    }
  });

  it('gives the wrapper the spinner, the done line and the error path', () => {
    const body = SOURCE.slice(SOURCE.indexOf('const runWithProgress = async ('), SOURCE.indexOf('const guarded ='));
    assert.ok(body.length > 0, 'the wrapper is found');
    assert.match(body, /\$\(sync~spin\)/, 'spins while it runs');
    assert.match(body, /\$\(check\)/, 'ends with a check line');
    assert.match(body, /fail\(error\)/, 'reports a failure the way a command does');
    assert.match(body, /activityItem\.hide\(\)/, 'hides the item when there is nothing to say');
  });

  it('sends `z` through the host, not straight to git', () => {
    assert.match(PANEL, /await this\.statusDeps\.stash\(repoPath, fileTargetsOf\(model, ids\)\)/);
    assert.doesNotMatch(PANEL, /pushStash\(/, 'the panel no longer calls git itself');
  });
});
