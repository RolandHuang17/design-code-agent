'use strict';

const { createServer } = require('./app.cjs');

const port = Number.parseInt(process.env.PORT, 10);
const listenPort = Number.isInteger(port) && port > 0 ? port : 3000;

const server = createServer();

server.listen(listenPort, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : listenPort;
  console.log(`Health service listening on port ${boundPort}`);
});