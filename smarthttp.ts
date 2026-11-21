// Git smart HTTP: the two services over /{owner}/{repo}.git.
//
//   GET  /info/refs?service=...   ref advertisement. upload-pack speaks protocol v2 when the client
//                                 sends Git-Protocol: version=2, v0 otherwise; receive-pack is v0.
//   POST /git-upload-pack         v2 ls-refs and fetch (or the v0 want/have flow).
//   POST /git-receive-pack        v0 update commands plus a packfile, answered with report-status.
//
// Packs are built and parsed in pack.ts, pkt-line framing in pktline.ts. Objects live in the forge
// store, so a pushed pack becomes loose objects every other surface reads back. A missing
// repository is a 404 on both services and the server stays up through any malformed request.

import { readBody, sendError } from './httpx.ts';
import { isAncestor, parseCommit, parseTree, type ForgeRepo, type GitObject } from './forge.ts';
import { decodePktStream, flushPkt, pktData, sidebandFrames, type Pkt } from './pktline.ts';
import { buildPack, peelRef, readPackFile, tagTargetOf } from './pack.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'agent=forgecore/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const V0_UPLOAD_CAPS = 'side-band-64k ofs-delta thin-pack shallow multi_ack_detailed multi_ack';
const V0_RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

function respond(res: import('node:http').ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------------------------
// memoized git responses
//
// Every entry below is keyed by bytes that only depend on store content — ref tips, the default
// branch and the fetch request's own arguments — so two runs of the same request sequence build
// the same entries and serve byte-identical responses. Objects in the store are immutable and
// refs only move, so a response memoized under one ref stamp stays correct until the stamp (which
// is part of the key) changes.
// ---------------------------------------------------------------------------------------------

/** One stamp of a repository's ref state: the default branch and every ref tip. */
function refsStamp(repo: ForgeRepo): string {
  let stamp = repo.defaultBranch;
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, sha] of refs) stamp += `|${name} ${sha}`;
  return stamp;
}

const MEMO_CAP = 128;

/** A memo keyed by (repo, stamp, request); old entries drop off once the map outgrows its cap. */
function memoGet<T>(map: Map<string, T>, key: string): T | undefined {
  const hit = map.get(key);
  if (hit !== undefined) {
    // Refresh insertion order so a hot entry is never the one evicted.
    map.delete(key);
    map.set(key, hit);
  }
  return hit;
}

function memoPut<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > MEMO_CAP) {
    const oldest = map.keys().next().value;
    if (typeof oldest === 'string') map.delete(oldest);
  }
}

/** True when the client asked for protocol v2 with the Git-Protocol header. */
function wantsProtocolV2(headerValue: string | string[] | undefined): boolean {
  if (typeof headerValue !== 'string') return false;
  return headerValue.split(/[;,\s]+/).some((token) => token.trim() === 'version=2');
}

export async function tryServeSmartHttp(scope: import('./app.ts').RequestScope): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(scope.path);
  if (match === null) return false;
  const repo = scope.forge.repo(match[1]!, match[2]!);
  if (repo === undefined) {
    sendError(scope.res, 404, `repository ${match[1]}/${match[2]} not found`);
    return true;
  }
  const tail = match[3]!;
  if (tail === 'info/refs') {
    if (scope.method !== 'GET') {
      sendError(scope.res, 405, 'info/refs answers GET only');
      return true;
    }
    const service = scope.query.get('service');
    if (service === 'git-upload-pack') serveInfoRefsUpload(scope, repo);
    else if (service === 'git-receive-pack') serveInfoRefsReceive(scope, repo);
    else sendError(scope.res, 404, 'unknown service');
    return true;
  }
  if (tail === 'git-upload-pack') {
    if (scope.method !== 'POST') {
      sendError(scope.res, 405, 'git-upload-pack answers POST only');
      return true;
    }
    await serveUploadPack(scope, repo);
    return true;
  }
  if (tail === 'git-receive-pack') {
    if (scope.method !== 'POST') {
      sendError(scope.res, 405, 'git-receive-pack answers POST only');
      return true;
    }
    await serveReceivePack(scope, repo);
    return true;
  }
  sendError(scope.res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function refLines(repo: ForgeRepo, caps: string): Buffer[] {
  const headSha = repo.headSha();
  const refs = [...repo.refs.entries()];
  const lines: Buffer[] = [];
  const withCaps = (line: string): Buffer => pktData(headLine(line, caps));
  const headLine = (line: string, capsLine: string): string => `${line}\u0000${capsLine}\n`;
  if (refs.length === 0) {
    lines.push(pktData(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    return lines;
  }
  if (headSha !== null) lines.push(withCaps(`${headSha} HEAD`));
  else {
    const [first, ...rest] = refs;
    lines.push(withCaps(`${first![1]} ${first![0]}`));
    for (const [name, sha] of rest) lines.push(pktData(`${sha} ${name}\n`));
    return lines;
  }
  for (const [name, sha] of refs) lines.push(pktData(`${sha} ${name}\n`));
  return lines;
}

function serveInfoRefsUpload(scope: import('./app.ts').RequestScope, repo: ForgeRepo): void {
  const v2 = wantsProtocolV2(scope.req.headers['git-protocol']);
  const memoKey = `u${v2 ? '2' : '0'}|${refsStamp(repo)}`;
  const cached = memoGet(uploadAdvertMemo, memoKey);
  if (cached !== undefined) {
    respond(scope.res, 200, UPLOAD_ADVERTISEMENT, cached);
    return;
  }
  let body: Buffer;
  if (v2) {
    body = Buffer.concat([
      pktData('version 2\n'),
      pktData(`${AGENT}\n`),
      pktData('ls-refs=unborn\n'),
      pktData('fetch=shallow\n'),
      pktData('object-format=sha1\n'),
      pktData('server-option\n'),
      flushPkt(),
    ]);
  } else {
    const caps = `${V0_UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch} ${AGENT}`;
    body = Buffer.concat([pktData('# service=git-upload-pack\n'), flushPkt(), ...refLines(repo, caps), flushPkt()]);
  }
  memoPut(uploadAdvertMemo, memoKey, body);
  respond(scope.res, 200, UPLOAD_ADVERTISEMENT, body);
}

const uploadAdvertMemo = new Map<string, Buffer>();

function serveInfoRefsReceive(scope: import('./app.ts').RequestScope, repo: ForgeRepo): void {
  const memoKey = refsStamp(repo);
  const cached = memoGet(receiveAdvertMemo, memoKey);
  if (cached !== undefined) {
    respond(scope.res, 200, RECEIVE_ADVERTISEMENT, cached);
    return;
  }
  const caps = `${V0_RECEIVE_CAPS} ${AGENT}`;
  const body = Buffer.concat([
    pktData('# service=git-receive-pack\n'),
    flushPkt(),
    ...refLines(repo, caps),
    flushPkt(),
  ]);
  memoPut(receiveAdvertMemo, memoKey, body);
  respond(scope.res, 200, RECEIVE_ADVERTISEMENT, body);
}

const receiveAdvertMemo = new Map<string, Buffer>();

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

/** A v2 request split at its delim-pkt: the command line, then the argument lines. */
interface UploadRequest {
  readonly command: string;
  readonly args: string[];
  readonly extra: Buffer;
}

function parseUploadRequest(packets: readonly Pkt[], rest: Buffer): UploadRequest {
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload!.toString('utf8');
    if (!afterDelim) {
      if (command === '') command = line.trim();
    } else {
      args.push(line.trim());
    }
  }
  return { command, args, extra: rest };
}

/** A request's `command=<name>` line names the command; a bare name is a v0-style body. */
function commandOf(line: string): string {
  return line.startsWith('command=') ? line.slice('command='.length) : line;
}

function serveUploadPack(scope: import('./app.ts').RequestScope, repo: ForgeRepo): Promise<void> {
  return readBody(scope.req).then(
    (body) => {
      let decoded;
      try {
        decoded = decodePktStream(body);
      } catch (err) {
        sendError(scope.res, 400, err instanceof Error ? err.message : 'malformed pkt-line');
        return;
      }
      const request = parseUploadRequest(decoded.packets, decoded.rest);
      const command = commandOf(request.command);
      if (command === 'ls-refs') serveLsRefs(scope, repo, request.args);
      else if (command === 'fetch') serveFetch(scope, repo, request.args);
      else if (command.startsWith('want ')) serveUploadPackV0(scope, repo, decoded);
      else sendError(scope.res, 400, `unknown upload-pack command ${JSON.stringify(command.slice(0, 60))}`);
    },
    (err: unknown) => sendError(scope.res, 400, err instanceof Error ? err.message : 'unreadable request body'),
  );
}

function serveLsRefs(scope: import('./app.ts').RequestScope, repo: ForgeRepo, args: readonly string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const stamp = refsStamp(repo);
  const memoKey = `ls|${stamp}|${peel ? 'p' : ''}${symrefs ? 's' : ''}${unborn ? 'u' : ''}|${prefixes.join('\u0001')}`;
  const cached = memoGet(lsRefsMemo, memoKey);
  if (cached !== undefined) {
    respond(scope.res, 200, UPLOAD_RESULT, cached);
    return;
  }
  const out: Buffer[] = [];
  const headSha = repo.headSha();
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (keep('HEAD')) {
    if (headSha !== null) {
      out.push(pktData(`${headSha} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      out.push(pktData(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const [name, sha] of repo.refs) {
    if (!keep(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const peeled = peelRef(repo, sha);
      if (peeled !== null && peeled !== sha) line += ` peeled:${peeled}`;
    }
    out.push(pktData(`${line}\n`));
  }
  out.push(flushPkt());
  const body = Buffer.concat(out);
  memoPut(lsRefsMemo, memoKey, body);
  respond(scope.res, 200, UPLOAD_RESULT, body);
}

const lsRefsMemo = new Map<string, Buffer>();

// ---------------------------------------------------------------------------------------------
// fetch object selection
// ---------------------------------------------------------------------------------------------

/** Every object the client claims to hold: the closure of its haves, stopping at its shallow boundary. */
function closureOf(repo: ForgeRepo, tips: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.readObject(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!stopAt.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const target = tagTargetOf(object.data);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

interface FetchSelection {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * The objects a fetch sends: commits from the wants (depth-limited when the client asks for a
 * shallow fetch, cut at the client's shallow boundary), then the full tree/blob closure of every
 * sent commit, minus everything the client's haves already reach.
 */
function selectFetchObjects(
  repo: ForgeRepo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | null,
  since: number | null,
  deepenNot: readonly string[],
): FetchSelection {
  const shallowSet = new Set(shallowIn);
  const notSet = new Set(deepenNot);
  const taken = closureOf(repo, haves, shallowSet);
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];

  // Resolve want chains: a tag object's target commit joins the walk; tag objects themselves are
  // sent when the client does not hold them.
  const tagWants: string[] = [];
  const commitRoots: { oid: string; depth: number }[] = [];
  const queued = new Set<string>();
  for (const want of wants) {
    let oid = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = repo.readObject(oid);
      if (object === undefined || object.type === 'blob' || object.type === 'tree') break;
      if (object.type === 'tag') {
        if (!queued.has(oid)) {
          queued.add(oid);
          tagWants.push(oid);
        }
        const target = tagTargetOf(object.data);
        if (target === null) break;
        oid = target;
        continue;
      }
      if (!queued.has(oid)) {
        queued.add(oid);
        commitRoots.push({ oid, depth: 1 });
      }
      break;
    }
  }

  // The commit walk: BFS by generation, want is generation 1; generation `depth` is the boundary.
  const commitOrder: string[] = [];
  const treeRoots: string[] = [];
  let head = 0;
  while (head < commitRoots.length) {
    const { oid, depth: generation } = commitRoots[head++]!;
    const held = taken.has(oid);
    const object = repo.readObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (!held) {
      taken.add(oid);
      commitOrder.push(oid);
      treeRoots.push(commit.tree);
    }
    expandCommit(oid, generation, commit, held);
  }

  // A boundary commit the client will receive (or already marks shallow) becomes its new shallow
  // edge; one the client fully holds is already interior history, no line needed.
  function expandCommit(oid: string, generation: number, commit: ReturnType<typeof parseCommit>, held: boolean): void {
    if (notSet.has(oid)) return;
    const atBoundary =
      (depth !== null && generation >= depth) ||
      (since !== null && commit.committer.when > 0 && commit.committer.when < since);
    if (atBoundary) {
      if (!held || shallowSet.has(oid)) shallowOut.push(oid);
      return;
    }
    if (shallowSet.has(oid)) unshallowOut.push(oid);
    for (const parent of commit.parents) {
      if (!queued.has(parent)) {
        queued.add(parent);
        commitRoots.push({ oid: parent, depth: generation + 1 });
      }
    }
  }

  // Tag objects first, then commits, then the tree/blob closure — order inside a pack is free.
  const objects: GitObject[] = [];
  for (const oid of tagWants) {
    if (taken.has(oid)) continue;
    const object = repo.readObject(oid);
    if (object === undefined || object.type !== 'tag') continue;
    taken.add(oid);
    objects.push(object);
  }
  for (const oid of commitOrder) {
    const object = repo.readObject(oid);
    if (object !== undefined) objects.push(object);
  }
  const stack = [...treeRoots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (taken.has(oid)) continue;
    const object = repo.readObject(oid);
    if (object === undefined) continue;
    taken.add(oid);
    objects.push(object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.sha);
    }
  }
  return { objects, shallow: shallowOut, unshallow: unshallowOut };
}

// ---------------------------------------------------------------------------------------------
// fetch response
// ---------------------------------------------------------------------------------------------

function serveFetch(scope: import('./app.ts').RequestScope, repo: ForgeRepo, args: readonly string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | null = null;
  let since: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5));
    else if (arg.startsWith('have ')) haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) shallowIn.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('deepen-since ')) since = Number.parseInt(arg.slice(13), 10);
    else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice(11));
    else if (arg === 'done') done = true;
    // thin-pack, no-progress, ofs-delta, agent, object-format and filter shape the reply we
    // already send; nothing to act on here.
  }

  const acks = Buffer.concat([pktData('acknowledgments\n'), pktData('NAK\n'), flushPkt()]);
  if (!done || wants.length === 0) {
    respond(scope.res, 200, UPLOAD_RESULT, acks);
    return;
  }
  // The reply is a pure function of the request's wants/haves/depth arguments and the immutable
  // objects those name, so it memoizes under the request arguments plus the repo's ref stamp.
  const memoKey = `f2|${refsStamp(repo)}|w${wants.join(',')}|h${haves.join(',')}|d${depth}|si${since}|sh${shallowIn.join(',')}|dn${deepenNot.join(',')}`;
  const cached = memoGet(fetchMemo, memoKey);
  if (cached !== undefined) {
    respond(scope.res, 200, UPLOAD_RESULT, cached);
    return;
  }
  const selection = selectFetchObjects(repo, wants, haves, shallowIn, depth, since, deepenNot);
  const pack = buildPack(selection.objects);
  const parts: Buffer[] = [acks];
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktData('shallow-info\n'));
    for (const sha of selection.shallow) parts.push(pktData(`shallow ${sha}\n`));
    for (const sha of selection.unshallow) parts.push(pktData(`unshallow ${sha}\n`));
    parts.push(flushPkt());
  }
  parts.push(pktData('packfile\n'), ...sidebandFrames(pack, 1), flushPkt());
  const body = Buffer.concat(parts);
  memoPut(fetchMemo, memoKey, body);
  respond(scope.res, 200, UPLOAD_RESULT, body);
}

const fetchMemo = new Map<string, Buffer>();

// ---------------------------------------------------------------------------------------------
// upload-pack v0 fallback
// ---------------------------------------------------------------------------------------------

/**
 * The v0 want/have flow, for a client that never sent Git-Protocol: version=2: wants and caps in
 * the first pkt-line section, haves and done in the second, and the answer framed through
 * side-band-64k when the client requested it (it always does here, the capability is advertised).
 */
function serveUploadPackV0(scope: import('./app.ts').RequestScope, repo: ForgeRepo, decoded: { packets: readonly Pkt[]; rest: Buffer }): void {
  const wants: string[] = [];
  const shallowIn: string[] = [];
  const firstPass: { haves: string[]; done: boolean } = { haves: [], done: false };
  let depth: number | null = null;
  let caps = '';
  const readSection = (packets: readonly Pkt[], pass: 'wants' | 'haves'): void => {
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      const line = packet.payload!.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\u0000');
      const text = nul >= 0 ? line.slice(0, nul) : line;
      if (nul >= 0 && caps === '') caps = line.slice(nul + 1).trim();
      if (pass === 'wants') {
        const want = /^want ([0-9a-f]{40})/.exec(text);
        if (want !== null) wants.push(want[1]!);
        else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8));
        else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
      } else if (text.startsWith('have ')) firstPass.haves.push(text.slice(5));
      else if (text === 'done') firstPass.done = true;
    }
  };
  readSection(decoded.packets, 'wants');
  if (decoded.rest.length > 0) {
    try {
      readSection(decodePktStream(decoded.rest).packets, 'haves');
    } catch {
      // A second section that does not parse cleanly still ends the negotiation below.
    }
  }
  if (wants.length === 0) {
    respond(scope.res, 200, UPLOAD_RESULT, Buffer.concat([pktData('NAK\n'), flushPkt()]));
    return;
  }
  if (!firstPass.done) {
    respond(scope.res, 200, UPLOAD_RESULT, Buffer.concat([pktData('NAK\n'), flushPkt()]));
    return;
  }
  const sideband = caps.split(' ').includes('side-band-64k');
  const memoKey = `f0|${refsStamp(repo)}|${sideband ? 'sb' : 'raw'}|w${wants.join(',')}|h${firstPass.haves.join(',')}|d${depth}|sh${shallowIn.join(',')}`;
  const cached = memoGet(fetchMemo, memoKey);
  if (cached !== undefined) {
    respond(scope.res, 200, UPLOAD_RESULT, cached);
    return;
  }
  const selection = selectFetchObjects(repo, wants, firstPass.haves, shallowIn, depth, null, []);
  const pack = buildPack(selection.objects);
  const parts: Buffer[] = [pktData('NAK\n')];
  for (const sha of selection.shallow) parts.push(pktData(`shallow ${sha}\n`));
  if (sideband) parts.push(...sidebandFrames(pack, 1));
  else parts.push(flushPkt(), pack);
  const body = Buffer.concat(parts);
  memoPut(fetchMemo, memoKey, body);
  respond(scope.res, 200, UPLOAD_RESULT, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldSha: string;
  readonly newSha: string;
  readonly ref: string;
}

async function serveReceivePack(scope: import('./app.ts').RequestScope, repo: ForgeRepo): Promise<void> {
  const body = await readBody(scope.req);
  let packets: readonly Pkt[];
  let rest: Buffer;
  try {
    const decoded = decodePktStream(body);
    packets = decoded.packets;
    rest = decoded.rest;
  } catch (err) {
    sendError(scope.res, 400, err instanceof Error ? err.message : 'malformed pkt-line');
    return;
  }

  const commands: PushCommand[] = [];
  let caps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const raw = packet.payload!.toString('utf8');
    const nul = raw.indexOf('\u0000');
    const text = (nul >= 0 ? raw.slice(0, nul) : raw).replace(/\n$/, '');
    if (nul >= 0 && caps === '') caps = raw.slice(nul + 1).trim();
    if (text === '' || text.startsWith('shallow ')) continue;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);
    if (match !== null) commands.push({ oldSha: match[1]!, newSha: match[2]!, ref: match[3]! });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((command) => command.newSha !== ZERO_OID);
  if (updatesRef || rest.length > 0) {
    try {
      const objects = readPackFile(rest, (sha) => repo.readObject(sha));
      for (const object of objects) repo.writeObject(object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? null;
      if (command.newSha === ZERO_OID) {
        if (current === null) report.push(`ng ${command.ref} missing`);
        else {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}`);
        }
      } else if (command.oldSha === ZERO_OID) {
        // A create names no old tip to honor, so the ref just moves (a re-run's create over an
        // existing ref included); the fast-forward discipline governs explicit updates below.
        repo.refs.set(command.ref, command.newSha);
        report.push(`ok ${command.ref}`);
      } else if (isAncestor(repo, command.oldSha, command.newSha)) {
        repo.refs.set(command.ref, command.newSha);
        report.push(`ok ${command.ref}`);
      } else {
        report.push(`ng ${command.ref} non-fast-forward`);
      }
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error`);
  }

  const inner = Buffer.concat([...report.map((line) => pktData(`${line}\n`)), flushPkt()]);
  const out = caps.split(' ').includes('side-band-64k')
    ? Buffer.concat(sidebandFrames(inner, 1))
    : inner;
  respond(scope.res, 200, RECEIVE_RESULT, out);
}
