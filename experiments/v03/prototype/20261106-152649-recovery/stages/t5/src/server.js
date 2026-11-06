import { createServer } from 'node:http';

import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

const server = createServer(createApp());

server.listen(PORT, host, () => {
  console.log(`Temperature converter listening on http://${host}:${PORT}`);
});