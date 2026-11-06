'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, HTML_PAGE } = require('../lib/app');

// Start an in-process listener bound to an ephemeral port so the HTTP routes
// can be exercised without a long-lived external server (NFR1).
function startServer() {
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function request(baseUrl, method, path, body) {
  const options = {
    method,
    headers: {},
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers: options.headers,
    body: body === undefined ? undefined : body,
  });
  return response;
}

async function json(response) {
  return response.json();
}

test('GET / returns HTML page with expected elements', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(baseUrl, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.equal(html, HTML_PAGE);
    assert.match(html, /type="number"/);
    assert.match(html, /<select[^>]*id="from"/);
    assert.match(html, /<select[^>]*id="to"/);
    assert.match(html, /type="submit"/);
    assert.match(html, /id="result"/);
    assert.match(html, /id="error"/);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert converts C to F with fractional result preserved', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(
      baseUrl,
      'POST',
      '/api/convert',
      JSON.stringify({ value: 100, from: 'C', to: 'F' }),
    );
    assert.equal(res.status, 200);
    const payload = await json(res);
    assert.equal(payload.unit, 'F');
    assert.equal(payload.value, 212);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert preserves fractional (non-integer) values', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(
      baseUrl,
      'POST',
      '/api/convert',
      JSON.stringify({ value: 0.5, from: 'C', to: 'F' }),
    );
    assert.equal(res.status, 200);
    const payload = await json(res);
    assert.equal(payload.unit, 'F');
    assert.equal(payload.value, 32.9);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert same-unit preserves the value', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(
      baseUrl,
      'POST',
      '/api/convert',
      JSON.stringify({ value: -40, from: 'F', to: 'F' }),
    );
    assert.equal(res.status, 200);
    const payload = await json(res);
    assert.equal(payload.value, -40);
    assert.equal(payload.unit, 'F');
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert rejects below absolute zero with 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(
      baseUrl,
      'POST',
      '/api/convert',
      JSON.stringify({ value: -500, from: 'C', to: 'F' }),
    );
    assert.equal(res.status, 400);
    const payload = await json(res);
    assert.equal(typeof payload.error, 'string');
    assert.ok(payload.error.length > 0);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert rejects malformed JSON with 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(baseUrl, 'POST', '/api/convert', '{not json');
    assert.equal(res.status, 400);
    const payload = await json(res);
    assert.equal(typeof payload.error, 'string');
    assert.ok(payload.error.length > 0);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert rejects missing fields with 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(
      baseUrl,
      'POST',
      '/api/convert',
      JSON.stringify({ from: 'C', to: 'F' }),
    );
    assert.equal(res.status, 400);
    const payload = await json(res);
    assert.equal(typeof payload.error, 'string');
    assert.ok(payload.error.length > 0);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert rejects boolean value with 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(
      baseUrl,
      'POST',
      '/api/convert',
      JSON.stringify({ value: true, from: 'C', to: 'F' }),
    );
    assert.equal(res.status, 400);
    const payload = await json(res);
    assert.equal(typeof payload.error, 'string');
    assert.ok(payload.error.length > 0);
  } finally {
    await closeServer(server);
  }
});

test('POST /api/convert rejects unsupported unit with 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(
      baseUrl,
      'POST',
      '/api/convert',
      JSON.stringify({ value: 20, from: 'C', to: 'R' }),
    );
    assert.equal(res.status, 400);
    const payload = await json(res);
    assert.equal(typeof payload.error, 'string');
    assert.ok(payload.error.length > 0);
  } finally {
    await closeServer(server);
  }
});

test('GET /health returns 200 {status:ok}', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await request(baseUrl, 'GET', '/health');
    assert.equal(res.status, 200);
    const payload = await json(res);
    assert.deepEqual(payload, { status: 'ok' });
  } finally {
    await closeServer(server);
  }
});