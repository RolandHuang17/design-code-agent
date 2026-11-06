'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryRepository } = require('../src/memoryRepository');
const { createLoansModule } = require('../src/loans');
const { createCatalogService } = require('../src/catalog');
const { RepositoryError } = require('../src/repository');

function makeFixture() {
  const repo = new MemoryRepository();
  const catalog = createCatalogService(repo);
  const loans = createLoansModule(repo);
  return { repo, catalog, loans };
}

test('FR2: reader can borrow an available book', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Moby Dick', copies: 2 });

  const loan = await loans.borrow(book.id, 'reader-a');

  assert.deepEqual(loan, {
    id: loan.id,
    bookId: book.id,
    userId: 'reader-a',
    status: 'active',
  });
  assert.equal((await catalog.getBook(book.id)).availableCopies, 1);
});

test('FR3: a reader has at most one active loan for the same book', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Dune', copies: 3 });

  await loans.borrow(book.id, 'reader-a');
  await assert.rejects(
    () => loans.borrow(book.id, 'reader-a'),
    (err) => err instanceof RepositoryError && err.code === 'DUPLICATE_LOAN' && err.httpStatus === 409,
  );
});

test('FR3: a different reader may borrow another copy of the same book', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Dune', copies: 2 });

  await loans.borrow(book.id, 'reader-a');
  const loan = await loans.borrow(book.id, 'reader-b');

  assert.equal(loan.status, 'active');
  assert.equal((await catalog.getBook(book.id)).availableCopies, 0);
});

test('FR5/conflict: borrowing with no remaining stock is a 409 conflict', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Solo', copies: 1 });

  await loans.borrow(book.id, 'reader-a');
  await assert.rejects(
    () => loans.borrow(book.id, 'reader-b'),
    (err) => err instanceof RepositoryError && err.code === 'NO_STOCK' && err.httpStatus === 409,
  );
});

test('FR5/missing: borrowing a missing book throws NOT_FOUND', async () => {
  const { loans } = makeFixture();
  await assert.rejects(
    () => loans.borrow(999, 'reader-a'),
    (err) => err instanceof RepositoryError && err.code === 'NOT_FOUND' && err.httpStatus === 404,
  );
});

test('FR5: empty or non-string userId is rejected as invalid input', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Dune', copies: 1 });

  await assert.rejects(
    () => loans.borrow(book.id, ''),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_USER_ID' && err.httpStatus === 400,
  );
  await assert.rejects(
    () => loans.borrow(book.id, null),
    (err) => err instanceof RepositoryError && err.code === 'INVALID_USER_ID' && err.httpStatus === 400,
  );
});

test('FR4: returning a loan restores one copy exactly once (idempotent)', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'LoTR', copies: 2 });
  const loan = await loans.borrow(book.id, 'reader-a');

  const returned = await loans.returnLoan(loan.id);
  assert.equal(returned.status, 'returned');
  assert.equal((await catalog.getBook(book.id)).availableCopies, 2);

  // Repeated return: stock unchanged, status stays returned.
  const again = await loans.returnLoan(loan.id);
  assert.equal(again.status, 'returned');
  assert.equal((await catalog.getBook(book.id)).availableCopies, 2);
});

test('FR5/missing: returning an unknown loan throws NOT_FOUND', async () => {
  const { loans } = makeFixture();
  await assert.rejects(
    () => loans.returnLoan(999),
    (err) => err instanceof RepositoryError && err.code === 'NOT_FOUND' && err.httpStatus === 404,
  );
});

test('NFR1: eight simultaneous borrowers of the only copy yield exactly one success', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Rare', copies: 1 });

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => loans.borrow(book.id, `reader-${i}`)),
  );

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'exactly one borrower succeeds');
  assert.equal(rejected.length, 7, 'seven borrowers are rejected');

  for (const r of rejected) {
    assert.ok(r.reason instanceof RepositoryError, 'rejections are typed RepositoryErrors');
    assert.ok(
      r.reason.code === 'NO_STOCK' || r.reason.code === 'DUPLICATE_LOAN',
      `unexpected error code: ${r.reason.code}`,
    );
    assert.equal(r.reason.httpStatus, 409);
  }

  // Inventory never becomes negative.
  const after = await catalog.getBook(book.id);
  assert.equal(after.availableCopies, 0);
});

test('NFR1/FR4: concurrent returns restore stock exactly once', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Shared', copies: 1 });
  const loan = await loans.borrow(book.id, 'reader-a');

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => loans.returnLoan(loan.id)),
  );

  assert.equal(results.every((r) => r.status === 'fulfilled'), true, 'all returns resolve');
  // Stock restored exactly once, not once per concurrent caller.
  assert.equal((await catalog.getBook(book.id)).availableCopies, 1);
});

test('loans module lists and retrieves loans', async () => {
  const { catalog, loans } = makeFixture();
  const book = await catalog.createBook({ title: 'Dune', copies: 2 });
  const loan = await loans.borrow(book.id, 'reader-a');

  const list = await loans.listLoans();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, loan.id);

  const fetched = await loans.getLoan(loan.id);
  assert.deepEqual(fetched, { id: loan.id, bookId: book.id, userId: 'reader-a', status: 'active' });
});