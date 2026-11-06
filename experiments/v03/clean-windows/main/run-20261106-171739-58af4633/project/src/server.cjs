'use strict';

// Executable startup entry. Kept separate from the exported app factory
// (src/app.cjs) so tests can import and drive the server without starting an
// uncontrolled fixed-port listener.

const { createServer } = require('./app.cjs');

const port = Number.parseInt(process.env.PORT, 10) || 3000;

const server = createServer();

server.listen(port, () => {
  console.log(`health service listening on port ${port}`);
});