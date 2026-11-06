'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../app.cjs');

let server;
let baseUrl;

/**
 * NFR1: npm test runs real HTTP tests on an ephemeral loopback port,
 * checking health, unknown route and health again; close the server after.
 * We listen on port 0 so the OS assigns a random free ephemeral port.
 */
before(async () => {
  server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Small helper to perform a real HTTP GET and return { status, body, headers }. */
function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
  });
}

test('GET /health returns 200 and JSON { status: ok } (FR1)', async () => {
  const res = await request('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
});

test('unknown route returns 404 and a JSON error (FR2)', async () => {
  const res = await request('/unknown');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.headers['content-type'], 'application/json');
  const parsed = JSON.parse(res.body);
  assert.strictEqual(typeof parsed.error, 'string');
});

test('GET /health still returns 200 after an unknown request (FR2)', async () => {
  // First hit an unknown route, then confirm /health still works.
  const unknown = await request('/anything');
  assert.strictEqual(unknown.status, 404);

  const health = await request('/health');
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(JSON.parse(health.body), { status: 'ok' });
});