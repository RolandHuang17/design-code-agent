'use strict';

const http = require('node:http');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Create an HTTP server for the minimal health service.
 *
 * Routes:
 *   - GET /health  -> 200 {"status":"ok"}
 *   - anything else -> 404 {"error":"not found"}
 *
 * The handler is stateless: any request, including unknown routes,
 * is fully answered inline and never affects subsequent requests.
 *
 * @returns {http.Server}
 */
function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify({ status: 'ok' });
      res.writeHead(200, JSON_HEADERS);
      res.end(body);
      return;
    }

    const body = JSON.stringify({ error: 'not found' });
    res.writeHead(404, JSON_HEADERS);
    res.end(body);
  });
}

module.exports = { createServer };