import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Whatever deletes or drops something has to ask first. The questions live in
 * `activate()`, where an extension host would be needed to run them, so the rule
 * is checked against the source: every command listed here must ask a `confirm.*`
 * question before it touches the repository.
 */
const DESTRUCTIVE: Array<[string, string]> = [
  ['githelm.status.discard', 'throws file changes away'],
  ['githelm.status.delete', 'drops a stash, removes a remote or a worktree'],
  ['githelm.branches.delete', 'deletes a branch'],
  ['githelm.branches.deleteRemote', 'deletes a branch on the server'],
  ['githelm.branches.reset', 'a hard reset discards uncommitted changes'],
  ['githelm.log.reset', 'a hard reset discards uncommitted changes'],
  ['githelm.status.reset', 'a hard reset discards uncommitted changes'],
  ['githelm.log.revert', 'rewrites history with an undo commit'],
  ['githelm.tags.delete', 'deletes a tag'],
  ['githelm.status.abortMerge', 'drops the conflict resolutions in progress'],
  ['githelm.actionLog.clear', 'drops the record of the commands run'],
];

const SOURCE = fs.readFileSync(path.join('src', 'extension.ts'), 'utf8');

/** The registered command bodies, up to the next `register(` call. */
function bodyOf(id: string): string {
  const start = SOURCE.indexOf(`register('${id}'`);
  assert.ok(start >= 0, `${id} is registered`);
  const next = SOURCE.indexOf("register('", start + 1);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

describe('destructive commands', () => {
  for (const [id, why] of DESTRUCTIVE) {
    it(`${id} asks first (${why})`, () => {
      const body = bodyOf(id);
      const asksHere = /t\('confirm\.[a-zA-Z]+'/.test(body);
      const asksThroughHelper = /await confirm[A-Z][a-zA-Z]*\(/.test(body);
      assert.ok(asksHere || asksThroughHelper, `${id} must ask a confirm.* question before it acts`);
      if (asksHere) {
        assert.match(body, /showWarningMessage\(/, `${id} asks through a modal warning`);
        assert.match(body, /\{ modal: true\s*[,}]/, `${id} asks in a modal dialog, so it cannot be missed`);
      }
    });
  }

  it('asks for a hard reset, which is the mode that discards work', () => {
    const helper = SOURCE.slice(SOURCE.indexOf('const confirmReset ='), SOURCE.indexOf("register('githelm.status.reset'"));
    assert.match(helper, /t\('confirm\.resetHard'/, 'the reset question is asked');
    assert.match(helper, /\{ modal: true \}/, 'and it is a modal one');
    assert.match(helper, /mode !== 'hard'/, 'soft and mixed reset only move the pointer, so they do not ask');
  });

  it('asks for each thing the delete key can destroy', () => {
    const body = bodyOf('githelm.status.delete');
    for (const key of ['confirm.dropStash', 'confirm.deleteRemote', 'confirm.removeWorktree']) {
      assert.ok(body.includes(key), `githelm.status.delete asks ${key}`);
    }
  });

  it('names the thing it deletes: a tag is not a remote', () => {
    assert.ok(
      bodyOf('githelm.tags.delete').includes('confirm.deleteTag'),
      'the tag dialog does not say "Delete remote"'
    );
  });

  it('does not ask twice for a pop or an apply, which lose nothing', () => {
    // `p` applies the stash and then drops the entry: the changes are in the
    // working tree either way, so a question would only slow the normal flow.
    for (const id of ['githelm.status.stashPop', 'githelm.status.stashApply']) {
      assert.doesNotMatch(bodyOf(id), /t\('confirm\./, `${id} does not ask`);
    }
  });
});
