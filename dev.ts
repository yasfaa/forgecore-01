// A local dev runner: start the forge on a fixed port without the suite conversation, so the kit's
// SDK runner can drive it directly. Not part of the entry — the trial runs main.ts.

import { createApp } from './app.ts';

const port = Number(process.env.DEV_PORT ?? 8107);
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[dev] forge on http://127.0.0.1:${port}\n`);
});
