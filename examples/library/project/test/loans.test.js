'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  LoansError,
  borrow,
  returnLoan,
  listLoans,
  validateBorrowInput,
  parsePositiveInt,
} = require('../src/loans/loans');
const { createMemoryStore } = require('../src/store/memory.store');
const { createBook } = require('../src/catalog/catalog');

function newStore() {
  return createMemoryStore();
}

async function seedBook(store, title = 'Dune', copies = 1) {
  return createBook(store, { title, copies });
}

describe('validateBorrowInput', () => {
  it('accepts a positive integer bookId and non-empty userId', () => {
    const result = validateBorrowInput({ bookId: 1, userId: '  alice  ' });
    assert.deepStrictEqual(result, { bookId: 1, userId: 'alice' });
  });

  it('rejects null / non-object bodies', () => {
    for (const bad of [null, undefined, 'x', 42, [1]]) {
      assert.throws(
        () => validateBorrowInput(bad),
        (err) => err instanceof LoansError && err.code === 'VALIDATION',
      );
    }
  });

  it('rejects invalid bookId values', () => {
    for (const bad of [0, -1, 1.5, '0', '1.5', 'abc', '', null, undefined, NaN, Infinity]) {
      assert.throws(
        () => validateBorrowInput({ bookId: bad, userId: 'alice' }),
        (err) => err instanceof LoansError && err.code === 'VALIDATION',
      );
    }
  });

  it('accepts a numeric-string bookId (BIGSERIAL ids surface as strings)', () => {
    const result = validateBorrowInput({ bookId: '7', userId: '  alice  ' });
    assert.deepStrictEqual(result, { bookId: 7, userId: 'alice' });
  });

  it('rejects empty or non-string userId values', () => {
    for (const bad of ['', '   ', 7, null, undefined]) {
      assert.throws(
        () => validateBorrowInput({ bookId: 1, userId: bad }),
        (err) => err instanceof LoansError && err.code === 'VALIDATION',
      );
    }
  });

  it('rejects overly long userId values', () => {
    assert.throws(
      () => validateBorrowInput({ bookId: 1, userId: 'a'.repeat(501) }),
      (err) => err instanceof LoansError && err.code === 'VALIDATION',
    );
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

describe('borrow (FR2, FR3)', () => {
  it('creates an active loan and decrements available copies', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 2);

    const loan = await borrow(store, { bookId: 1, userId: 'alice' });
    assert.deepStrictEqual(loan, { id: 1, bookId: 1, userId: 'alice', status: 'active' });

    const book = await store.getBook(1);
    assert.strictEqual(book.availableCopies, 1);
  });

  it('allows a different reader to borrow another copy', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 2);

    await borrow(store, { bookId: 1, userId: 'alice' });
    const loan = await borrow(store, { bookId: 1, userId: 'bob' });
    assert.strictEqual(loan.userId, 'bob');
    assert.strictEqual(loan.status, 'active');
  });

  it('rejects a duplicate active loan for the same (bookId, userId) as CONFLICT (FR3)', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 2);
    await borrow(store, { bookId: 1, userId: 'alice' });

    await assert.rejects(
      borrow(store, { bookId: 1, userId: 'alice' }),
      (err) => err instanceof LoansError && err.code === 'CONFLICT',
    );
  });

  it('rejects borrowing when no copies remain as CONFLICT (FR5)', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 1);
    await borrow(store, { bookId: 1, userId: 'alice' });

    await assert.rejects(
      borrow(store, { bookId: 1, userId: 'bob' }),
      (err) => err instanceof LoansError && err.code === 'CONFLICT',
    );
  });

  it('rejects borrowing an unknown book as NOT_FOUND (FR5)', async () => {
    const store = newStore();
    await assert.rejects(
      borrow(store, { bookId: 999, userId: 'alice' }),
      (err) => err instanceof LoansError && err.code === 'NOT_FOUND',
    );
  });

  it('rejects invalid borrow input as VALIDATION before touching the store', async () => {
    const store = newStore();
    await assert.rejects(
      borrow(store, { bookId: 0, userId: 'alice' }),
      (err) => err instanceof LoansError && err.code === 'VALIDATION',
    );
  });
});

describe('NFR1: concurrent borrowers of the only copy', () => {
  it('yields exactly one successful loan and never negative stock', async () => {
    const store = newStore();
    await seedBook(store, 'Single', 1);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        borrow(store, { bookId: 1, userId: `reader-${i}` }).then(
          (loan) => ({ ok: true, loan }),
          (err) => ({ ok: false, code: err instanceof LoansError ? err.code : null }),
        ),
      ),
    );

    const successes = results.filter((r) => r.ok);
    assert.strictEqual(successes.length, 1);

    const book = await store.getBook(1);
    assert.strictEqual(book.availableCopies, 0);
    assert.ok(book.availableCopies >= 0, 'inventory must never be negative');
  });
});

describe('returnLoan (FR4)', () => {
  it('returns an active loan and restores exactly one copy', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 1);
    const loan = await borrow(store, { bookId: 1, userId: 'alice' });

    const returned = await returnLoan(store, loan.id);
    assert.strictEqual(returned.status, 'returned');

    const book = await store.getBook(1);
    assert.strictEqual(book.availableCopies, 1);
  });

  it('is idempotent: a repeated return does not increment stock again (FR4)', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 1);
    const loan = await borrow(store, { bookId: 1, userId: 'alice' });

    await returnLoan(store, loan.id);
    const again = await returnLoan(store, loan.id);
    assert.strictEqual(again.status, 'returned');

    const book = await store.getBook(1);
    assert.strictEqual(book.availableCopies, 1);
  });

  it('restores stock so a different reader may borrow afterward', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 1);
    const loan = await borrow(store, { bookId: 1, userId: 'alice' });
    await returnLoan(store, loan.id);

    const second = await borrow(store, { bookId: 1, userId: 'bob' });
    assert.strictEqual(second.status, 'active');
  });

  it('rejects an unknown loan id as NOT_FOUND (FR5)', async () => {
    const store = newStore();
    await assert.rejects(
      returnLoan(store, 999),
      (err) => err instanceof LoansError && err.code === 'NOT_FOUND',
    );
  });

  it('rejects an invalid loan id as NOT_FOUND', async () => {
    const store = newStore();
    for (const bad of ['abc', 0, -1, 1.5, null, undefined]) {
      await assert.rejects(
        returnLoan(store, bad),
        (err) => err instanceof LoansError && err.code === 'NOT_FOUND',
      );
    }
  });
});

describe('listLoans', () => {
  it('returns a { loans } envelope', async () => {
    const store = newStore();
    await seedBook(store, 'Dune', 2);
    await borrow(store, { bookId: 1, userId: 'alice' });
    await borrow(store, { bookId: 1, userId: 'bob' });

    const result = await listLoans(store);
    assert.ok(Array.isArray(result.loans));
    assert.deepStrictEqual(result.loans, [
      { id: 2, bookId: 1, userId: 'bob', status: 'active' },
      { id: 1, bookId: 1, userId: 'alice', status: 'active' },
    ]);
  });

  it('returns an empty list for an empty store', async () => {
    const result = await listLoans(newStore());
    assert.deepStrictEqual(result, { loans: [] });
  });
});