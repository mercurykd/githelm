import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clearActions, recordAction } from '../src/git/actionLog';
import { t } from '../src/i18n';
import { buildActionLogModel } from '../src/webview/model/actionlog';

/**
 * The log is the one screen that belongs to no repository: the panel draws the
 * records newest first, so the last command is always the first row.
 */
describe('buildActionLogModel', () => {
  it('lists the newest command first, with the clock and label', () => {
    clearActions();
    recordAction({ at: Date.UTC(2026, 0, 2, 10, 15, 3), args: ['status', '--short'], code: 0, ms: 12 });
    recordAction({ at: Date.UTC(2026, 0, 2, 10, 16, 0), args: ['fetch', 'origin'], code: 128, ms: 40, error: 'boom\nmore' });

    const model = buildActionLogModel();
    const rows = model.blocks[0].rows;
    assert.equal(rows.length, 2);
    assert.ok(rows[0].text.startsWith('git fetch origin'), rows[0].text);
    assert.ok(rows[0].text.includes('→ 128'), 'a failing command keeps its exit code');
    assert.ok(rows[0].text.includes('✗ boom'), 'and the first line of the error');
    assert.ok(!rows[0].text.includes('more'), 'but not the rest of the message');
    assert.ok(rows[1].text.includes('git status --short'));
    assert.ok(rows[1].text.includes('→ 0 (12 ms)'));
    clearActions();
  });

  it('gives each row a stable id, so a refresh keeps the selection', () => {
    clearActions();
    recordAction({ at: 1, args: ['status'], code: 0, ms: 1 });
    const first = buildActionLogModel().blocks[0].rows[0].id;
    recordAction({ at: 2, args: ['log'], code: 0, ms: 1 });
    const again = buildActionLogModel().blocks[0].rows;
    assert.equal(again.length, 2);
    assert.equal(again[1].id, first, 'the older record kept its place in the log');
    clearActions();
  });

  it('says so when nothing has run yet', () => {
    clearActions();
    const model = buildActionLogModel();
    assert.equal(model.blocks[0].rows.length, 0);
    assert.deepEqual(model.facts, [], 'no count line: the block heading carries the count');
    assert.equal(model.emptyText, t('actionLog.empty'), 'the empty screen speaks for the log');
    assert.ok(model.blocks[0].empty && model.blocks[0].empty.length > 0);
  });

  it('is a log screen with its key line', () => {
    const model = buildActionLogModel();
    assert.equal(model.kind, 'actionlog');
    assert.ok(model.title.includes('action log'), model.title);
    assert.ok(!model.title.includes('{app}'), 'the app name is substituted, not left as a placeholder');
    const keys = model.hints.map((hint) => hint.keys).join(' ');
    for (const key of ['c', 'g', 'T', 'r', 'q']) {
      assert.ok(keys.split(/\s+/).includes(key), key);
    }
  });

  it('prints the command it ran and how it ended', () => {
    clearActions();
    recordAction({ at: Date.UTC(2026, 0, 2, 10, 15, 3), args: ['status'], code: 0, ms: 12 });
    const row = buildActionLogModel().blocks[0].rows[0];
    assert.ok(row.text.startsWith('git status'), row.text);
    assert.ok(row.text.includes('→ 0 (12 ms)'), row.text);
    clearActions();
  });
});
