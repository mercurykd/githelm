import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Whatever deletes or drops something has to ask first.
 *
 * The screens are panels now, so the questions are asked by the shared handlers the panels
 * and the keys both run: `runBranch`, `runTag`, `runLog`, `runDeleteTarget`, `runReset`,
 * `runAbort`, `runClearActionLog` in the host, and the `discard` case of the status panel,
 * which asks with its own warning. Those bodies are where a question must be, and this
 * file checks them in the source, because running them needs an extension host.
 */
const HOST = fs.readFileSync(path.join('src', 'extension.ts'), 'utf8');
const PANEL = fs.readFileSync(path.join('src', 'webview', 'panel.ts'), 'utf8');

/** The source of a `const runXxx = async (…) => { … };` helper, up to the next one. */
function helperOf(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf('\n  const ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

/** One `case 'x': …` block of a switch, up to the next case or `default`. */
function caseOf(source: string, action: string): string {
  const head = `case '${action}':`;
  const start = source.indexOf(head);
  assert.ok(start >= 0, `the ${action} case exists`);
  const after = start + head.length;
  const ends = ["\n      case '", '\n      default:', '\n        case \''].map((marker) => source.indexOf(marker, after));
  const next = ends.filter((index) => index > after);
  return source.slice(start, next.length > 0 ? Math.min(...next) : undefined);
}

describe('destructive actions', () => {
  it('asks before it throws file changes away', () => {
    const body = caseOf(PANEL, 'discard');
    assert.match(body, /confirm\.discard/, 'the panel asks before it discards');
    assert.match(body, /showWarningMessage\(/, 'and asks through a warning');
    assert.match(body, /\{ modal: true\s*[,}]/, 'in a modal dialog, so it cannot be missed');
  });

  it('asks for each thing the delete key can drop', () => {
    const body = helperOf(HOST, 'runDeleteTarget');
    for (const key of ['confirm.dropStash', 'confirm.deleteRemote', 'confirm.removeWorktree']) {
      assert.ok(body.includes(key), `delete asks ${key}`);
    }
  });

  it('asks before it deletes a branch, locally and on the server', () => {
    const body = helperOf(HOST, 'runBranch');
    for (const key of ['confirm.deleteBranch', 'confirm.deleteRemoteBranch']) {
      assert.ok(body.includes(key), `delete asks ${key}`);
    }
  });

  it('names the thing it deletes: a tag is not a remote', () => {
    const body = helperOf(HOST, 'runTag');
    assert.ok(body.includes('confirm.deleteTag'), 'the tag dialog does not say "Delete remote"');
    assert.ok(body.includes('confirm.deleteRemoteTag'), 'and a remote tag says it is a remote');
  });

  it('asks for a hard reset, which is the mode that discards work', () => {
    const helper = helperOf(HOST, 'confirmReset');
    assert.match(helper, /t\('confirm\.resetHard'/, 'the reset question is asked');
    assert.match(helper, /\{ modal: true \}/, 'and it is a modal one');
    assert.match(helper, /mode !== 'hard'/, 'soft and mixed reset only move the pointer, so they do not ask');
  });

  it('chooses the reset mode in one step, with the target in the picker prompt', () => {
    // `R` on the status screen, `S` on a branch and `R` on a commit all open one mode
    // picker; its prompt says what the reset target is, so no second question follows.
    const picker = helperOf(HOST, 'pickResetMode');
    assert.match(picker, /showQuickPick\(/, 'the modes are one picker');
    assert.match(picker, /placeHolder: prompt/, 'the prompt names the target');
    assert.doesNotMatch(HOST, /askResetTarget/, 'there is no second, target prompt');
    assert.match(helperOf(HOST, 'runReset'), /pickResetMode\(t\('reset\.toHead'\)\)/, 'no row means HEAD');
    assert.match(
      helperOf(HOST, 'runBranch'),
      /pickResetMode\(t\('reset\.toBranch', \{ name: entry\.name \}\)\)/,
      'a branch row names the branch'
    );
    assert.match(
      helperOf(HOST, 'runLog'),
      /pickResetMode\(t\('reset\.toCommit', \{ sha: commit\.shortSha \}\)\)/,
      'a commit row names the commit'
    );
  });

  it('asks before it rewrites history with an undo commit', () => {
    const body = helperOf(HOST, 'runLog');
    assert.ok(body.includes('confirm.revert'), 'revert asks');
  });

  it('checks out a commit that no branch points at instead of sending the reader away', () => {
    // The old checkout looked only at the decorations and answered with the
    // "branches live on the branches screen" notice; a commit is still a commit.
    const body = helperOf(HOST, 'runLog');
    assert.match(body, /checkoutableRefs\(commit\.refs\)/);
    assert.match(body, /checkoutBranch\(repo, commit\.sha\)/, 'the commit itself is the fallback');
    assert.match(body, /msg\.checkoutDetached/, 'and the notice says HEAD is detached');
    assert.doesNotMatch(body, /if \(refs\.length === 0\) \{\s*warn\(t\('msg\.notEditable'\)\)/, 'no misleading notice');
  });

  it('asks before it drops the conflict resolutions in progress', () => {
    const body = helperOf(HOST, 'runAbort');
    assert.match(body, /t\('confirm\.abortOperation'/, 'abort asks');
    assert.match(body, /\{ modal: true \}/, 'and it is a modal one');
  });

  it('asks before it drops the record of the commands run', () => {
    const body = helperOf(HOST, 'runClearActionLog');
    assert.match(body, /t\('confirm\.clearLog'/, 'clearing the action log asks');
  });

  it('does not ask twice for a pop or an apply, which lose nothing', () => {
    // `p` applies the stash and then drops the entry: the changes are in the
    // working tree either way, so a question would only slow the normal flow.
    for (const name of ['runStashPop', 'runStashApply']) {
      assert.doesNotMatch(helperOf(HOST, name), /t\('confirm\./, `${name} does not ask`);
    }
  });
});
