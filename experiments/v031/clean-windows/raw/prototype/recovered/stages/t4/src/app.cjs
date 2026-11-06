'use strict';

const http = require('node:http');

/**
 * Create a stateless HTTP server factory.
 *
 * FR1: GET /health -> 200 {"status":"ok"}
 * FR2: any other route -> 404 JSON error
 *
 * The server does not bind to any port; the caller is responsible for
 * listening (startup entry or tests) on an ephemeral or fixed port.
 *
 * @returns {import('node:http').Server}
 */
function createServer() {
  return http.createServer((req, res) => {
    const method = req.method || 'GET';
    // The request path, excluding any query string.
    const path = (req.url || '/').split('?')[0];

    if (method === 'GET' && path === '/health') {
      const body = JSON.stringify({ status: 'ok' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    const body = JSON.stringify({
      status: 'error',
      error: 'Not Found',
    });
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  });
}

module.exports = { createServer };
