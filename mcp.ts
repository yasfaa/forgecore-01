// MCP endpoint — stub until the API module lands. Claims nothing so the router 404s.

import type { RequestScope } from './app.ts';

export async function tryServeMcp(_scope: RequestScope): Promise<boolean> {
  return false;
}
