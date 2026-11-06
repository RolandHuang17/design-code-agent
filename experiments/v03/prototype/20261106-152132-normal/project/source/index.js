// Entry point: starts the HTTP server on process.env.PORT (default 3000).
// See NFR2.
import { createApp } from './app.js';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

const app = createApp();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Temperature converter listening on http://localhost:${PORT}`);
});