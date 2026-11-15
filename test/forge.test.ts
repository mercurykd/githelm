import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  apiBase,
  authHeaders,
  ForgeError,
  mapGithubPulls,
  mapGitlabMergeRequests,
  newPullUrl,
  pullsUrl,
} from '../src/forge/api';
import { parseForgeRemote } from '../src/forge/remote';

const github = parseForgeRemote('git@github.com:mercurykd/githelm.git');
const gitlab = parseForgeRemote('https://gitlab.com/group/sub/project.git');

describe('forge remote parsing', () => {
  it('reads the scp-like ssh form', () => {
    assert.deepEqual(github, {
      kind: 'github',
      host: 'github.com',
      projectPath: 'mercurykd/githelm',
      owner: 'mercurykd',
      repo: 'githelm',
      webUrl: 'https://github.com/mercurykd/githelm',
    });
  });

  it('reads https, ssh:// and a port', () => {
    assert.equal(parseForgeRemote('https://github.com/owner/repo')?.projectPath, 'owner/repo');
    assert.equal(parseForgeRemote('ssh://git@github.com:22/owner/repo.git')?.projectPath, 'owner/repo');
    assert.equal(parseForgeRemote('https://user:token@github.com/owner/repo.git')?.host, 'github.com');
  });

  it('keeps GitLab subgroups in the project path', () => {
    assert.deepEqual(gitlab, {
      kind: 'gitlab',
      host: 'gitlab.com',
      projectPath: 'group/sub/project',
      owner: 'group/sub',
      repo: 'project',
      webUrl: 'https://gitlab.com/group/sub/project',
    });
  });

  it('recognises a self-hosted host by name, or by explicit setting', () => {
    assert.equal(parseForgeRemote('https://gitlab.example.com/team/app.git')?.kind, 'gitlab');
    assert.equal(parseForgeRemote('https://code.example.com/team/app.git'), undefined);
    assert.equal(parseForgeRemote('https://code.example.com/team/app.git', 'github')?.kind, 'github');
    assert.equal(parseForgeRemote('https://code.example.com/team/app.git', 'gitlab')?.projectPath, 'team/app');
  });

  it('ignores remotes that belong to no forge', () => {
    assert.equal(parseForgeRemote(''), undefined);
    assert.equal(parseForgeRemote('/home/me/repo'), undefined);
    assert.equal(parseForgeRemote('file:///home/me/repo.git'), undefined);
    assert.equal(parseForgeRemote('https://example.com/only-owner.git'), undefined);
    assert.equal(parseForgeRemote('not a url at all'), undefined);
  });
});

describe('forge api urls', () => {
  it('uses the documented github endpoint', () => {
    assert.equal(apiBase(github as NonNullable<typeof github>), 'https://api.github.com');
    assert.equal(
      pullsUrl(github as NonNullable<typeof github>),
      'https://api.github.com/repos/mercurykd/githelm/pulls?state=open&sort=updated&per_page=50'
    );
  });

  it('uses /api/v3 for GitHub Enterprise', () => {
    const enterprise = parseForgeRemote('git@github.example.com:team/app.git', 'github');
    assert.equal(apiBase(enterprise as NonNullable<typeof enterprise>), 'https://github.example.com/api/v3');
  });

  it('encodes the whole GitLab project path into one segment', () => {
    assert.equal(
      pullsUrl(gitlab as NonNullable<typeof gitlab>),
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests?state=opened&order_by=updated_at&per_page=50'
    );
  });

  it('sends each forge the header it expects', () => {
    assert.deepEqual(authHeaders(github as NonNullable<typeof github>, 'abc'), {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer abc',
      'user-agent': 'githelm',
    });
    assert.deepEqual(authHeaders(gitlab as NonNullable<typeof gitlab>, 'abc'), { 'private-token': 'abc' });
  });

  it('builds a token-free create page for both forges', () => {
    assert.equal(
      newPullUrl(github as NonNullable<typeof github>, 'feature/x', 'main'),
      'https://github.com/mercurykd/githelm/compare/main...feature%2Fx?expand=1'
    );
    assert.equal(
      newPullUrl(gitlab as NonNullable<typeof gitlab>, 'feature/x', 'main'),
      'https://gitlab.com/group/sub/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx&merge_request%5Btarget_branch%5D=main'
    );
  });
});

describe('forge payload mapping', () => {
  it('maps GitHub pull requests', () => {
    const items = mapGithubPulls([
      {
        number: 12,
        title: 'Add submodules',
        user: { login: 'octocat' },
        head: { ref: 'feature/x' },
        base: { ref: 'main' },
        draft: true,
        html_url: 'https://github.com/o/r/pull/12',
        updated_at: '2024-05-01T10:00:00Z',
      },
    ]);
    assert.deepEqual(items, [
      {
        number: 12,
        title: 'Add submodules',
        author: 'octocat',
        source: 'feature/x',
        target: 'main',
        draft: true,
        url: 'https://github.com/o/r/pull/12',
        updatedAt: '2024-05-01T10:00:00Z',
      },
    ]);
  });

  it('maps GitLab merge requests, treating work_in_progress as a draft', () => {
    const items = mapGitlabMergeRequests([
      {
        iid: 7,
        title: 'Add LFS',
        author: { name: 'Jane' },
        source_branch: 'feature/lfs',
        target_branch: 'main',
        work_in_progress: true,
        web_url: 'https://gitlab.com/g/p/-/merge_requests/7',
        updated_at: '2024-05-02T10:00:00Z',
      },
    ]);
    assert.equal(items[0].number, 7);
    assert.equal(items[0].author, 'Jane');
    assert.equal(items[0].source, 'feature/lfs');
    assert.equal(items[0].draft, true);
    assert.equal(items[0].url, 'https://gitlab.com/g/p/-/merge_requests/7');
  });

  it('tolerates missing fields', () => {
    const [item] = mapGithubPulls([{ number: 1 }]);
    assert.equal(item.title, '');
    assert.equal(item.author, '');
    assert.equal(item.draft, false);
  });

  it('rejects a payload that is not a list', () => {
    assert.throws(() => mapGithubPulls({ message: 'Bad credentials' }), ForgeError);
    assert.throws(() => mapGitlabMergeRequests('nope'), ForgeError);
  });
});
