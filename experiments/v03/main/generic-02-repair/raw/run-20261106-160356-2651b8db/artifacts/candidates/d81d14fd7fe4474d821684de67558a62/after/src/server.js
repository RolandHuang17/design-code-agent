import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import handler from './app.js';

export function resolvePort(env = {}) {
  const raw = env.PORT ?? '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3000;
}

export function startServer(port = resolvePort(process.env)) {
  const server = createServer(handler);
  server.listen(port, () => {
    console.log(`Temperature converter listening on http://localhost:${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  startServer();
}