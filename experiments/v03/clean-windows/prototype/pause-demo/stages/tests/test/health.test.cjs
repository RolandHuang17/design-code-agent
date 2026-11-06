'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { createHealthServer } = require('../src/app.cjs');

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('/health returns 200, unknown route returns 404, then /health again returns 200', async (t) => {
  const server = createHealthServer();

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.close();
  });

  const address = server.address();
  const port = address.port;

  const health = await request(port, '/health');
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(JSON.parse(health.body), { status: 'ok' });

  const unknown = await request(port, '/does-not-exist');
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(typeof JSON.parse(unknown.body).error, 'string');

  const healthAgain = await request(port, '/health');
  assert.strictEqual(healthAgain.status, 200);
  assert.deepStrictEqual(JSON.parse(healthAgain.body), { status: 'ok' });
});