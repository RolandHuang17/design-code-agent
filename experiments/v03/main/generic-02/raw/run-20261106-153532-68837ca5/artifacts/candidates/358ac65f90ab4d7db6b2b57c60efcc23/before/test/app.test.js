import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { handler } from '../src/app.js';

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = server.http.request(
      { method, path, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseJson(response) {
  return JSON.parse(response.body);
}

function withServer(t, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const http = server;
      const wrapped = { http, origin: `http://127.0.0.1:${addr.port}` };
      Promise.resolve(fn(wrapped))
        .then(() => server.close())
        .then(resolve)
        .catch((err) => server.close(() => reject(err)));
    });
    server.on('error', reject);
  });
}

async function post(server, body) {
  const response = await request(server, 'POST', '/api/convert', body);
  return response;
}

test('GET /health returns 200 with status ok', async () => {
  await withServer(null, async (server) => {
    const response = await request(server, 'GET', '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(parseJson(response), { status: 'ok' });
  });
});

test('POST /api/convert returns a valid conversion', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: 100, from: 'C', to: 'F' });
    assert.equal(response.status, 200);
    assert.deepEqual(parseJson(response), { value: 212, unit: 'F' });
  });
});

test('same-unit conversion preserves value without rounding', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: 451.25, from: 'F', to: 'F' });
    assert.equal(response.status, 200);
    assert.deepEqual(parseJson(response), { value: 451.25, unit: 'F' });
  });
});

test('rejects malformed JSON with 400', async () => {
  await withServer(null, async (server) => {
    const response = await request(server, 'POST', '/api/convert', '{not json');
    assert.equal(response.status, 400);
    const body = parseJson(response);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});

test('rejects a missing field with 400', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: 20, from: 'C' });
    assert.equal(response.status, 400);
    const body = parseJson(response);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});

test('rejects a nonnumeric value with 400', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: '20', from: 'C', to: 'F' });
    assert.equal(response.status, 400);
    const body = parseJson(response);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});

test('rejects a boolean value with 400', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: true, from: 'C', to: 'F' });
    assert.equal(response.status, 400);
    const body = parseJson(response);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});

test('rejects an unsupported unit with 400', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: 20, from: 'C', to: 'X' });
    assert.equal(response.status, 400);
    const body = parseJson(response);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});

test('rejects a value below absolute zero (same-unit) with 400', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: -1, from: 'K', to: 'K' });
    assert.equal(response.status, 400);
    const body = parseJson(response);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});

test('allows absolute-zero boundary values', async () => {
  await withServer(null, async (server) => {
    const response = await post(server, { value: -273.15, from: 'C', to: 'K' });
    assert.equal(response.status, 200);
    assert.deepEqual(parseJson(response), { value: 0, unit: 'K' });
  });
});

test('returns 404 for unknown paths', async () => {
  await withServer(null, async (server) => {
    const response = await request(server, 'GET', '/nope');
    assert.equal(response.status, 404);
  });
});