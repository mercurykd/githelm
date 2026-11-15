import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReporter, MessageHost } from '../src/util/notifier';

interface Recorded {
  status: string[];
  popup: string[];
}

function recorder(): Recorded {
  return { status: [], popup: [] };
}

function hostOf(recorded: Recorded): MessageHost {
  return {
    status: (message) => {
      recorded.status.push(message);
    },
    popup: (message) => {
      recorded.popup.push(message);
    },
  };
}

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

describe('createReporter', () => {
  it('keeps a confirmation in the status bar', () => {
    const recorded = recorder();
    createReporter(hostOf(recorded), text).info('Stash created.');
    assert.deepEqual(recorded.status, ['Stash created.']);
    assert.deepEqual(recorded.popup, [], 'a confirmation does not stop the eye');
  });

  it('shows a refusal in the status bar and as a popup', () => {
    const recorded = recorder();
    createReporter(hostOf(recorded), text).refuse('Cannot delete the branch you are on.');
    assert.deepEqual(recorded.status, ['Cannot delete the branch you are on.']);
    assert.deepEqual(recorded.popup, ['Cannot delete the branch you are on.'], 'a refused action is worth a window');
  });

  it('duplicates a failure as a popup and keeps the stack in the log', () => {
    const recorded = recorder();
    const logged: string[] = [];
    const statuses: string[] = [];
    const error = new Error('git push failed');
    createReporter(hostOf(recorded), text).fail(error, (line) => logged.push(line), (message) => statuses.push(message));

    assert.deepEqual(recorded.popup, ['git push failed'], 'the failure is repeated as a popup');
    assert.deepEqual(statuses, ['git push failed'], 'and shown in the status bar');
    assert.equal(logged[0], '[error] git push failed');
    assert.ok(
      logged.some((line) => line.includes('notifier.test')),
      'the stack follows the message in the log, where it can be read'
    );
  });

  it('reports a thrown value that is not an Error', () => {
    const recorded = recorder();
    const logged: string[] = [];
    createReporter(hostOf(recorded), text).fail('boom', (line) => logged.push(line), () => undefined);
    assert.deepEqual(recorded.popup, ['boom']);
    assert.deepEqual(logged, ['[error] boom'], 'nothing to add when there is no stack');
  });
});
