'use strict';

/**
 * HTTP-layer integration tests against the real Express app (createApp) wired
 * to an injected in-memory store, so `npm test` needs no live PostgreSQL.
 *
 * These tests verify the wire contract: status codes (201/200/400/404/409),
 * response bodies, and how typed domain errors from the Catalog/Loans business
 * modules are translated by the error middleware. Persistence semantics are
 * exercised directly in test/catalog.test.js and test/loans.test.js; the real
 * PostgreSQL row-lock behavior is covered by PostgresStore plus the protected
 * runtime acceptance.
 *
 * The app is started on an ephemeral port using Node's built-in http module and
 * driven with the global fetch (Node 22+), so no extra test HTTP client is
 * required.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createApp } = require('../src/http/app');
const { createMemoryStore } = require('../src/store/memory.store');

let server;
let base;

before(async () => {
  const store = createMemoryStore();
  const app = createApp(store);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

describe('GET /health', () => {
  it('returns 200 with an ok body', async () => {
    const { status, body } = await request('GET', '/health');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { status: 'ok' });
  });
});

describe('POST /api/books (FR1)', () => {
  it('creates a book with 201 and returns id/title/availableCopies', async () => {
    const { status, body } = await request('POST', '/api/books', {
      title: 'Dune',
      copies: 3,
    });
    assert.strictEqual(status, 201);
    assert.deepStrictEqual(body, { id: 1, title: 'Dune', availableCopies: 3 });
  });

  it('rejects invalid input with 400', async () => {
    for (const bad of [
      { title: '', copies: 1 },
      { title: 'Dune', copies: 0 },
      { title: 'Dune', copies: -1 },
      { title: 'Dune', copies: 1.5 },
      { title: 'Dune' },
    ]) {
      const { status } = await request('POST', '/api/books', bad);
      assert.strictEqual(status, 400, JSON.stringify(bad));
    }
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.strictEqual(res.status, 400);
  });
});

describe('GET /api/books (FR2)', () => {
  it('lists books with remaining copies in a { books } envelope', async () => {
    const { body: a } = await request('POST', '/api/books', { title: 'A', copies: 1 });
    const { body: b } = await request('POST', '/api/books', { title: 'B', copies: 2 });

    const { status, body } = await request('GET', '/api/books');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.books));
    // The store is shared across the whole file, so earlier tests may have left
    // other books behind; assert on the two books just created, which are the
    // most recent and therefore listed first (descending id order).
    assert.deepStrictEqual(body.books.slice(0, 2), [
      { id: b.id, title: 'B', availableCopies: 2 },
      { id: a.id, title: 'A', availableCopies: 1 },
    ]);
  });
});

describe('GET /api/books/:id (FR5)', () => {
  it('returns the book with 200 for a known id', async () => {
    const { body: created } = await request('POST', '/api/books', {
      title: 'Neuromancer',
      copies: 2,
    });
    const { status, body } = await request('GET', `/api/books/${created.id}`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, {
      id: created.id,
      title: 'Neuromancer',
      availableCopies: 2,
    });
  });

  it('returns 404 for an unknown id', async () => {
    const { status } = await request('GET', '/api/books/99999');
    assert.strictEqual(status, 404);
  });
});

describe('POST /api/loans (FR2, FR3)', () => {
  it('borrows an available copy with 201', async () => {
    const { body: book } = await request('POST', '/api/books', {
      title: 'BorrowMe',
      copies: 2,
    });
    const { status, body } = await request('POST', '/api/loans', {
      bookId: book.id,
      userId: 'alice',
    });
    assert.strictEqual(status, 201);
    assert.deepStrictEqual(body, {
      id: body.id,
      bookId: book.id,
      userId: 'alice',
      status: 'active',
    });
    assert.strictEqual(body.id, 1);

    const { body: fetched } = await request('GET', `/api/books/${book.id}`);
    assert.strictEqual(fetched.availableCopies, 1);
  });

  it('returns 409 for a duplicate active loan (FR3)', async () => {
    const { body: book } = await request('POST', '/api/books', {
      title: 'Dup',
      copies: 2,
    });
    await request('POST', '/api/loans', { bookId: book.id, userId: 'alice' });
    const { status } = await request('POST', '/api/loans', {
      bookId: book.id,
      userId: 'alice',
    });
    assert.strictEqual(status, 409);
  });

  it('returns 409 when no copies remain (FR5)', async () => {
    const { body: book } = await request('POST', '/api/books', {
      title: 'OnlyOne',
      copies: 1,
    });
    await request('POST', '/api/loans', { bookId: book.id, userId: 'alice' });
    const { status } = await request('POST', '/api/loans', {
      bookId: book.id,
      userId: 'bob',
    });
    assert.strictEqual(status, 409);
  });

  it('returns 404 for an unknown book (FR5)', async () => {
    const { status } = await request('POST', '/api/loans', {
      bookId: 99999,
      userId: 'alice',
    });
    assert.strictEqual(status, 404);
  });

  it('returns 400 for invalid borrow input', async () => {
    for (const bad of [
      { bookId: 0, userId: 'alice' },
      { bookId: 1, userId: '' },
      { bookId: 1 },
      {},
    ]) {
      const { status } = await request('POST', '/api/loans', bad);
      assert.strictEqual(status, 400, JSON.stringify(bad));
    }
  });
});

describe('GET /api/loans', () => {
  it('returns a { loans } envelope', async () => {
    const { status, body } = await request('GET', '/api/loans');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.loans));
  });
});

describe('POST /api/loans/:id/return (FR4)', () => {
  it('returns a loan with 200 and restores stock', async () => {
    const { body: book } = await request('POST', '/api/books', {
      title: 'ReturnMe',
      copies: 1,
    });
    const { body: loan } = await request('POST', '/api/loans', {
      bookId: book.id,
      userId: 'carol',
    });

    const { status, body } = await request('POST', `/api/loans/${loan.id}/return`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'returned');

    const { body: fetched } = await request('GET', `/api/books/${book.id}`);
    assert.strictEqual(fetched.availableCopies, 1);
  });

  it('is idempotent: a repeated return keeps status returned and stock unchanged', async () => {
    const { body: book } = await request('POST', '/api/books', {
      title: 'Idem',
      copies: 1,
    });
    const { body: loan } = await request('POST', '/api/loans', {
      bookId: book.id,
      userId: 'dave',
    });

    await request('POST', `/api/loans/${loan.id}/return`);
    const { status, body } = await request('POST', `/api/loans/${loan.id}/return`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'returned');

    const { body: fetched } = await request('GET', `/api/books/${book.id}`);
    assert.strictEqual(fetched.availableCopies, 1);
  });

  it('returns 404 for an unknown loan id', async () => {
    const { status } = await request('POST', '/api/loans/99999/return');
    assert.strictEqual(status, 404);
  });
});

describe('unknown API route', () => {
  it('returns 404 with a JSON error body', async () => {
    const { status, body } = await request('GET', '/api/nope');
    assert.strictEqual(status, 404);
    assert.deepStrictEqual(body, { error: 'not found' });
  });
});