'use strict';

const http = require('http');

/**
 * Create an HTTP server factory handling the health endpoint and 404 JSON.
 * FR1: GET /health -> 200 and JSON { "status": "ok" }
 * FR2: Unknown routes -> 404 and a JSON error; service still answers /health after.
 *
 * @returns {http.Server} A Node.js HTTP server (not yet listening).
 */
function createApp() {
  return http.createServer((req, res) => {
    const url = req.url || '';
    const path = url.split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

module.exports = { createApp };