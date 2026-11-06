'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createServer } = require('../app.cjs');

// Bind the factory server to an ephemeral loopback port so tests run against a
// real HTTP listener without occupying a fixed port or using mocks.
const server = createServer();
let baseUrl;

test.after(() => {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test.before(() => {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}${path}`,
      { headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
  });
}

test('GET /health returns 200 with JSON { status: ok }', async () => {
  const res = await request('/health');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
});

test('unknown route returns 404 with a JSON error', async () => {
  const res = await request('/nope');

  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);

  const parsed = JSON.parse(res.body);
  assert.equal(typeof parsed.error, 'string');
  assert.ok(parsed.error.length > 0);
});

test('GET /health still returns 200 after an unknown request', async () => {
  // Perform the unknown request against the same live server first.
  await request('/again-unknown');

  const res = await request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
});