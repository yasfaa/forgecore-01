// The forge's whole world: one process, one store, everything in memory. This file is the domain
// core every surface shares — the git smart-HTTP engine, the REST v3 API, GraphQL v4 and MCP all
// read and write through it, so a repository created over MCP is the same object REST serves and
// the same pack git pushes into.
//
// Git object model: loose objects held by sha1 in per-repo maps, exactly the content git's object
// format stores (blob bytes, tree entries, commit text), so pack parsing writes objects once and
// every API reads them back with no re-parse.

import { createHash } from 'node:crypto';
import { ORG_LOGIN, ORG_ID, USERS, VIEWER_LOGIN, type ForgeUser } from './scenario.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
  readonly when: number;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Identity;
  readonly committer: Identity;
  readonly message: string;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  readonly labels: Label[];
  readonly assignees: ForgeUser[];
  readonly user: ForgeUser;
  readonly comments: { id: number; body: string; user: ForgeUser }[];
  closedAt: number | null;
}

export type PullState = 'open' | 'closed' | 'merged';

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  state: PullState;
  readonly headRef: string;
  readonly baseRef: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  readonly user: ForgeUser;
}

/** One repository: refs, objects and the tracker data around them. */
export class ForgeRepo {
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly labels: Label[] = [];
  readonly issues: Issue[] = [];
  readonly pulls: PullRequest[] = [];
  nextIssueNumber = 0;
  nextPullNumber = 0;
  nextCommentId = 100;

  constructor(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string) {
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
  }

  fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The tip sha of a branch given bare ('main') or full ('refs/heads/main'). */
  branchTip(branch: string): string | null {
    const full = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    return this.refs.get(full) ?? null;
  }

  headSha(): string | null {
    return this.branchTip(this.defaultBranch);
  }

  readObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  writeObject(type: ObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  hasObject(sha: string): boolean {
    return this.objects.has(sha);
  }
}

/** sha1 of a git object: '<type> <byte length>\0' before the content. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

/** Every tree entry of a raw tree object, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0) break;
    const mode = data.subarray(at, space).toString();
    const name = data.subarray(space + 1, nul).toString();
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

/** A raw tree object from entries, in the order given. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse one commit object's header lines and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString();
  const lineEnd = text.indexOf('\n\n');
  const header = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const message = lineEnd < 0 ? '' : text.slice(lineEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Identity = { name: '', email: '', when: 0 };
  let committer: Identity = { name: '', email: '', when: 0 };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

function parseIdentity(text: string): Identity {
  const lt = text.lastIndexOf('<');
  const gt = text.lastIndexOf('>');
  const name = lt > 0 ? text.slice(0, lt).trim() : text;
  const email = lt >= 0 && gt > lt ? text.slice(lt + 1, gt) : '';
  const tail = gt >= 0 ? text.slice(gt + 1).trim().split(/\s+/) : [];
  const when = Number(tail[0] ?? 0) || 0;
  return { name, email, when };
}

/** A commit object's raw text from its parts. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: Identity;
  committer: Identity;
  message: string;
}): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identityLine(info.author)}`);
  lines.push(`committer ${identityLine(info.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}\n`);
}

function identityLine(id: Identity): string {
  return `${id.name} <${id.email}> ${id.when} +0000`;
}

/**
 * Apply file changes on top of a base tree and return the new root tree sha. A change names a path
 * with either a blob sha to set or null to remove; the tree is rebuilt from the flat file list,
 * bottom-up, so directories never carry stale or phantom entries.
 */
export function applyTreeChanges(
  repo: ForgeRepo,
  baseTreeSha: string | null,
  changes: readonly { path: string; blobSha: string | null; mode?: string }[],
): string {
  // Every file of the base tree, keyed by its full path.
  const files = new Map<string, { sha: string; mode: string }>();
  const collect = (treeSha: string, prefix: string): void => {
    const tree = repo.readObject(treeSha);
    if (tree === undefined) return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') collect(entry.sha, path);
      else files.set(path, { sha: entry.sha, mode: entry.mode });
    }
  };
  if (baseTreeSha !== null) collect(baseTreeSha, '');
  for (const change of changes) {
    if (change.blobSha === null) files.delete(change.path);
    else files.set(change.path, { sha: change.blobSha, mode: change.mode ?? '100644' });
  }
  // Build bottom-up: the deepest directories first, one tree object each.
  const cache = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      const parent = i === 1 ? '' : parts.slice(0, i - 1).join('/');
      const list = childrenOf.get(parent) ?? [];
      if (!list.includes(dir)) list.push(dir);
      childrenOf.set(parent, list);
      dirs.add(dir);
    }
  }
  const buildDir = (prefix: string): string => {
    const cached = cache.get(prefix);
    if (cached !== undefined) return cached;
    const entries: TreeEntry[] = [];
    for (const dir of (childrenOf.get(prefix) ?? []).sort()) entries.push({ mode: '40000', name: dir.slice(prefix === '' ? 0 : prefix.length + 1), sha: buildDir(dir) });
    for (const [path, file] of files) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent !== prefix) continue;
      entries.push({ mode: file.mode, name: path.slice(parent === '' ? 0 : parent.length + 1), sha: file.sha });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const sha = repo.writeObject('tree', buildTree(entries));
    cache.set(prefix, sha);
    return sha;
  };
  return buildDir('');
}

/** Walk one commit's whole tree and collect every blob path. */
export function treeFiles(repo: ForgeRepo, treeSha: string, prefix: string, out: { path: string; sha: string; mode: string }[]): void {
  const tree = repo.readObject(treeSha);
  if (tree === undefined) return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') treeFiles(repo, entry.sha, path, out);
    else out.push({ path, sha: entry.sha, mode: entry.mode });
  }
}

/** Resolve a path inside a tree: the entry it names, if it exists. */
export function treeEntry(repo: ForgeRepo, treeSha: string, path: string): TreeEntry | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = repo.readObject(current);
    if (tree === undefined) return null;
    const entry = parseTree(tree.data).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry;
    current = entry.sha;
  }
  return null;
}

/** Is `maybeAncestor` an ancestor of `sha` (or the same commit)? Walks first parents only — the suite's pushes are linear. */
export function isAncestor(repo: ForgeRepo, maybeAncestor: string | null, sha: string | null): boolean {
  if (maybeAncestor === null) return true;
  if (sha === null) return false;
  let current: string | null = sha;
  for (let depth = 0; current !== null && depth < 10_000; depth += 1) {
    if (current === maybeAncestor) return true;
    const commit = repo.readObject(current);
    if (commit === undefined || commit.type !== 'commit') return false;
    const parents = parseCommit(commit.data).parents;
    current = parents.length > 0 ? parents[0]! : null;
  }
  return false;
}

/**
 * A squash merge: the merged tree is the head tree re-applied over the base tree; a path both sides
 * changed since the merge base is a conflict. Returns the new commit sha on the base branch, or
 * null when the merge conflicts.
 */
export function squashMerge(repo: ForgeRepo, baseTip: string, headTip: string, message: string, user: ForgeUser): string | null {
  const baseCommit = repo.readObject(baseTip);
  const headCommit = repo.readObject(headTip);
  if (baseCommit === undefined || headCommit === undefined) return null;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const mergeBaseTip = mergeBase(repo, baseTip, headTip);
  let baseAtFork = baseTree;
  if (mergeBaseTip !== null) {
    const baseObj = repo.readObject(mergeBaseTip);
    if (baseObj !== undefined) baseAtFork = parseCommit(baseObj.data).tree;
  }
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  const forkFiles = new Map<string, string>();
  const collect = (tree: string, into: Map<string, string>): void => {
    const files: { path: string; sha: string; mode: string }[] = [];
    treeFiles(repo, tree, '', files);
    for (const file of files) into.set(file.path, file.sha);
  };
  collect(baseTree, baseFiles);
  collect(headTree, headFiles);
  collect(baseAtFork, forkFiles);
  const changes: { path: string; blobSha: string | null; mode?: string }[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const baseSha = baseFiles.get(path) ?? null;
    const headSha = headFiles.get(path) ?? null;
    const forkSha = forkFiles.get(path) ?? null;
    if (headSha === baseSha) continue;
    if (baseSha !== forkSha && headSha !== forkSha) return null; // both sides moved the path: conflict
    changes.push({ path, blobSha: headSha });
  }
  const tree = applyTreeChanges(repo, baseTree, changes);
  const when = 1_735_689_600;
  return repo.writeObject('commit', buildCommit({
    tree,
    parents: [baseTip],
    author: { name: user.name, email: user.email, when },
    committer: { name: user.name, email: user.email, when },
    message,
  }));
}

/** The best common ancestor of two commits: every ancestor of `a`, then breadth-first from `b` until one is met. */
export function mergeBase(repo: ForgeRepo, a: string, b: string): string | null {
  if (a === b) return a;
  const aAncestors = new Set<string>([a]);
  let frontier: string[] = [a];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      const commit = repo.readObject(sha);
      if (commit === undefined) continue;
      for (const parent of parseCommit(commit.data).parents) {
        if (!aAncestors.has(parent)) {
          aAncestors.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  const bSeen = new Set<string>([b]);
  frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (aAncestors.has(sha)) return sha;
      const commit = repo.readObject(sha);
      if (commit === undefined) continue;
      for (const parent of parseCommit(commit.data).parents) {
        if (!bSeen.has(parent)) {
          bSeen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** The forge's whole store: its users, its org, and every repository ever created. */
export class Forge {
  readonly users = new Map<string, ForgeUser>(USERS.map((user) => [user.login, user]));
  readonly repos = new Map<string, ForgeRepo>();
  readonly viewerLogin = VIEWER_LOGIN;
  readonly orgLogin = ORG_LOGIN;
  readonly orgId = ORG_ID;
  nextRepoId = 5000;

  user(login: string): ForgeUser | undefined {
    return this.users.get(login);
  }

  viewer(): ForgeUser {
    return this.users.get(VIEWER_LOGIN)!;
  }

  orgUser(): ForgeUser {
    return {
      id: ORG_ID,
      login: ORG_LOGIN,
      name: ORG_LOGIN,
      email: `${ORG_LOGIN}@example.invalid`,
    };
  }

  repo(owner: string, name: string): ForgeRepo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): ForgeRepo {
    const repo = new ForgeRepo(owner, name, description, isPrivate, defaultBranch);
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }
}
