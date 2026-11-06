// Integration tests for the HTTP endpoints (FR1, FR2, FR4, FR5).
//
// These tests start the real HTTP server on an ephemeral port (port 0) and
// exercise it over the network via the built-in fetch API, so the routing,
// JSON parsing and absolute-zero validation in app.js are all covered.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../source/app.js';

let server;
let baseUrl;

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
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test('GET / serves an HTML page (FR1)', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<html/i, 'page should contain an <html> element');
  assert.match(html, /<input/i, 'page should contain a numeric input');
  assert.match(html, /<select/i, 'page should contain unit selectors');
  assert.match(html, /<button/i, 'page should contain a submit button');
});

test('GET /health returns { status: "ok" } (FR5)', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: 'ok' });
});

test('POST /api/convert converts C to F with 200 (FR2)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 100, from: 'C', to: 'F' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.value, 212);
  assert.equal(body.unit, 'F');
});

test('POST /api/convert converts K to C with 200 and does not round (FR2)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 273.15, from: 'K', to: 'C' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.value, 0);
  assert.equal(body.unit, 'C');
});

test('POST /api/convert preserves a decimal value (FR2)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 36.6, from: 'C', to: 'F' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // 36.6 C = (36.6 * 9 / 5) + 32 = 97.88 F; must not be rounded to an integer.
  assert.ok(Math.abs(body.value - 97.88) < 1e-9);
  assert.equal(body.unit, 'F');
});

test('POST /api/convert returns 400 for missing fields (FR4)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 100, from: 'C' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

test('POST /api/convert returns 400 for a nonnumeric value (FR4)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: '100', from: 'C', to: 'F' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

test('POST /api/convert returns 400 for a boolean value (FR4)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: true, from: 'C', to: 'F' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

test('POST /api/convert returns 400 for an unsupported unit (FR4)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 100, from: 'C', to: 'X' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

test('POST /api/convert returns 400 for a value below absolute zero (FR4)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: -273.16, from: 'C', to: 'C' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

test('POST /api/convert returns 400 for malformed JSON (FR4)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"value": 100, "from": "C",',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});

test('POST /api/convert returns 400 for a non-object body (FR4)', async () => {
  const res = await fetch(`${baseUrl}/api/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([100, 'C', 'F']),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.error === 'string' && body.error.length > 0);
});