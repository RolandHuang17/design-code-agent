'use strict';

const { createApp } = require('./app.cjs');

/**
 * FR3: Startup entry. Creates the app and listens on process.env.PORT,
 * defaulting to 3000. Kept separate from the exported server factory so
 * tests do not start an uncontrolled fixed-port server.
 */
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const server = createApp();

server.listen(PORT, () => {
  console.log(`Health service listening on port ${PORT}`);
});