'use strict';

const http = require('http');

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function requestHandler(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

/**
 * Create an HTTP server configured with the health route handler.
 * Does not start listening; the caller decides when/where to listen.
 *
 * @returns {http.Server}
 */
function createServer() {
  return http.createServer(requestHandler);
}

module.exports = { createServer };