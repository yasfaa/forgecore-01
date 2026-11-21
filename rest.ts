// The REST v3 API, first draft: only what the git conformance checks need before the full API
// lands — repository creation through POST /api/v3/user/repos and the repository GET. The full
// surface (issues, labels, pulls, contents, pagination) is the API module's work.

import type { RequestScope } from './app.ts';
import { MalformedBody, parseJsonBody, readBody, sendError, sendJson } from './httpx.ts';
import { USERS } from './scenario.ts';
import type { ForgeRepo } from './forge.ts';

export async function tryServeRest(scope: RequestScope): Promise<boolean> {
  const { method, path } = scope;
  if (!path.startsWith('/api/v3')) return false;
  const rest = path === '/api/v3/' ? '/' : path.slice('/api/v3'.length);

  if (method === 'GET' && (rest === '/' || rest === '')) {
    sendJson(scope.res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // The API is the token's world: a request without the suite's token is 401.
  if (scope.token !== scope.validToken) {
    sendError(scope.res, 401, 'Requires authentication');
    return true;
  }

  if (method === 'GET' && rest === '/meta') {
    sendJson(scope.res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (method === 'POST' && (rest === '/user/repos' || rest === '/user/repos/')) {
    const body = parseJsonBody(await readBody(scope.req)) as { name?: unknown; description?: unknown; private?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name : '';
    if (name === '') {
      sendError(scope.res, 422, 'Validation Failed: name is required');
      return true;
    }
    const description = typeof body?.description === 'string' ? body.description : '';
    const isPrivate = body?.private === true;
    const existing = scope.forge.repo(scope.forge.viewerLogin, name);
    if (existing !== undefined) {
      sendError(scope.res, 422, 'Validation Failed: name already exists on this account');
      return true;
    }
    const repo = scope.forge.createRepo(scope.forge.viewerLogin, name, description, isPrivate, 'main');
    sendJson(scope.res, 201, repoJson(repo));
    return true;
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(rest);
  if (repoMatch !== null) {
    const [, owner, name] = repoMatch;
    const repo = scope.forge.repo(owner!, name!);
    if (repo === undefined) {
      sendError(scope.res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(scope.res, 200, repoJson(repo));
      return true;
    }
  }

  return false;
}

/** The GitHub-shaped repository object. */
export function repoJson(repo: ForgeRepo): Record<string, unknown> {
  const owner = USERS.find((user) => user.login === repo.owner) ?? { id: 0, login: repo.owner, name: repo.owner, email: '' };
  return {
    id: repoIdOf(repo),
    node_id: `R_${repoIdOf(repo)}`,
    name: repo.name,
    full_name: repo.fullName(),
    owner: userJson(owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.local/${repo.fullName()}`,
    clone_url: `https://forge.local/${repo.fullName()}.git`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    has_issues: true,
    has_pull_requests: true,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

const repoIds = new Map<string, number>();

/** A stable integer id per repository, assigned on first sight. */
export function repoIdOf(repo: ForgeRepo): number {
  const key = repo.fullName();
  let id = repoIds.get(key);
  if (id === undefined) {
    id = 5000 + repoIds.size;
    repoIds.set(key, id);
  }
  return id;
}

/** The GitHub-shaped user object. */
export function userJson(user: { id: number; login: string; name?: string; email?: string }): Record<string, unknown> {
  return {
    id: user.id,
    node_id: `U_${user.id}`,
    login: user.login,
    name: user.name ?? user.login,
    email: user.email ?? `${user.login}@example.invalid`,
    type: 'User',
    html_url: `https://forge.local/${user.login}`,
  };
}
