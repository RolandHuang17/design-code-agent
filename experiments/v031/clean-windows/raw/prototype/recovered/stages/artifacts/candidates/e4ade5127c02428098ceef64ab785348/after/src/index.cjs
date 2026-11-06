'use strict';

const { createServer } = require('./app.cjs');

/**
 * Executable startup entry.
 *
 * FR3: listens on process.env.PORT, default 3000.
 * Kept separate from the exported server factory so tests do not start an
 * uncontrolled fixed-port server.
 */
const port = Number.parseInt(process.env.PORT, 10);
const PORT = Number.isNaN(port) ? 3000 : port;

const server = createServer();

server.listen(PORT, () => {
  console.log(`Health service listening on port ${PORT}`);
});