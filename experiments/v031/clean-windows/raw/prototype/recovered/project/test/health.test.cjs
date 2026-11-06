'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createServer } = require('../src/app.cjs');

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('health, unknown route, and health again over an ephemeral loopback port', async (t) => {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'server should have a bound address');
  const port = address.port;

  const health = await request(port, '/health');
  assert.equal(health.status, 200, 'health should return 200');
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });

  const unknown = await request(port, '/does-not-exist');
  assert.equal(unknown.status, 404, 'unknown route should return 404');
  const unknownBody = JSON.parse(unknown.body);
  assert.ok(unknownBody && typeof unknownBody === 'object', 'unknown route body should be JSON');

  const again = await request(port, '/health');
  assert.equal(again.status, 200, 'health should still return 200 after a 404');
  assert.deepEqual(JSON.parse(again.body), { status: 'ok' });

  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});