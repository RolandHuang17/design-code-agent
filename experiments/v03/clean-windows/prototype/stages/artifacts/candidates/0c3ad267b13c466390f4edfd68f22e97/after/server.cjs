'use strict';

const { createServer } = require('./app.cjs');

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

const server = createServer();

server.listen(PORT, () => {
  console.log(`Health service listening on port ${PORT}`);
});