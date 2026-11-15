/**
 * Which forge hosts a repository, derived from the remote URL alone — no
 * network, no token, works for a clone that was never opened before.
 */
export type ForgeKind = 'github' | 'gitlab';

export interface ForgeRemote {
  kind: ForgeKind;
  /** `github.com`, `gitlab.com`, or a self-hosted host. */
  host: string;
  /** `owner/repo` for GitHub; the full namespace for GitLab subgroups. */
  projectPath: string;
  /** Everything before the last segment of `projectPath`. */
  owner: string;
  repo: string;
  /** `https://host/projectPath` — the page a user can open. */
  webUrl: string;
}

const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;

function inferKind(host: string, fallback?: ForgeKind): ForgeKind | undefined {
  if (fallback) {
    return fallback;
  }
  if (/gitlab/i.test(host)) {
    return 'gitlab';
  }
  if (/github/i.test(host)) {
    return 'github';
  }
  return undefined;
}

/**
 * Understands every remote form git accepts: `git@github.com:owner/repo.git`,
 * `ssh://git@host:2222/owner/repo.git`, `https://user:token@host/owner/repo.git`
 * and the local `file://` paths (which belong to no forge).
 */
export function parseForgeRemote(rawUrl: string, kind?: ForgeKind): ForgeRemote | undefined {
  const url = rawUrl.trim();
  if (url.length === 0) {
    return undefined;
  }

  let host: string;
  let pathPart: string;
  if (!url.includes('://') && SCP_LIKE.test(url)) {
    const match = SCP_LIKE.exec(url) as RegExpExecArray;
    host = match[1];
    pathPart = match[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    pathPart = parsed.pathname;
  }

  const projectPath = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!host || !projectPath.includes('/')) {
    return undefined;
  }

  const resolvedKind = inferKind(host, kind);
  if (!resolvedKind) {
    return undefined;
  }

  const segments = projectPath.split('/');
  const repo = segments.pop() as string;
  return {
    kind: resolvedKind,
    host,
    projectPath,
    owner: segments.join('/'),
    repo,
    webUrl: `https://${host}/${projectPath}`,
  };
}
