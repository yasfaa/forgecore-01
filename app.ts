// The forge's HTTP surface: one server, four families of routes.
//
//   /{owner}/{repo}.git/...   git smart HTTP (smarthttp.ts)
//   /api/v3/...               the REST v3 API (rest.ts)
//   /api/graphql              GraphQL v4 (graphql.ts)
//   /mcp                      Model Context Protocol (mcp.ts)
//
// Routing is a dispatch table, not a framework: each family's handler claims the request it serves
// and answers it. The bearer token (MAKEFUN_SHOP_TOKEN) names the viewer; the API families refuse
// a request without one with 401, while git smart HTTP serves the protocol as git does.

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { Forge } from './forge.ts';
import { bearerToken, sendError, sendJson, splitUrl, MalformedBody } from './httpx.ts';
import { tryServeSmartHttp } from './smarthttp.ts';
import { tryServeRest } from './rest.ts';
import { tryServeGraphql } from './graphql.ts';
import { tryServeMcp } from './mcp.ts';

export const forge = new Forge();

export interface RequestScope {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** The bearer token, or null when the request presents none. */
  readonly token: string | null;
  /** The env's own token — the only credential the suite presents. */
  readonly validToken: string;
}

/** The token the suite presents, from the environment; a local default keeps dev runs answerable. */
export const VALID_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'forge-dev-token';

/** True when the request is allowed through: the token names the viewer, or git protocol serves. */
export function isAuthorized(scope: RequestScope): boolean {
  return scope.token === scope.validToken;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : String(err));
      else res.destroy();
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = splitUrl(req);
  const method = req.method ?? 'GET';
  const scope: RequestScope = {
    req,
    res,
    method,
    path,
    query,
    token: bearerToken(req),
    validToken: VALID_TOKEN,
  };

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  try {
    // Git smart HTTP serves on its path without the bearer discipline git itself does not use.
    if (await tryServeSmartHttp(scope)) return;
    // Everything below is the token's world.
    if (await tryServeRest(scope)) return;
    if (await tryServeGraphql(scope)) return;
    if (await tryServeMcp(scope)) return;
    sendError(res, 404, 'Not Found');
  } catch (err) {
    if (err instanceof MalformedBody) {
      sendError(res, 400, err.message);
      return;
    }
    throw err;
  }
}
