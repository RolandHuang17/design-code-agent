'use strict';

const http = require('node:http');

/**
 * Stateless request handler.
 * GET /health -> 200 JSON {"status":"ok"}
 * any other route -> 404 JSON error body
 */
function requestHandler(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({ status: 'ok' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  const body = JSON.stringify({ error: 'Not Found' });
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Builds an http.Server from the injected request handler.
 * Does not listen; the caller decides the port.
 *
 * @param {Function} [handler] - optional request handler, defaults to requestHandler
 * @returns {http.Server}
 */
function createServer(handler = requestHandler) {
  return http.createServer(handler);
}

module.exports = {
  createServer,
  requestHandler,
};