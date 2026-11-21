// GraphQL v4 endpoint — stub until the API module lands. Claims nothing so the router 404s.

import type { RequestScope } from './app.ts';

export async function tryServeGraphql(_scope: RequestScope): Promise<boolean> {
  return false;
}
