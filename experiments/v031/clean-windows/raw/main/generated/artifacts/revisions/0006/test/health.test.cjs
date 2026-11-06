'use strict';

const http = require('http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../src/app.cjs');

let server;
let baseUrl;

before((t, done) => {
  server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

after((t, done) => {
  if (server && server.listening) {
    server.close(done);
  } else {
    done();
  }
});

function request(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
  });
}

test('GET /health returns 200 with JSON {"status":"ok"}', async () => {
  const { statusCode, headers, body } = await request('/health');
  assert.equal(statusCode, 200);
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(body), { status: 'ok' });
});

test('unknown route returns 404 with a JSON error', async () => {
  const { statusCode, headers, body } = await request('/unknown');
  assert.equal(statusCode, 404);
  assert.equal(headers['content-type'], 'application/json');
  const parsed = JSON.parse(body);
  assert.ok(parsed.error);
});

test('service still answers /health after an unknown request', async () => {
  await request('/unknown');
  const { statusCode, headers, body } = await request('/health');
  assert.equal(statusCode, 200);
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(body), { status: 'ok' });
});