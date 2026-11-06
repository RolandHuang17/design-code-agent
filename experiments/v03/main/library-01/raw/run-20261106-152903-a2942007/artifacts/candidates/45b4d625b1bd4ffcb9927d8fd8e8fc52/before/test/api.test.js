'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../src/app');
const { MemoryRepository } = require('../src/memoryRepository');

/**
 * HTTP API tests against the route layer (FR1-FR5, NFR1 at the API boundary).
 *
 * `createApp` receives the in-memory repository, so these tests run without a
 * live PostgreSQL while still exercising the real Express wiring, JSON parsing,
 * status-code mapping and idempotent-return behaviour end to end.
 */

function startServer(repo) {
  const app = createApp(repo);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const options = {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {},
    };
    if (payload != null) {
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function withServer(fn) {
  return async () => {
    const repo = new MemoryRepository();
    const { server, port } = await startServer(repo);
    try {
      await fn(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test(
  'GET /health returns 200',
  withServer(async (port) => {
    const res = await request(port, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  }),
);

test(
  'FR1: POST /api/books ->201 with public book shape',
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/books', { title: 'Dune', copies: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Dune');
    assert.equal(res.body.availableCopies, 3);
    assert.equal(typeof res.body.id, 'number');
    assert.deepEqual(Object.keys(res.body).sort(), ['availableCopies', 'id', 'title']);
  }),
);

test(
  'FR5: POST /api/books with invalid copies ->400',
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/books', { title: 'Dune', copies: 0 });
    assert.equal(res.status, 400);
  }),
);

test(
  'FR5: POST /api/books with empty title ->400',
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/books', { title: '   ', copies: 1 });
    assert.equal(res.status, 400);
  }),
);

test(
  'GET /api/books ->200 {books:[...]}',
  withServer(async (port) => {
    await request(port, 'POST', '/api/books', { title: 'Dune', copies: 2 });
    const res = await request(port, 'GET', '/api/books');
    assert.equal(res.status, 200);
    assert.equal(res.body.books.length, 1);
    assert.equal(res.body.books[0].title, 'Dune');
  }),
);

test(
  'GET /api/books/:id ->200 book, missing ->404',
  withServer(async (port) => {
    const created = await request(port, 'POST', '/api/books', { title: 'Dune', copies: 2 });
    const found = await request(port, 'GET', `/api/books/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, created.body);

    const missing = await request(port, 'GET', '/api/books/9999');
    assert.equal(missing.status, 404);
  }),
);

test(
  'FR2: POST /api/loans ->201 active loan, stock decremented via GET book',
  withServer(async (port) => {
    const book = await request(port, 'POST', '/api/books', { title: 'Moby Dick', copies: 2 });
    const res = await request(port, 'POST', '/api/loans', { bookId: book.body.id, userId: 'reader-a' });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'active');
    assert.equal(res.body.bookId, book.body.id);
    assert.equal(res.body.userId, 'reader-a');

    const after = await request(port, 'GET', `/api/books/${book.body.id}`);
    assert.equal(after.body.availableCopies, 1);
  }),
);

test(
  'FR3/FR5: duplicate active loan ->409',
  withServer(async (port) => {
    const book = await request(port, 'POST', '/api/books', { title: 'Dune', copies: 3 });
    const first = await request(port, 'POST', '/api/loans', {
      bookId: book.body.id,
      userId: 'reader-a',
    });
    assert.equal(first.status, 201);

    const dup = await request(port, 'POST', '/api/loans', {
      bookId: book.body.id,
      userId: 'reader-a',
    });
    assert.equal(dup.status, 409);
  }),
);

test(
  'FR5: no remaining stock ->409',
  withServer(async (port) => {
    const book = await request(port, 'POST', '/api/books', { title: 'Solo', copies: 1 });
    await request(port, 'POST', '/api/loans', { bookId: book.body.id, userId: 'reader-a' });
    const exhausted = await request(port, 'POST', '/api/loans', {
      bookId: book.body.id,
      userId: 'reader-b',
    });
    assert.equal(exhausted.status, 409);
  }),
);

test(
  'FR5: missing bookId for loan ->400',
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/loans', { userId: 'reader-a' });
    assert.equal(res.status, 400);
  }),
);

test(
  'FR5: borrowing a missing book ->404',
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/loans', { bookId: 9999, userId: 'reader-a' });
    assert.equal(res.status, 404);
  }),
);

test(
  'FR4: POST /api/loans/:id/return ->200 returned; repeat idempotent with unchanged stock',
  withServer(async (port) => {
    const book = await request(port, 'POST', '/api/books', { title: 'LoTR', copies: 2 });
    const loan = await request(port, 'POST', '/api/loans', {
      bookId: book.body.id,
      userId: 'reader-a',
    });

    const returned = await request(port, 'POST', `/api/loans/${loan.body.id}/return`);
    assert.equal(returned.status, 200);
    assert.equal(returned.body.status, 'returned');

    const afterFirst = await request(port, 'GET', `/api/books/${book.body.id}`);
    assert.equal(afterFirst.body.availableCopies, 2);

    const again = await request(port, 'POST', `/api/loans/${loan.body.id}/return`);
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'returned');

    const afterSecond = await request(port, 'GET', `/api/books/${book.body.id}`);
    assert.equal(afterSecond.body.availableCopies, 2);
  }),
);

test(
  'FR5: returning an unknown loan ->404',
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/loans/999/return');
    assert.equal(res.status, 404);
  }),
);

test(
  'GET /api/loans ->200 {loans:[...]}',
  withServer(async (port) => {
    const book = await request(port, 'POST', '/api/books', { title: 'Dune', copies: 2 });
    await request(port, 'POST', '/api/loans', { bookId: book.body.id, userId: 'reader-a' });
    const res = await request(port, 'GET', '/api/loans');
    assert.equal(res.status, 200);
    assert.equal(res.body.loans.length, 1);
    assert.equal(res.body.loans[0].status, 'active');
  }),
);

test(
  'NFR1: eight simultaneous borrowers of the only copy yield exactly one 201',
  withServer(async (port) => {
    const book = await request(port, 'POST', '/api/books', { title: 'Rare', copies: 1 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(port, 'POST', '/api/loans', { bookId: book.body.id, userId: `reader-${i}` }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    constructor = undefined;
    const conflicts = results.filter((r) => r.status === 409);

    assert.equal(created.length, 1, 'exactly one borrower receives a 201');
    assert.equal(conflicts.length, 7, 'the other seven receive a 409');

    // Inventory never becomes negative.
    const after = await request(port, 'GET', `/api/books/${book.body.id}`);
    assert.equal(after.body.availableCopies, 0);
  }),
);