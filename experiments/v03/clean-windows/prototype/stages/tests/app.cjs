'use strict';

const http = require('http');

/**
 * Request handler mapping:
 *   - GET /health  -> 200 JSON { status: 'ok' }
 *   - all others   -> 404 JSON error
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handler(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

/**
 * Create a new http.Server without binding a port.
 *
 * @returns {http.Server}
 */
function createServer() {
  return http.createServer(handler);
}

module.exports = { handler, createServer };