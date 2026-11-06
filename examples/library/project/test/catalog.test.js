'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  CatalogError,
  createBook,
  listBooks,
  getBook,
  validateBookInput,
  parsePositiveInt,
} = require('../src/catalog/catalog');
const { createMemoryStore } = require('../src/store/memory.store');

function newStore() {
  return createMemoryStore();
}

describe('validateBookInput', () => {
  it('accepts a non-empty title and positive integer copies', () => {
    const result = validateBookInput({ title: '  Dune  ', copies: 3 });
    assert.deepStrictEqual(result, { title: 'Dune', copies: 3 });
  });

  it('rejects null / non-object bodies', () => {
    for (const bad of [null, undefined, 'x', 42, [1]]) {
      assert.throws(
        () => validateBookInput(bad),
        (err) => err instanceof CatalogError && err.code === 'VALIDATION',
      );
    }
  });

  it('rejects empty or non-string titles', () => {
    for (const bad of ['', '   ', 7, null, undefined]) {
      assert.throws(
        () => validateBookInput({ title: bad, copies: 1 }),
        (err) => err instanceof CatalogError && err.code === 'VALIDATION',
      );
    }
  });

  it('rejects overly long titles', () => {
    assert.throws(
      () => validateBookInput({ title: 'a'.repeat(501), copies: 1 }),
      (err) => err instanceof CatalogError && err.code === 'VALIDATION',
    );
  });

  it('rejects non-positive, fractional, or non-numeric copies', () => {
    for (const bad of [0, -1, 1.5, '2', null, undefined, NaN, Infinity]) {
      assert.throws(
        () => validateBookInput({ title: 'Book', copies: bad }),
        (err) => err instanceof CatalogError && err.code === 'VALIDATION',
      );
    }
  });
});

describe('parsePositiveInt', () => {
  it('parses positive integer numbers and strings', () => {
    assert.strictEqual(parsePositiveInt(42), 42);
    assert.strictEqual(parsePositiveInt('42'), 42);
  });

  it('returns null for invalid values', () => {
    for (const bad of [0, -1, 1.5, '0', '-1', '1.5', 'abc', '', null, undefined, NaN, true]) {
      assert.strictEqual(parsePositiveInt(bad), null);
    }
  });
});

describe('createBook (FR1)', () => {
  it('creates a book with available copies equal to total copies', async () => {
    const store = newStore();
    const book = await createBook(store, { title: 'Dune', copies: 3 });
    assert.deepStrictEqual(book, { id: 1, title: 'Dune', availableCopies: 3 });
  });

  it('trims the title and rejects invalid input', async () => {
    const store = newStore();
    const book = await createBook(store, { title: '  Neuromancer  ', copies: 2 });
    assert.strictEqual(book.title, 'Neuromancer');

    await assert.rejects(
      createBook(store, { title: '', copies: 1 }),
      (err) => err instanceof CatalogError && err.code === 'VALIDATION',
    );
  });
});

describe('listBooks', () => {
  it('returns a { books } envelope in reverse insertion order', async () => {
    const store = newStore();
    await createBook(store, { title: 'A', copies: 1 });
    await createBook(store, { title: 'B', copies: 2 });
    const result = await listBooks(store);
    assert.ok(Array.isArray(result.books));
    assert.deepStrictEqual(result.books, [
      { id: 2, title: 'B', availableCopies: 2 },
      { id: 1, title: 'A', availableCopies: 1 },
    ]);
  });

  it('returns an empty list for an empty store', async () => {
    const result = await listBooks(newStore());
    assert.deepStrictEqual(result, { books: [] });
  });
});

describe('getBook (FR5)', () => {
  it('returns the book for a valid id', async () => {
    const store = newStore();
    const created = await createBook(store, { title: 'Dune', copies: 2 });
    const book = await getBook(store, created.id);
    assert.deepStrictEqual(book, { id: 1, title: 'Dune', availableCopies: 2 });
  });

  it('throws NOT_FOUND for an unknown id', async () => {
    const store = newStore();
    await assert.rejects(
      getBook(store, 999),
      (err) => err instanceof CatalogError && err.code === 'NOT_FOUND',
    );
  });

  it('throws NOT_FOUND for an invalid id (invalid ids are "not found")', async () => {
    const store = newStore();
    for (const bad of ['abc', 0, -1, 1.5, null, undefined]) {
      await assert.rejects(
        getBook(store, bad),
        (err) => err instanceof CatalogError && err.code === 'NOT_FOUND',
      );
    }
  });

  it('accepts a numeric-string id', async () => {
    const store = newStore();
    await createBook(store, { title: 'Dune', copies: 1 });
    const book = await getBook(store, '1');
    assert.strictEqual(book.title, 'Dune');
  });
});