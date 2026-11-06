'use strict';

/**
 * Shared in-process HTTP helper for Express-route tests.
 *
 * Express 4 middleware (expressInit), res.json() and res.send() all require a
 * real Node http.ServerResponse (setHeader/getHeader/end/...). Hand-rolled
 * mock response objects are brittle, so this module instead binds the Express
 * app to a real ephemeral HTTP server (port 0) and performs an actual in-process
 * request/response round trip via node:http. No external services are required,
 * so the default `npm test` runs without PostgreSQL, Redis, RabbitMQ,
 * Elasticsearch or a live identity provider.
 */

const http = require('node:http');

/**
 * Build a request helper bound to an Express app via a real ephemeral server.
 *
 * @param {import('express').Express} app
 * @returns {{ post(url, body, headers), get(url, headers), delete(url, headers), close() }}
 */
function createInvoker(app) {
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      // Unref the ephemeral listener so open test servers never keep the Node
      // process (and therefore `node --test`) alive after the suite finishes.
      server.unref();
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;

      function request(method, path, body, headers = {}) {
        return new Promise((res, rej) => {
          const payload = body === undefined || body === null ? null : JSON.stringify(body);
          const req = http.request(
            {
              host: '127.0.0.1',
              port: address.port,
              method,
              path,
              headers: Object.assign(
                payload === null
                  ? {}
                  : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
                headers,
              ),
            },
            (response) => {
              const chunks = [];
              response.on('data', (c) => chunks.push(c));
              response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let body = undefined;
                if (text) {
                  try {
                    body = JSON.parse(text);
                  } catch {
                    body = text;
                  }
                }
                res({ status: response.statusCode, body });
              });
            },
          );
          req.on('error', rej);
          if (payload !== null) req.write(payload);
          req.end();
        });
      }

      const invoker = {
        post: (path, body, headers) => request('POST', path, body, headers),
        put: (path, body, headers) => request('PUT', path, body, headers),
        get: (path, headers) => request('GET', path, undefined, headers),
        delete: (path, headers) => request('DELETE', path, undefined, headers),
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      };

      // Keep the base around for optional debugging.
      invoker.base = base;
      resolve(invoker);
    });
  });
}

module.exports = { createInvoker };