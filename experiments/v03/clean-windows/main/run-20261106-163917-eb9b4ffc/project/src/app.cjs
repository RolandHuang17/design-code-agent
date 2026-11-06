'use strict';

const http = require('node:http');

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Exported HTTP server factory. Returns an un-started node:http.Server.
 * The caller owns listen() and close().
 *
 * @returns {import('node:http').Server}
 */
function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  });
}

module.exports = { createServer };