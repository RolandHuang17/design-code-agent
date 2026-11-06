'use strict';

const { createApp } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;

const server = createApp();

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Temperature converter listening on port ${PORT}`);
});

module.exports = server;