'use strict';

const { createHealthServer } = require('./app.cjs');

/**
 * Startup entrypoint (FR3).
 *
 * Imports the server factory (which does not bind a port itself) and listens
 * on process.env.PORT, defaulting to 3000. Keeping the factory separate from
 * this executable file lets tests bind an ephemeral loopback port without
 * starting an uncontrolled fixed-port server.
 */
const port = Number.parseInt(process.env.PORT ?? '', 10);
const PORT = Number.isInteger(port) && port > 0 ? port : 3000;

const server = createHealthServer();

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Health service listening on port ${PORT}`);
});