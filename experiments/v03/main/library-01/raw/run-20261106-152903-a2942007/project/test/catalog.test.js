'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryRepository } = require('../src/memoryRepository');
const { createCatalogService, RepositoryError } = require('../src/catalog');

/**
 * Catalog business module tests (FR1, FR5).
 *
 * These tests use the in-memory repository, so npm test runs without a live
 * PostgreSQL. The in-memory adapter enforces the same validation and error
 * semantics as the PostgreSQL adapter (see src/repository.js).
 */

function newService() {
  return createCatalogService(new MemoryRepository());
}

test('FR1: create a title with a positive number of copies', async () => {
  const service = newService();
  const book = await service.createBook({ title: 'Dune', copies: 3 });

  assert.equal(book.title, 'Dune');
  assert.equal(book.availableCopies, 3);
  assert.equal(typeof book.id, 'number');
});

test('createBook returns the public book shape with no internal copies field', async () => {
  const service = newService();
  const book = await service.createBook({ title: 'Dune', copies: 2 });

  assert.deepEqual(Object.keys(book).sort(), ['availableCopies', 'id', 'title']);
});

test('listBooks returns created books with availableCopies, ordered by id', async () => {
  const service = newService();
  await service.createBook({ title: 'Dune', copies: 1 });
  await service.createBook({ title: 'Foundation', copies: 5 });

  const books = await service.listBooks();
  assert.equal(books.length, 2);
  assert.deepEqual(
    books.map((b) => [b.id, b.title, b.availableCopies]),
    [
      [1, 'Dune', 1],
      [2, 'Foundation', 5],
    ],
  );
});

test('getBook returns a single book', async () => {
  const service = newService();
  const created = await service.createBook({ title: 'Dune', copies: 2 });

  const book = await service.getBook(created.id);
  assert.deepEqual(book, { id: created.id, title: 'Dune', availableCopies: 2 });
});

test('getBook returns null for a missing book (404 at the route layer)', async () => {
  const service = newService();
  const book = await service.getBook(9999);
  assert.equal(book, null);
});

test('FR5: empty title is rejected as invalid input', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook({ title: '   ', copies: 1 }),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_TITLE',
  );
});

test('FR5: non-string title is rejected', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook({ title: 123, copies: 1 }),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_TITLE',
  );
});

test('FR5: zero copies is rejected', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook({ title: 'Dune', copies: 0 }),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_COPIES',
  );
});

test('FR5: negative copies is rejected', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook({ title: 'Dune', copies: -2 }),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_COPIES',
  );
});

test('FR5: non-integer copies is rejected', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook({ title: 'Dune', copies: 1.5 }),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_COPIES',
  );
});

test('FR5: missing copies is rejected', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook({ title: 'Dune' }),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_COPIES',
  );
});

test('FR5: missing title is rejected', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook({ copies: 1 }),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_TITLE',
  );
});

test('createBook with null input is rejected', async () => {
  const service = newService();

  await assert.rejects(
    service.createBook(null),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_TITLE',
  );
});