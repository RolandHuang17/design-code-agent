'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/app.cjs');

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('health service: /health, unknown route, then /health again', async (t) => {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'server bound to an address');
  const port = address.port;

  const health = await request(port, 'GET', '/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });

  const missing = await request(port, 'GET', '/does-not-exist');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(missing.body), { error: 'Not Found' });

  const healthAgain = await request(port, 'GET', '/health');
  assert.equal(healthAgain.statusCode, 200);
  assert.deepEqual(JSON.parse(healthAgain.body), { status: 'ok' });
});