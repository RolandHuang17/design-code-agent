'use strict';

/**
 * In-memory repository implementing the shared repository contract in
 * src/repository.js. Intended for unit/API tests so npm test runs without a
 * live PostgreSQL. Behaviour (validation, error codes, idempotent returns)
 * mirrors the PostgreSQL adapter so the business modules and routes are
 * exercised identically.
 */

const {
  RepositoryError,
  assertBookInput,
  toBook,
  toLoan,
} = require('./repository');

class MemoryRepository {
  constructor() {
    this.books = new Map(); // id -> { id, title, copies }
    this.loans = new Map(); // id -> { id, bookId, userId, status }
    this.nextBookId = 1;
    this.nextLoanId = 1;
  }

  createBook({ title, copies }) {
    assertBookInput(title, copies);
    const id = this.nextBookId++;
    const row = { id, title, copies };
    this.books.set(id, row);
    return toBook(row);
  }

  listBooks() {
    return [...this.books.values()].sort((a, b) => a.id - b.id).map(toBook);
  }

  getBook(id) {
    const row = this.books.get(Number(id));
    return row == null ? null : toBook(row);
  }

  borrow(bookId, userId) {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new RepositoryError('INVALID_USER_ID', 'userId must be a non-empty string', 400);
    }

    const book = this.books.get(Number(bookId));
    if (book == null) {
      throw new RepositoryError('NOT_FOUND', 'Book not found', 404);
    }
    if (book.copies <= 0) {
      throw new RepositoryError('NO_STOCK', 'No available copies', 409);
    }

    for (const loan of this.loans.values()) {
      if (loan.bookId === book.id && loan.userId === userId && loan.status === 'active') {
        throw new RepositoryError('DUPLICATE_LOAN', 'Reader already has an active loan', 409);
      }
    }

    const id = this.nextLoanId++;
    const loan = { id, bookId: book.id, userId, status: 'active' };
    this.loans.set(id, loan);
    book.copies -= 1;
    return toLoan(loan);
  }

  listLoans() {
    return [...this.loans.values()].sort((a, b) => a.id - b.id).map(toLoan);
  }

  getLoan(id) {
    const row = this.loans.get(Number(id));
    return row == null ? null : toLoan(row);
  }

  returnLoan(id) {
    const loan = this.loans.get(Number(id));
    if (loan == null) {
      throw new RepositoryError('NOT_FOUND', 'Loan not found', 404);
    }

    if (loan.status === 'returned') {
      return toLoan(loan);
    }

    loan.status = 'returned';
    const book = this.books.get(loan.bookId);
    if (book != null) {
      book.copies += 1;
    }
    return toLoan(loan);
  }
}

module.exports = { MemoryRepository };