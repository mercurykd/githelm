import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRemoteTag, tagDeleteRemoteArgs, tagPushArgs } from '../src/git/tags';

describe('tagPushArgs', () => {
  it('pushes the tag by its full ref, so a branch of the same name is not touched', () => {
    assert.deepEqual(tagPushArgs('v1.0.0', 'origin'), ['push', 'origin', 'refs/tags/v1.0.0']);
  });

  it('leases the force against the value the tag has on the remote', () => {
    // The explicit `<refname>:<expect>` form is the only lease that works for a
    // tag: the other forms compare with a remote-tracking ref, and a tag has none.
    assert.deepEqual(tagPushArgs('v1.0.0', 'origin', 'abc1234abc1234abc1234abc1234abc1234abcd'), [
      'push',
      '--force-with-lease=refs/tags/v1.0.0:abc1234abc1234abc1234abc1234abc1234abcd',
      'origin',
      'refs/tags/v1.0.0',
    ]);
  });

  it('sends no force at all when the tag is not on the remote yet', () => {
    assert.equal(
      tagPushArgs('v1.0.0', 'upstream').some((arg) => arg.startsWith('--force')),
      false,
      'a tag that does not exist yet needs no lease'
    );
  });
});

describe('tagDeleteRemoteArgs', () => {
  it('spells out the full ref, so a branch of the same name is not deleted', () => {
    assert.deepEqual(tagDeleteRemoteArgs('v1.0.0', 'origin'), ['push', 'origin', '--delete', 'refs/tags/v1.0.0']);
  });
});

describe('parseRemoteTag', () => {

  it('reads a lightweight tag', () => {
    const output = 'abc1234abc1234abc1234abc1234abc1234abcd\trefs/tags/v1.0.0\n';
    assert.deepEqual(parseRemoteTag(output, 'v1.0.0'), {
      ref: 'abc1234abc1234abc1234abc1234abc1234abcd',
      commit: 'abc1234abc1234abc1234abc1234abc1234abcd',
    });
  });

  it('peels an annotated tag, because that is what a local row compares with', () => {
    const output = [
      'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\trefs/tags/v1.0.0',
      'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222\trefs/tags/v1.0.0^{}',
      '',
    ].join('\n');
    assert.deepEqual(parseRemoteTag(output, 'v1.0.0'), {
      ref: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
      commit: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    });
  });

  it('answers nothing when the remote does not have the tag', () => {
    assert.equal(parseRemoteTag('', 'v1.0.0'), undefined);
    assert.equal(parseRemoteTag('cccc3333cccc3333cccc3333cccc3333cccc3333\trefs/tags/other\n', 'v1.0.0'), undefined);
  });

  it('ignores anything that is not a sha, so a warning on stdout cannot be mistaken for a tag', () => {
    const output = ['warning: redirecting to https://example.com/repo.git/', 'not-a-sha\trefs/tags/v1.0.0', ''].join('\n');
    assert.equal(parseRemoteTag(output, 'v1.0.0'), undefined);
  });
});
