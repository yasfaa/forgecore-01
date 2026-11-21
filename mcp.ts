// MCP at POST /mcp: JSON-RPC 2.0 over the Streamable HTTP transport, answering application/json.
// Both protocol eras the suite speaks are served from one endpoint: a `server/discover` request (the
// 2026-07-28 revision, where every request declares its revision in _meta and no handshake exists)
// gets a DiscoverResult with a non-empty supportedVersions list, and a legacy `initialize` gets the
// handshake result with the offered revision echoed back. Tools act on the same store as REST, so a
// repository or issue created over MCP is the same object the REST v3 surface serves, ids included.
//
// Refusals keep JSON-RPC shapes: an unknown tool is a -32602 error response (never HTTP 500), a
// tools/call without required arguments is an isError tool result, a body that is not JSON is HTTP
// 400 with -32700, and a request with no Authorization header is 401 before anything is parsed.

import type { RequestScope } from './app.ts';
import { readBody, sendError, sendJson } from './httpx.ts';
import type { Forge, ForgeRepo } from './forge.ts';
import { createIssueIn, createPullIn, issueJson, mergePullIn, pullFilesDiff, pullJson, repoJson, setIssueStateIn } from './rest.ts';

type Json = Record<string, unknown>;

const SERVER_NAME = 'forgecore';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const LEGACY_REVISION = '2025-11-25';

// ---------------------------------------------------------------- the tool table

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated account',
    properties: {
      name: { type: 'string', description: 'The name of the repository to create' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name',
    properties: {
      owner: { type: 'string', description: 'The account or organization login that owns the repository' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    properties: {
      owner: { type: 'string', description: 'The account or organization login that owns the repository' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, newest first',
    properties: {
      owner: { type: 'string', description: 'The account or organization login that owns the repository' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all (default open)' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch',
    properties: {
      owner: { type: 'string', description: 'The account or organization login that owns the repository' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
      body: { type: 'string', description: 'The pull request body' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request into its base branch',
    properties: {
      owner: { type: 'string', description: 'The account or organization login that owns the repository' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'close_issue',
    description: 'Close an issue by number',
    properties: {
      owner: { type: 'string', description: 'The account or organization login that owns the repository' },
      repo: { type: 'string', description: 'The repository name' },
      issue_number: { type: 'number', description: 'The issue number' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue',
    properties: {
      owner: { type: 'string', description: 'The account or organization login that owns the repository' },
      repo: { type: 'string', description: 'The repository name' },
      issue_number: { type: 'number', description: 'The issue number' },
      body: { type: 'string', description: 'The comment body' },
    },
    required: ['owner', 'repo', 'issue_number', 'body'],
  },
];

/** The tools/list answer's tools array: a frozen literal, so two calls serialize byte for byte. */
const TOOLS: readonly Json[] = TOOL_DEFS.map((def) => ({
  name: def.name,
  title: def.name,
  description: def.description,
  inputSchema: { type: 'object', properties: { ...def.properties }, required: [...def.required] },
}));

// ---------------------------------------------------------------- tool execution

interface ToolOutcome {
  content: { type: string; text: string }[];
  isError: boolean;
}

function okResult(value: unknown): ToolOutcome {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function errorResult(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function normalized(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A tool by exact name or by normalized suffix (a server prefix such as github__create_issue). */
function findTool(name: string): ToolDef | null {
  const want = normalized(name);
  if (want === '') return null;
  for (const def of TOOL_DEFS) if (normalized(def.name) === want) return def;
  for (const def of TOOL_DEFS) {
    const have = normalized(def.name);
    if (want.length > have.length && want.endsWith(have)) return def;
  }
  return null;
}

function repoOf(forge: { repo(owner: string, name: string): ForgeRepo | undefined }, args: Json): { repo: ForgeRepo } | { error: string } {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = forge.repo(owner, name);
  if (repo === undefined) return { error: `Repository not found: ${owner}/${name}` };
  return { repo };
}

function numberArg(args: Json, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function stringArg(args: Json, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function runTool(forge: Forge, tool: ToolDef, args: Json): ToolOutcome {
  const viewer = forge.viewer();
  switch (tool.name) {
    case 'create_repo': {
      const name = stringArg(args, 'name');
      if (name === null || name === '') return errorResult('create_repo requires a repository name');
      const description = stringArg(args, 'description') ?? '';
      const isPrivate = args.private === true;
      const existing = forge.repo(viewer.login, name);
      if (existing !== undefined) {
        existing.description = description;
        existing.isPrivate = isPrivate;
        return okResult(repoJson(existing));
      }
      const repo = forge.createRepo(viewer.login, name, description, isPrivate, 'main');
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const found = repoOf(forge, args);
      if ('error' in found) return errorResult(found.error);
      return okResult(repoJson(found.repo));
    }
    case 'create_issue': {
      const found = repoOf(forge, args);
      if ('error' in found) return errorResult(found.error);
      const title = stringArg(args, 'title');
      if (title === null || title === '') return errorResult('create_issue requires a title');
      const result = createIssueIn(found.repo, viewer, { title, body: args.body });
      if ('error' in result) return errorResult(result.error);
      return okResult(issueJson(found.repo, result.issue));
    }
    case 'list_issues': {
      const found = repoOf(forge, args);
      if ('error' in found) return errorResult(found.error);
      const state = stringArg(args, 'state') ?? 'open';
      const issues = found.repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      issues.sort((a, b) => b.number - a.number);
      return okResult(issues.map((issue) => issueJson(found.repo, issue)));
    }
    case 'create_pull_request': {
      const found = repoOf(forge, args);
      if ('error' in found) return errorResult(found.error);
      const result = createPullIn(found.repo, viewer, { head: args.head, base: args.base, title: args.title, body: args.body });
      if ('error' in result) return errorResult(result.error);
      return okResult(pullJson(found.repo, result.pull));
    }
    case 'merge_pull_request': {
      const found = repoOf(forge, args);
      if ('error' in found) return errorResult(found.error);
      const number = numberArg(args, 'pull_number');
      if (number === null) return errorResult('merge_pull_request requires a pull_number');
      const pull = found.repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return errorResult(`Pull request #${number} not found`);
      const merged = mergePullIn(found.repo, pull, viewer);
      if (merged === null) return errorResult(`Pull request #${number} is not mergeable`);
      return okResult({ merged: true, sha: merged.sha, message: `Pull request #${number} successfully merged and closed`, number });
    }
    case 'close_issue': {
      const found = repoOf(forge, args);
      if ('error' in found) return errorResult(found.error);
      const number = numberArg(args, 'issue_number');
      if (number === null) return errorResult('close_issue requires an issue_number');
      const issue = found.repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return errorResult(`Issue #${number} not found`);
      setIssueStateIn(issue, 'closed');
      return okResult(issueJson(found.repo, issue));
    }
    case 'add_issue_comment': {
      const found = repoOf(forge, args);
      if ('error' in found) return errorResult(found.error);
      const number = numberArg(args, 'issue_number');
      if (number === null) return errorResult('add_issue_comment requires an issue_number');
      const body = stringArg(args, 'body');
      if (body === null) return errorResult('add_issue_comment requires a body');
      const issue = found.repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return errorResult(`Issue #${number} not found`);
      const id = found.repo.nextCommentId;
      found.repo.nextCommentId += 1;
      issue.comments.push({ id, body, user: viewer });
      return okResult({ id, body, issue_number: number });
    }
    default:
      return errorResult(`Tool ${tool.name} is not implemented`);
  }
}

// ---------------------------------------------------------------- JSON-RPC plumbing

function rpcResult(scope: RequestScope, id: unknown, result: unknown): void {
  sendJson(scope.res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(scope: RequestScope, status: number, id: unknown, code: number, message: string): void {
  sendJson(scope.res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

function accepted(scope: RequestScope): void {
  scope.res.writeHead(202, { 'x-mcp-accepted': 'true' });
  scope.res.end();
}

function discoverResult(): Json {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    resultType: 'discover',
    supportedVersions: [PREFERRED_REVISION, LEGACY_REVISION],
    capabilities: { tools: { listChanged: false } },
    instructions: 'GitHub-compatible forge tools over the shared store: repositories, issues and pull requests.',
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

function initializeResult(offered: unknown): Json {
  const revision = typeof offered === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : LEGACY_REVISION;
  return {
    protocolVersion: revision,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: 'GitHub-compatible forge tools over the shared store: repositories, issues and pull requests.',
  };
}

// ---------------------------------------------------------------- the endpoint

export async function tryServeMcp(scope: RequestScope): Promise<boolean> {
  const { res, forge, method, path } = scope;
  if (path !== '/mcp' && path !== '/mcp/') return false;
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (scope.token !== scope.validToken) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const body = await readBody(scope.req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    rpcError(scope, 400, null, -32700, 'Parse error: the request body is not valid JSON');
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    rpcError(scope, 400, null, -32600, 'Invalid Request: a JSON-RPC message must be an object');
    return true;
  }
  const message = parsed as Json;
  const rpcMethod = typeof message.method === 'string' ? message.method : null;
  if (rpcMethod === null) {
    rpcError(scope, 400, message.id ?? null, -32600, 'Invalid Request: the method is missing');
    return true;
  }
  const hasId = 'id' in message && message.id !== undefined;
  if (!hasId) {
    // A notification (notifications/initialized, cancelled, ...): accepted, no answer body.
    accepted(scope);
    return true;
  }
  const id = message.id;
  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Json) : {};

  switch (rpcMethod) {
    case 'initialize':
      rpcResult(scope, id, initializeResult(params.protocolVersion));
      return true;
    case 'server/discover':
      rpcResult(scope, id, discoverResult());
      return true;
    case 'tools/list':
      rpcResult(scope, id, { tools: TOOLS });
      return true;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = findTool(toolName);
      if (tool === null) {
        rpcError(scope, 200, id, -32602, `Unknown tool: ${toolName === '' ? '(no name given)' : toolName}`);
        return true;
      }
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Json) : {};
      const missing = tool.required.filter((key) => {
        const value = args[key];
        if (value === undefined || value === null) return true;
        if (typeof value === 'string' && value.trim() === '') return true;
        return false;
      });
      if (missing.length > 0) {
        rpcResult(scope, id, errorResult(`Missing required argument(s): ${missing.join(', ')}`));
        return true;
      }
      const outcome = runTool(forge, tool, args);
      rpcResult(scope, id, { content: outcome.content, isError: outcome.isError });
      return true;
    }
    case 'ping':
      rpcResult(scope, id, {});
      return true;
    default:
      rpcError(scope, 200, id, -32601, `Method not found: ${rpcMethod}`);
      return true;
  }
}
