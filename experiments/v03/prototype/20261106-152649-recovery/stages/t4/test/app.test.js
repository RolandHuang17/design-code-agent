import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';

/**
 * Invoke the request handler with a minimal mock of the Node HTTP request
 * and response, without opening a listening server.
 */
function request(handler, { method = 'GET', url = '/', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = body == null ? [] : [Buffer.from(body)];

    const req = {
      method,
      url,
      // For async iteration used by readJsonBody.
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      }
    };

    const res = {
      statusCode: 0,
      headers: {},
      _body: Buffer.alloc(0),
      headersSent: false,
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        Object.assign(this.headers, headers);
        this.headersSent = true;
      },
      write(chunk) {
        if (!this.headersSent) this.headersSent = true;
        if (chunk) {
          this._body = Buffer.concat([this._body, Buffer.from(chunk)]);
        }
      },
      end(chunk) {
        if (chunk) {
          this._body = Buffer.concat([this._body, Buffer.from(chunk)]);
        }
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          body: this._body.toString('utf8'),
          json() {
            return JSON.parse(this.body);
          }
        });
      }
    };

    try {
      handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

const app = createApp;

test('GET /health returns 200 with status ok', async () => {
  const response = await request(app(), { method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('GET / returns 200 with text/html', async () => {
  const response = await request(app(), { method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.ok(
    response.headers['Content-Type'].includes('text/html'),
    `expected html content type, got ${response.headers['Content-Type']}`
  );
});

test('POST /api/convert returns 200 with converted value', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: JSON.stringify({ value: 100, from: 'C', to: 'F' })
  });
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.unit, 'F');
  assert.ok(Math.abs(result.value - 212) < 1e-9);
});

test('POST /api/convert with same unit returns 200 preserving value', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: JSON.stringify({ value: 50, from: 'C', to: 'C' })
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { value: 50, unit: 'C' });
});

test('POST /api/convert with missing field returns 400 with error', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: JSON.stringify({ value: 5, from: 'C' })
  });
  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});

test('POST /api/convert with nonnumeric value returns 400', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: JSON.stringify({ value: 'hot', from: 'C', to: 'F' })
  });
  assert.equal(response.statusCode, 400);
  assert.ok(response.json().error.length > 0);
});

test('POST /api/convert with boolean value returns 400', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: JSON.stringify({ value: true, from: 'C', to: 'F' })
  });
  assert.equal(response.statusCode, 400);
  assert.ok(response.json().error.length > 0);
});

test('POST /api/convert with unsupported unit returns 400', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: JSON.stringify({ value: 10, from: 'C', to: 'X' })
  });
  assert.equal(response.statusCode, 400);
  assert.ok(response.json().error.length > 0);
});

test('POST /api/convert below absolute zero returns 400', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: JSON.stringify({ value: -300, from: 'C', to: 'K' })
  });
  assert.equal(response.statusCode, 400);
  assert.ok(response.json().error.length > 0);
});

test('POST /api/convert with malformed JSON returns 400', async () => {
  const response = await request(app(), {
    method: 'POST',
    url: '/api/convert',
    body: '{ not valid json'
  });
  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});