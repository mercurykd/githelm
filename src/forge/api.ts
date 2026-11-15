import type { ForgeRemote } from './remote';

/** One open pull request (GitHub) or merge request (GitLab). */
export interface ForgeItem {
  number: number;
  title: string;
  author: string;
  /** Branch the request comes from. */
  source: string;
  /** Branch it wants to land on. */
  target: string;
  draft: boolean;
  url: string;
  updatedAt: string;
}

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

const PER_PAGE = 50;

/** GitHub.com uses its own host, Enterprise serves the same API under /api/v3. */
export function apiBase(remote: ForgeRemote): string {
  if (remote.kind === 'github') {
    return remote.host === 'github.com' ? 'https://api.github.com' : `https://${remote.host}/api/v3`;
  }
  return `https://${remote.host}/api/v4`;
}

export function pullsUrl(remote: ForgeRemote): string {
  if (remote.kind === 'github') {
    return `${apiBase(remote)}/repos/${remote.projectPath}/pulls?state=open&sort=updated&per_page=${PER_PAGE}`;
  }
  // GitLab names the project by its full path, URL-encoded into one segment.
  const project = encodeURIComponent(remote.projectPath);
  return `${apiBase(remote)}/projects/${project}/merge_requests?state=opened&order_by=updated_at&per_page=${PER_PAGE}`;
}

export function authHeaders(remote: ForgeRemote, token: string): Record<string, string> {
  if (remote.kind === 'github') {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'githelm',
    };
  }
  return { 'private-token': token };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

export function mapGithubPulls(json: unknown): ForgeItem[] {
  if (!Array.isArray(json)) {
    throw new ForgeError('GitHub returned an unexpected payload');
  }
  return json.map((raw) => {
    const pr = record(raw);
    return {
      number: count(pr.number),
      title: text(pr.title),
      author: text(record(pr.user).login),
      source: text(record(pr.head).ref),
      target: text(record(pr.base).ref),
      draft: pr.draft === true,
      url: text(pr.html_url),
      updatedAt: text(pr.updated_at),
    };
  });
}

export function mapGitlabMergeRequests(json: unknown): ForgeItem[] {
  if (!Array.isArray(json)) {
    throw new ForgeError('GitLab returned an unexpected payload');
  }
  return json.map((raw) => {
    const mr = record(raw);
    return {
      number: count(mr.iid),
      title: text(mr.title),
      author: text(record(mr.author).name),
      source: text(mr.source_branch),
      target: text(mr.target_branch),
      draft: mr.draft === true || mr.work_in_progress === true,
      url: text(mr.web_url),
      updatedAt: text(mr.updated_at),
    };
  });
}

/** Reads the open requests of the repository. Throws ForgeError with details. */
export async function fetchForgeItems(remote: ForgeRemote, token: string): Promise<ForgeItem[]> {
  if (typeof fetch !== 'function') {
    throw new ForgeError('This VS Code build has no fetch() available');
  }
  const response = await fetch(pullsUrl(remote), { headers: authHeaders(remote, token) });
  const body = await response.text();
  if (!response.ok) {
    throw new ForgeError(body.trim() || `HTTP ${response.status}`, response.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ForgeError('The forge answered with something that is not JSON');
  }
  return remote.kind === 'github' ? mapGithubPulls(json) : mapGitlabMergeRequests(json);
}

/**
 * The "new pull request" page for a branch. It needs no token and no API: the
 * browser asks for the authorisation it needs, which keeps the flow working
 * even when the extension has none.
 */
export function newPullUrl(remote: ForgeRemote, branch: string, base: string): string {
  if (remote.kind === 'github') {
    const from = encodeURIComponent(base);
    const to = encodeURIComponent(branch);
    return `${remote.webUrl}/compare/${from}...${to}?expand=1`;
  }
  const query = new URLSearchParams({
    'merge_request[source_branch]': branch,
    'merge_request[target_branch]': base,
  });
  return `${remote.webUrl}/-/merge_requests/new?${query.toString()}`;
}
