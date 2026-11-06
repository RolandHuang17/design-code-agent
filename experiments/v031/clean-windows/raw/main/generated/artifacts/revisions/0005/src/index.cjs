'use strict';

const { createServer } = require('./app.cjs');

const port = Number.parseInt(process.env.PORT, 10) || 3000;

const server = createServer();

server.listen(port, () => {
  console.log(`health service listening on port ${port}`);
});