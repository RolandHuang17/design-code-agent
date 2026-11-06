import { createServer } from 'node:http';
import handler from './app.js';

const PORT = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isInteger(PORT) && PORT > 0 ? PORT : 3000;

const server = createServer(handler);

server.listen(port, () => {
  console.log(`Temperature converter listening on http://localhost:${port}`);
});