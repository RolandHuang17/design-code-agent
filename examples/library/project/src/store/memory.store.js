'use strict';

/**
 * MemoryStore: test-only data-access adapter with no external dependencies.
 *
 * This adapter exists so that `npm test` can exercise the Catalog and Loans
 * business modules without a live PostgreSQL. It is selected only through the
 * injected factory in tests; the server entrypoint always chooses
 * PostgresStore, so there is no in-memory fallback in production.
 *
 * The implementation mirrors the observable semantics of PostgresStore:
 *   - createBook starts `availableCopies === copies` (FR1).
 *   - borrow atomically validates the book, the absence of an active loan for
 *     the same (bookId, userId), and remaining stock before inserting an
 *     active loan and decrementing stock (FR2, FR3).
 *   - returnLoan restores exactly one copy on first return and is idempotent
 *     thereafter (FR4).
 *
 * Because JavaScript is single-threaded, there is no interleaving within a
 * single async function; the NFR1 concurrency guarantee is exercised in tests
 * by issuing many borrows and asserting exactly one succeeds while stock never
 * goes negative. The real PostgreSQL row-lock guarantee is covered by the
 * PostgresStore and the protected runtime acceptance.
 */

function createMemoryStore(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Map<number, {id:number,title:string,copies:number,availableCopies:number}>} */
  const books = new Map();
  /** @type {Map<number, {id:number,bookId:number,userId:string,status:string,returnedAt:number|null}>} */
  const loans = new Map();

  let nextBookId = 1;
  let nextLoanId = 1;

  return {
    // ---- Catalog -------------------------------------------------

    async createBook({ title, copies }) {
      const id = nextBookId;
      nextBookId += 1;
      const book = { id, title, copies, availableCopies: copies };
      books.set(id, book);
      return { id: book.id, title: book.title, availableCopies: book.availableCopies };
    },

    async listBooks() {
      const all = Array.from(books.values()).sort((a, b) => b.id - a.id);
      return all.map((b) => ({ id: b.id, title: b.title, availableCopies: b.availableCopies }));
    },

    async getBook(id) {
      const book = books.get(id);
      if (!book) return null;
      return { id: book.id, title: book.title, availableCopies: book.availableCopies };
    },

    // ---- Loans ---------------------------------------------------

    async borrow({ bookId, userId }) {
      const book = books.get(bookId);
      if (!book) return { outcome: 'not_found' };

      const active = Array.from(loans.values()).find(
        (l) => l.bookId === bookId && l.userId === userId && l.status === 'active',
      );
      if (active) return { outcome: 'duplicate' };

      if (book.availableCopies <= 0) return { outcome: 'no_stock' };

      book.availableCopies -= 1;

      const id = nextLoanId;
      nextLoanId += 1;
      const loan = { id, bookId, userId, status: 'active', returnedAt: null };
      loans.set(id, loan);
      return { outcome: 'ok', loan: { id, bookId, userId, status: 'active' } };
    },

    async returnLoan(id) {
      const loan = loans.get(id);
      if (!loan) return { outcome: 'not_found' };

      if (loan.status !== 'active') {
        return {
          outcome: 'already',
          loan: { id: loan.id, bookId: loan.bookId, userId: loan.userId, status: loan.status },
        };
      }

      loan.status = 'returned';
      loan.returnedAt = now();

      const book = books.get(loan.bookId);
      if (book) book.availableCopies += 1;

      return {
        outcome: 'ok',
        loan: { id: loan.id, bookId: loan.bookId, userId: loan.userId, status: loan.status },
      };
    },

    async listLoans() {
      const all = Array.from(loans.values()).sort((a, b) => b.id - a.id);
      return all.map((l) => ({ id: l.id, bookId: l.bookId, userId: l.userId, status: l.status }));
    },
  };
}

module.exports = { createMemoryStore };