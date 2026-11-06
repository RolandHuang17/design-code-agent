'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../app.cjs');

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

function request(path, method = 'GET') {
  return fetch(`${baseUrl}${path}`, { method });
}

test('GET /health returns 200 with {"status":"ok"}', async () => {
  const res = await request('/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('unknown route returns 404 with JSON error', async () => {
  const res = await request('/nope');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { error: 'not found' });
});

test('GET /health still works after an unknown request', async () => {
  await request('/nope');
  const res = await request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});