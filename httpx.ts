// HTTP helpers every surface shares: JSON discipline, bearer auth and request-id headers. Every
// REST reply is application/json, never HTML, and carries a non-empty X-GitHub-Request-Id; an error
// carries a JSON body with a string message; a malformed JSON body answers 400.

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A request id that is unique within the process and never empty. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Answer with a JSON body. Extra headers ride along; the request id is always set. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = headers['x-github-request-id'] ?? nextRequestId();
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

/** GitHub's error shape: a JSON body whose message is a string. */
export function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' }, headers);
}

/** 204 with no body but with the request-id discipline. */
export function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, { 'x-github-request-id': headers['x-github-request-id'] ?? nextRequestId(), ...headers });
  res.end();
}

/** Read the whole request body as a Buffer, capped so a wild client cannot fill memory. */
export function readBody(req: IncomingMessage, capBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > capBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The parsed JSON body, or null when it is absent; malformed JSON throws MALFORMED. */
export class MalformedBody extends Error {}

export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new MalformedBody('Problems parsing JSON');
  }
}

/** The bearer token a request presents, or null when it presents none. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1]!.trim();
}

/** The URL's pathname and query of one request. */
export function splitUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}
