'use strict';

const http = require('http');

/**
 * Create a health-check HTTP server using the built-in http module.
 *
 * The returned server is not bound to a port; callers (e.g. the startup
 * entry point or tests) are responsible for calling .listen().
 *
 * FR1: GET /health returns HTTP 200 with JSON {"status":"ok"}.
 * FR2: Unknown routes return HTTP 404 with a JSON error.
 *
 * @returns {http.Server}
 */
function createHealthServer() {
  return http.createServer((req, res) => {
    const { method, url } = req;

    if (method === 'GET' && url === '/health') {
      const body = JSON.stringify({ status: 'ok' });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    const body = JSON.stringify({ error: 'Not Found' });
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  });
}

module.exports = { createHealthServer };