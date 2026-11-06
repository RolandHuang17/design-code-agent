'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before } = require('node:test');

const { createServer } = require('../src/app.cjs');

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
  });
}

test('GET /health returns 200 with JSON {"status":"ok"}', async () => {
  const res = await get('/health');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
});

test('unknown route returns 404 with a JSON error body', async () => {
  const res = await get('/does-not-exist');
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body);
  assert.ok(body.error);
});

test('service still answers /health after an unknown request', async () => {
  await get('/another-unknown');
  const res = await get('/health');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
});