// Git smart HTTP — stub until the git module lands. Claims nothing so the router 404s.

import type { RequestScope } from './app.ts';

export async function tryServeSmartHttp(_scope: RequestScope): Promise<boolean> {
  return false;
}
