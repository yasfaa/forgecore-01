// GraphQL v4 at POST /api/graphql: a small hand-rolled engine — tokenizer, recursive-descent
// parser, and a schema-driven executor for the types gh and github-mcp-server read (viewer,
// repository, issues and their connections with states/order/cursor paging, pull requests and
// their files, node(id:) with inline fragments, __type introspection, and the createIssue /
// closeIssue / createPullRequest / mergePullRequest / addComment mutations).
//
// Wire rules: a request without the suite's bearer token is exactly 401; a GraphQL-level failure
// (an unknown field, a bad argument) is HTTP 200 whose body carries an `errors` array; an unknown
// repository answers data.repository = null with no errors; a JSON array body of operation
// documents (GitHub's operation batching) answers an array of per-operation bodies in order.
// Global ids are opaque base64 round-trips, stable across reads and shared with the REST surface.

import type { RequestScope } from './app.ts';
import { parseJsonBody, readBody, sendError, sendJson } from './httpx.ts';
import type { Forge, ForgeRepo, Issue, PullRequest } from './forge.ts';
import { VIEWER_LOGIN, type ForgeUser } from './scenario.ts';
import { createIssueIn, createPullIn, mergePullIn, pullFilesDiff, repoIdOf } from './rest.ts';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- the document model

interface FieldSel {
  kind: 'field';
  alias: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: Selection[] | null;
}

interface FragSpread {
  kind: 'spread';
  name: string;
}

interface InlineFrag {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSel | FragSpread | InlineFrag;

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'enum'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'obj'; fields: { name: string; value: ValueNode }[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

interface GraphQLErrorEntry {
  message: string;
}

// ---------------------------------------------------------------- tokenizer

interface Tok {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  text: string;
}

const PUNCT_SINGLE = new Set(['{', '}', '(', ')', '[', ']', ':', '=', '!', '$', '@']);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.') {
      if (src.slice(i, i + 3) !== '...') throw new Error(`GraphQL syntax error at offset ${i}: unexpected '.'`);
      toks.push({ kind: 'punct', text: '...' });
      i += 3;
      continue;
    }
    if (PUNCT_SINGLE.has(c)) {
      toks.push({ kind: 'punct', text: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let text = '';
      i += 1;
      for (;;) {
        if (i >= src.length) throw new Error('GraphQL syntax error: unterminated string');
        const ch = src[i]!;
        if (ch === '"') {
          i += 1;
          break;
        }
        if (ch === '\\') {
          const esc = src[i + 1];
          i += 2;
          if (esc === undefined) throw new Error('GraphQL syntax error: unterminated escape');
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === 'b') text += '\b';
          else if (esc === 'f') text += '\f';
          else if (esc === 'u') {
            const hex = src.slice(i, i + 4);
            i += 4;
            const code = Number.parseInt(hex, 16);
            if (!Number.isFinite(code)) throw new Error('GraphQL syntax error: bad unicode escape');
            text += String.fromCharCode(code);
          } else text += esc; // \" \\ \/
          continue;
        }
        text += ch;
        i += 1;
      }
      toks.push({ kind: 'string', text });
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let end = i + 1;
      while (end < src.length && src[end]! >= '0' && src[end]! <= '9') end += 1;
      let isFloat = false;
      if (src[end] === '.') {
        isFloat = true;
        end += 1;
        while (end < src.length && src[end]! >= '0' && src[end]! <= '9') end += 1;
      }
      if (src[end] === 'e' || src[end] === 'E') {
        isFloat = true;
        end += 1;
        if (src[end] === '+' || src[end] === '-') end += 1;
        while (end < src.length && src[end]! >= '0' && src[end]! <= '9') end += 1;
      }
      const text = src.slice(i, end);
      toks.push({ kind: isFloat ? 'float' : 'int', text });
      i = end;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let end = i + 1;
      while (end < src.length) {
        const d = src[end]!;
        if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9') || d === '_') end += 1;
        else break;
      }
      toks.push({ kind: 'name', text: src.slice(i, end) });
      i = end;
      continue;
    }
    throw new Error(`GraphQL syntax error at offset ${i}: unexpected ${JSON.stringify(c)}`);
  }
  return toks;
}

// ---------------------------------------------------------------- parser

class GraphQLSyntaxError extends Error {}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok | undefined {
    return this.toks[this.pos++];
  }

  private expectPunct(text: string): void {
    const tok = this.next();
    if (tok === undefined || tok.kind !== 'punct' || tok.text !== text) {
      throw new GraphQLSyntaxError(`GraphQL syntax error: expected ${JSON.stringify(text)}`);
    }
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok === undefined || tok.kind !== 'name' || (value !== undefined && tok.text !== value)) {
      throw new GraphQLSyntaxError(`GraphQL syntax error: expected ${value ?? 'a name'}`);
    }
    return tok.text;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    for (;;) {
      const tok = this.peek();
      if (tok === undefined) break;
      if (tok.kind === 'name' && (tok.text === 'query' || tok.text === 'mutation')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (tok.kind === 'name' && tok.text === 'fragment') {
        const def = this.parseFragment();
        fragments.set(def.name, def);
        continue;
      }
      if (tok.kind === 'punct' && tok.text === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLSyntaxError(`GraphQL syntax error: unexpected ${JSON.stringify(tok.text)}`);
    }
    if (operations.length === 0) throw new GraphQLSyntaxError('GraphQL syntax error: the document holds no operation');
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const type = this.expectName() as 'query' | 'mutation';
    let name: string | null = null;
    const tok = this.peek();
    if (tok !== undefined && tok.kind === 'name') name = this.expectName();
    this.parseVariableDefs();
    return { type, name, selections: this.parseSelectionSet() };
  }

  private parseVariableDefs(): void {
    const tok = this.peek();
    if (tok === undefined || tok.kind !== 'punct' || tok.text !== '(') return;
    this.next();
    while (this.peek() !== undefined) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      const eq = this.peek();
      if (eq !== undefined && eq.kind === 'punct' && eq.text === '=') {
        this.next();
        this.parseValue();
      }
      const sep = this.peek();
      if (sep !== undefined && sep.kind === 'punct' && sep.text === ',') {
        this.next();
        continue;
      }
      if (sep !== undefined && sep.kind === 'punct' && sep.text === ')') break;
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    const tok = this.next();
    if (tok === undefined) throw new GraphQLSyntaxError('GraphQL syntax error: expected a type');
    if (tok.kind === 'punct' && tok.text === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (tok.kind !== 'name') {
      throw new GraphQLSyntaxError('GraphQL syntax error: expected a type name');
    }
    const bang = this.peek();
    if (bang !== undefined && bang.kind === 'punct' && bang.text === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok === undefined) throw new GraphQLSyntaxError('GraphQL syntax error: unterminated selection set');
      if (tok.kind === 'punct' && tok.text === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const tok = this.next();
    if (tok === undefined) throw new GraphQLSyntaxError('GraphQL syntax error: expected a selection');
    if (tok.kind === 'punct' && tok.text === '...') {
      const word = this.peek();
      if (word !== undefined && word.kind === 'name' && word.text === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: this.expectName() };
    }
    if (tok.kind !== 'name') throw new GraphQLSyntaxError('GraphQL syntax error: expected a field');
    let name = tok.text;
    let alias = name;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.text === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const sub = this.peek();
    const selections = sub !== undefined && sub.kind === 'punct' && sub.text === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const tok = this.peek();
    if (tok === undefined || tok.kind !== 'punct' || tok.text !== '(') return [];
    this.next();
    const args: { name: string; value: ValueNode }[] = [];
    for (;;) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
      const sep = this.peek();
      if (sep !== undefined && sep.kind === 'punct' && sep.text === ',') {
        this.next();
        continue;
      }
      if (sep !== undefined && sep.kind === 'punct' && sep.text === ')') break;
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok === undefined) throw new GraphQLSyntaxError('GraphQL syntax error: expected a value');
    if (tok.kind === 'punct' && tok.text === '$') return { kind: 'var', name: this.expectName() };
    if (tok.kind === 'int' || tok.kind === 'float') return { kind: 'lit', value: Number(tok.text) };
    if (tok.kind === 'string') return { kind: 'lit', value: tok.text };
    if (tok.kind === 'name') {
      if (tok.text === 'true') return { kind: 'lit', value: true };
      if (tok.text === 'false') return { kind: 'lit', value: false };
      if (tok.text === 'null') return { kind: 'lit', value: null };
      return { kind: 'enum', name: tok.text };
    }
    if (tok.kind === 'punct' && tok.text === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        const inner = this.peek();
        if (inner === undefined) throw new GraphQLSyntaxError('GraphQL syntax error: unterminated list');
        if (inner.kind === 'punct' && inner.text === ']') {
          this.next();
          break;
        }
        if (inner.kind === 'punct' && inner.text === ',') {
          this.next();
          continue;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.text === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      for (;;) {
        const inner = this.peek();
        if (inner === undefined) throw new GraphQLSyntaxError('GraphQL syntax error: unterminated object');
        if (inner.kind === 'punct' && inner.text === '}') {
          this.next();
          break;
        }
        if (inner.kind === 'punct' && inner.text === ',') {
          this.next();
          continue;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'obj', fields };
    }
    throw new GraphQLSyntaxError('GraphQL syntax error: unexpected token in a value position');
  }
}

// ---------------------------------------------------------------- schema introspection data

const OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'comments', 'labels', 'assignees', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'isFork', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'sshUrl', 'cloneUrl', 'visibility'],
  User: ['id', 'login', 'name', 'email', 'url', 'createdAt'],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['endCursor', 'hasNextPage', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['addComment', 'closeIssue', 'createIssue', 'createPullRequest', 'mergePullRequest'],
  IssueConnection: ['edges', 'nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['edges', 'nodes', 'pageInfo', 'totalCount'],
  ChangedFileConnection: ['edges', 'nodes', 'pageInfo', 'totalCount'],
  ChangedFile: ['path', 'additions', 'deletions'],
  IssueEdge: ['cursor', 'node'],
  PullRequestEdge: ['cursor', 'node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  __Type: ['description', 'enumValues', 'fields', 'kind', 'name', 'specifiedByURL'],
  __Field: ['description', 'name', 'type'],
  __EnumValue: ['description', 'name'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeDescriptor(name: string): Json | null {
  const fields = OBJECT_FIELDS[name];
  if (fields !== undefined) return { kind: 'OBJECT', name, fields: fields.map((field) => ({ name: field })), enumValues: [] };
  const values = ENUM_VALUES[name];
  if (values !== undefined) return { kind: 'ENUM', name, fields: [], enumValues: values.map((value) => ({ name: value })) };
  return null;
}

// ---------------------------------------------------------------- execution

interface Ctx {
  readonly forge: Forge;
  readonly viewer: ForgeUser;
  readonly errors: GraphQLErrorEntry[];
  readonly fragments: Map<string, FragmentDef>;
}

function pushError(ctx: Ctx, message: string): void {
  ctx.errors.push({ message });
}

const ISO_EPOCH = '2025-01-01T00:00:00Z';

/** An opaque, stable global id: base64 of `<kind>:<owner>/<name>[:<number>]`. */
function gidOf(kind: string, repo: ForgeRepo, n?: number): string {
  const text = n === undefined ? `${kind}:${repo.fullName()}` : `${kind}:${repo.fullName()}:${n}`;
  return Buffer.from(text, 'utf8').toString('base64');
}

interface DecodedGid {
  kind: string;
  owner: string;
  name: string;
  n: number | null;
}

function decodeGid(id: unknown): DecodedGid | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (text === '') return null;
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const tail = rest.indexOf(':', slash);
  const full = tail < 0 ? rest : rest.slice(0, tail);
  const nStr = tail < 0 ? null : rest.slice(tail + 1);
  const n = nStr === null || nStr === '' ? null : Number.parseInt(nStr, 10);
  return { kind, owner: full.slice(0, slash), name: full.slice(slash + 1), n: n !== null && Number.isFinite(n) ? n : null };
}

function repoFromGid(ctx: Ctx, id: unknown): ForgeRepo | null {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  return ctx.forge.repo(decoded.owner, decoded.name) ?? null;
}

interface IssueRaw {
  repo: ForgeRepo;
  issue: Issue;
}

interface PullRaw {
  repo: ForgeRepo;
  pull: PullRequest;
}

function issueFromGid(ctx: Ctx, id: unknown): IssueRaw | null {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'I' || decoded.n === null) return null;
  const repo = ctx.forge.repo(decoded.owner, decoded.name);
  if (repo === undefined) return null;
  const issue = repo.issues.find((candidate) => candidate.number === decoded.n);
  return issue === undefined ? null : { repo, issue };
}

function pullFromGid(ctx: Ctx, id: unknown): PullRaw | null {
  const decoded = decodeGid(id);
  if (decoded === null || decoded.kind !== 'P' || decoded.n === null) return null;
  const repo = ctx.forge.repo(decoded.owner, decoded.name);
  if (repo === undefined) return null;
  const pull = repo.pulls.find((candidate) => candidate.number === decoded.n);
  return pull === undefined ? null : { repo, pull };
}

function pullStateName(pull: PullRequest): string {
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
}interface ConnectionRaw {
  elemType: string;
  nodes: unknown[];
  hasNextPage: boolean;
  endCursor: string;
  totalCount: number;
}

function issuesConnection(repo: ForgeRepo, args: Record<string, unknown>): ConnectionRaw {
  const states = Array.isArray(args.states) ? args.states.map((state) => String(state).toUpperCase()) : ['OPEN'];
  const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as Json) : {};
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction.toUpperCase() : 'DESC';
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 30;
  const list = repo.issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const cursor = Number.parseInt(args.after, 10);
    if (Number.isFinite(cursor)) {
      const index = list.findIndex((issue) => issue.number === cursor);
      if (index >= 0) start = index + 1;
    }
  }
  const slice = list.slice(start, start + first);
  const last = slice[slice.length - 1];
  return {
    elemType: 'Issue',
    nodes: slice.map((issue) => ({ repo, issue })),
    hasNextPage: start + slice.length < list.length,
    endCursor: last === undefined ? '' : String(last.number),
    totalCount: list.length,
  };
}

function pullsConnection(repo: ForgeRepo, args: Record<string, unknown>): ConnectionRaw {
  const states = Array.isArray(args.states) ? args.states.map((state) => String(state).toUpperCase()) : ['OPEN'];
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 30;
  const list = repo.pulls.filter((pull) => states.includes(pullStateName(pull)));
  const slice = list.slice(0, first);
  const last = slice[slice.length - 1];
  return {
    elemType: 'PullRequest',
    nodes: slice.map((pull) => ({ repo, pull })),
    hasNextPage: slice.length < list.length,
    endCursor: last === undefined ? '' : String(last.number),
    totalCount: list.length,
  };
}

type Resolved = { value: unknown; type: string | null } | undefined;

function queryField(field: string, args: Record<string, unknown>, ctx: Ctx): Resolved {
  switch (field) {
    case 'viewer':
      return { value: { login: ctx.viewer.login, name: ctx.viewer.name }, type: 'User' };
    case 'repository': {
      const repo = ctx.forge.repo(String(args.owner ?? ''), String(args.name ?? ''));
      return { value: repo ?? null, type: 'Repository' };
    }
    case 'node': {
      const decoded = decodeGid(args.id);
      if (decoded === null) return { value: null, type: null };
      if (decoded.kind === 'R') {
        const repo = ctx.forge.repo(decoded.owner, decoded.name);
        if (repo !== undefined) return { value: repo, type: 'Repository' };
      }
      return { value: null, type: null };
    }
    case '__type': {
      const descriptor = typeDescriptor(String(args.name ?? ''));
      return { value: descriptor, type: '__Type' };
    }
    default:
      return undefined;
  }
}

function mutationField(field: string, args: Record<string, unknown>, ctx: Ctx): Resolved {
  const input = typeof args.input === 'object' && args.input !== null ? (args.input as Json) : {};
  switch (field) {
    case 'createIssue': {
      const repo = repoFromGid(ctx, input.repositoryId);
      if (repo === null) {
        pushError(ctx, 'Could not resolve a repository from input.repositoryId');
        return { value: null, type: null };
      }
      const result = createIssueIn(repo, ctx.viewer, { title: input.title, body: input.body });
      if ('error' in result) {
        pushError(ctx, result.error);
        return { value: null, type: null };
      }
      return { value: { issue: { repo, issue: result.issue } }, type: 'CreateIssuePayload' };
    }
    case 'closeIssue': {
      const found = issueFromGid(ctx, input.issueId);
      if (found === null) {
        pushError(ctx, 'Could not resolve an issue from input.issueId');
        return { value: null, type: null };
      }
      found.issue.state = 'closed';
      found.issue.closedAt = 1_735_689_600;
      return { value: { issue: found }, type: 'CloseIssuePayload' };
    }
    case 'createPullRequest': {
      const repo = repoFromGid(ctx, input.repositoryId);
      if (repo === null) {
        pushError(ctx, 'Could not resolve a repository from input.repositoryId');
        return { value: null, type: null };
      }
      const result = createPullIn(repo, ctx.viewer, { head: input.headRefName, base: input.baseRefName, title: input.title, body: input.body ?? '' });
      if ('error' in result) {
        pushError(ctx, result.error);
        return { value: null, type: null };
      }
      return { value: { pullRequest: { repo, pull: result.pull } }, type: 'CreatePullRequestPayload' };
    }
    case 'mergePullRequest': {
      const found = pullFromGid(ctx, input.pullRequestId);
      if (found === null) {
        pushError(ctx, 'Could not resolve a pull request from input.pullRequestId');
        return { value: null, type: null };
      }
      const merged = mergePullIn(found.repo, found.pull, ctx.viewer);
      if (merged === null) pushError(ctx, `Pull request #${found.pull.number} is not mergeable`);
      return { value: { pullRequest: found }, type: 'MergePullRequestPayload' };
    }
    case 'addComment': {
      const found = issueFromGid(ctx, input.subjectId);
      if (found === null) {
        pushError(ctx, 'Could not resolve an issue from input.subjectId');
        return { value: null, type: null };
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const id = found.repo.nextCommentId;
      found.repo.nextCommentId += 1;
      found.issue.comments.push({ id, body, user: ctx.viewer });
      const node = { id: gidOf('C', found.repo, id), body };
      return { value: { commentEdge: { node } }, type: 'AddCommentPayload' };
    }
    default:
      return undefined;
  }
}

function repositoryField(field: string, repo: ForgeRepo, args: Record<string, unknown>, ctx: Ctx): Resolved {
  switch (field) {
    case 'id':
      return { value: gidOf('R', repo), type: null };
    case 'databaseId':
      return { value: repoIdOf(repo), type: null };
    case 'name':
      return { value: repo.name, type: null };
    case 'nameWithOwner':
      return { value: repo.fullName(), type: null };
    case 'description':
      return { value: repo.description, type: null };
    case 'owner':
      return { value: { login: repo.owner }, type: 'User' };
    case 'defaultBranchRef':
      return { value: { name: repo.defaultBranch }, type: 'Ref' };
    case 'viewerPermission':
      return { value: 'ADMIN', type: null };
    case 'hasIssuesEnabled':
      return { value: true, type: null };
    case 'isPrivate':
      return { value: repo.isPrivate, type: null };
    case 'isFork':
      return { value: false, type: null };
    case 'createdAt':
    case 'updatedAt':
    case 'pushedAt':
      return { value: ISO_EPOCH, type: null };
    case 'url':
      return { value: `https://forge.local/${repo.fullName()}`, type: null };
    case 'sshUrl':
      return { value: `git@forge.local:${repo.fullName()}.git`, type: null };
    case 'cloneUrl':
      return { value: `https://forge.local/${repo.fullName()}.git`, type: null };
    case 'visibility':
      return { value: repo.isPrivate ? 'PRIVATE' : 'PUBLIC', type: null };
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return { value: issue === undefined ? null : { repo, issue }, type: 'Issue' };
    }
    case 'issues':
      return { value: issuesConnection(repo, args), type: 'IssueConnection' };
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return { value: pull === undefined ? null : { repo, pull }, type: 'PullRequest' };
    }
    case 'pullRequests':
      return { value: pullsConnection(repo, args), type: 'PullRequestConnection' };
    default:
      return undefined;
  }
}

function issueField(field: string, raw: IssueRaw, ctx: Ctx): Resolved {
  const { repo, issue } = raw;
  switch (field) {
    case 'id':
      return { value: gidOf('I', repo, issue.number), type: null };
    case 'number':
      return { value: issue.number, type: null };
    case 'title':
      return { value: issue.title, type: null };
    case 'state':
      return { value: issue.state.toUpperCase(), type: null };
    case 'body':
      return { value: issue.body ?? '', type: null };
    case 'author':
      return { value: { login: issue.user.login, name: issue.user.name }, type: 'User' };
    case 'createdAt':
    case 'updatedAt':
      return { value: ISO_EPOCH, type: null };
    case 'closedAt':
      return { value: issue.state === 'closed' ? ISO_EPOCH : null, type: null };
    case 'url':
      return { value: `https://forge.local/${repo.fullName()}/issues/${issue.number}`, type: null };
    case 'comments':
      return { value: issue.comments.length, type: null };
    case 'labels':
      return { value: issue.labels.map((label) => ({ name: label.name, color: label.color })), type: null };
    case 'assignees':
      return { value: issue.assignees.map((assignee) => ({ login: assignee.login })), type: null };
    case 'repository':
      return { value: repo, type: 'Repository' };
    default:
      void ctx;
      return undefined;
  }
}

function pullField(field: string, raw: PullRaw, args: Record<string, unknown>, ctx: Ctx): Resolved {
  const { repo, pull } = raw;
  switch (field) {
    case 'id':
      return { value: gidOf('P', repo, pull.number), type: null };
    case 'number':
      return { value: pull.number, type: null };
    case 'title':
      return { value: pull.title, type: null };
    case 'body':
      return { value: pull.body ?? '', type: null };
    case 'state':
      return { value: pullStateName(pull), type: null };
    case 'merged':
      return { value: pull.merged, type: null };
    case 'headRefName':
      return { value: pull.headRef, type: null };
    case 'baseRefName':
      return { value: pull.baseRef, type: null };
    case 'mergeable':
      return { value: 'MERGEABLE', type: null };
    case 'files': {
      const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 20;
      const diff = pullFilesDiff(repo, pull).slice(0, first);
      return { value: { elemType: 'ChangedFile', nodes: diff.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })), totalCount: diff.length }, type: 'ChangedFileConnection' };
    }
    case 'author':
      return { value: { login: pull.user.login, name: pull.user.name }, type: 'User' };
    case 'createdAt':
    case 'updatedAt':
      return { value: ISO_EPOCH, type: null };
    case 'mergedAt':
    case 'closedAt':
      return { value: pull.state !== 'open' ? ISO_EPOCH : null, type: null };
    case 'url':
      return { value: `https://forge.local/${repo.fullName()}/pulls/${pull.number}`, type: null };
    default:
      void ctx;
      return undefined;
  }
}

function connectionField(field: string, raw: unknown): Resolved {
  const connection = raw as ConnectionRaw;
  switch (field) {
    case 'nodes':
      return { value: connection.nodes, type: connection.elemType };
    case 'edges':
      return {
        value: connection.nodes.map((node, index) => ({ cursor: String(index + 1), node })),
        type: `${connection.elemType}Edge`,
      };
    case 'pageInfo':
      return { value: { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor }, type: 'PageInfo' };
    case 'totalCount':
      return { value: connection.totalCount, type: null };
    default:
      return undefined;
  }
}

function resolveField(typeName: string, field: string, raw: unknown, args: Record<string, unknown>, ctx: Ctx): Resolved {
  switch (typeName) {
    case 'Query':
      return queryField(field, args, ctx);
    case 'Mutation':
      return mutationField(field, args, ctx);
    case 'Repository':
      return repositoryField(field, raw as ForgeRepo, args, ctx);
    case 'Issue':
      return issueField(field, raw as IssueRaw, ctx);
    case 'PullRequest':
      return pullField(field, raw as PullRaw, args, ctx);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'ChangedFileConnection':
      return connectionField(field, raw);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return field === 'issue' ? { value: (raw as Json).issue, type: 'Issue' } : undefined;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return field === 'pullRequest' ? { value: (raw as Json).pullRequest, type: 'PullRequest' } : undefined;
    case 'AddCommentPayload':
      return field === 'commentEdge' ? { value: (raw as Json).commentEdge, type: 'CommentEdge' } : undefined;
    case '__Type':
      if (field === 'fields') return { value: (raw as Json).fields, type: '__Field' };
      if (field === 'enumValues') return { value: (raw as Json).enumValues, type: '__EnumValue' };
      break;
    default:
      break;
  }
  // Plain objects of scalars (PageInfo, User, Ref, ChangedFile, IssueComment, __Field, ...).
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Json;
    if (field in record) return { value: record[field], type: null };
  }
  return undefined;
}

function coerceValue(node: ValueNode, vars: Record<string, unknown>, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'var':
      if (node.name in vars) return vars[node.name];
      pushError(ctx, `Variable "$${node.name}" has no value provided`);
      return null;
    case 'enum':
      return node.name;
    case 'list':
      return node.items.map((item) => coerceValue(item, vars, ctx));
    case 'obj': {
      const out: Json = {};
      for (const entry of node.fields) out[entry.name] = coerceValue(entry.value, vars, ctx);
      return out;
    }
    default:
      return node.value;
  }
}

function executeSelections(selections: Selection[], typeName: string, raw: unknown, vars: Record<string, unknown>, ctx: Ctx): Json {
  const out: Json = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(sel.selections, typeName, raw, vars, ctx));
      continue;
    }
    if (sel.kind === 'spread') {
      const fragment = ctx.fragments.get(sel.name);
      if (fragment === undefined) {
        pushError(ctx, `Unknown fragment "${sel.name}"`);
        continue;
      }
      if (fragment.typeCondition !== null && fragment.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(fragment.selections, typeName, raw, vars, ctx));
      continue;
    }
    if (sel.name === '__typename') {
      out[sel.alias] = typeName;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of sel.args) args[arg.name] = coerceValue(arg.value, vars, ctx);
    const resolved = resolveField(typeName, sel.name, raw, args, ctx);
    if (resolved === undefined) {
      pushError(ctx, `Cannot query field "${sel.name}" on type "${typeName}".`);
      continue;
    }
    let value = resolved.value;
    if (value === undefined) value = null;
    if (sel.selections === null) {
      out[sel.alias] = value;
      continue;
    }
    if (value === null) {
      out[sel.alias] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[sel.alias] = value.map((item) => (item === null || item === undefined ? null : executeSelections(sel.selections!, resolved.type ?? 'plain', item, vars, ctx)));
      continue;
    }
    out[sel.alias] = executeSelections(sel.selections, resolved.type ?? 'plain', value, vars, ctx);
  }
  return out;
}

function runOperation(entry: Json, forge: Forge): Json {
  const query = typeof entry.query === 'string' ? entry.query : '';
  const vars = typeof entry.variables === 'object' && entry.variables !== null ? (entry.variables as Record<string, unknown>) : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  const ctx: Ctx = { forge, viewer: forge.viewer(), errors: [], fragments: new Map() };
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  ctx.fragments = document.fragments;
  let operation: Operation | undefined;
  if (operationName !== null) operation = document.operations.find((candidate) => candidate.name === operationName);
  else operation = document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: `No operation named "${operationName ?? ''}" in the document` }] };
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selections, rootType, null, vars, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------- the endpoint

export async function tryServeGraphql(scope: RequestScope): Promise<boolean> {
  const { res, forge } = scope;
  if (scope.path !== '/api/graphql') return false;
  if (scope.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (scope.token !== scope.validToken) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const body = parseJsonBody(await readBody(scope.req));
  if (Array.isArray(body)) {
    const results = body.map((entry) => (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? runOperation(entry as Json, forge) : { data: null, errors: [{ message: 'A batched operation must be a JSON object' }] }));
    sendJson(res, 200, results);
    return true;
  }
  if (body !== null && typeof body === 'object' && typeof (body as Json).query === 'string') {
    sendJson(res, 200, runOperation(body as Json, forge));
    return true;
  }
  sendError(res, 400, 'The GraphQL body must be {"query", "variables"} or an array of operations');
  return true;
}

export { VIEWER_LOGIN };
