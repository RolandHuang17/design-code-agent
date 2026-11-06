'use strict';

/**
 * Repository interface (contract) shared by the PostgreSQL and in-memory
 * adapters. Every concrete repository must implement all methods below.
 *
 * This module also provides a small set of domain/validation helpers so both
 * adapters (and the business modules that consume them) agree on shapes and
 * error semantics. Business modules depend only on this interface plus the
 * concrete adapter injected at runtime; tests inject the in-memory adapter.
 */

/**
 * Result shape returned by createBook:
 *   { id, title, availableCopies }
 *
 * Result shape returned by listBooks:
 *   Array<{ id, title, availableCopies }>
 *
 * Result shape returned by getBook:
 *   { id, title, availableCopies } | null
 *
 * Result shape returned by createLoan (via borrow):
 *   { id, bookId, userId, status: 'active' }
 *
 * Result shape returned by listLoans / getLoan:
 *   { id, bookId, userId, status }
 *
 * A repository implementation must export an object (class instance or
 * plain object) exposing:
 *
 *   createBook({ title, copies })        -> { id, title, availableCopies }
 *   listBooks()                           -> Array<book>
 *   getBook(id)                           -> book | null
 *   borrow(bookId, userId)               -> { id, bookId, userId, status } or throw
 *   listLoans()                           -> Array<loan>
 *   getLoan(id)                           -> loan | null
 *   returnLoan(id)                        -> loan with status 'returned' or throw
 *
 * Semantics (kept identical across adapters):
 *   - borrow throws a typed error when no remaining stock or a duplicate
 *     active loan exists (caller maps to 409).
 *   - returnLoan is idempotent: returning an already-returned loan does not
 *     restore stock a second time.
 */

class RepositoryError extends Error {
  /**
   * @param {string} code - stable machine code ('NOT_FOUND', 'NO_STOCK',
   *   'DUPLICATE_LOAN', 'INVALID_STATE').
   * @param {string} message - human-readable message.
   * @param {number} [httpStatus] - suggested HTTP status.
   */
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Validate fields shared by both adapters so behaviour is consistent.
 *
 * @param {string} title
 * @param {*} copies
 */
function assertBookInput(title, copies) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new RepositoryError('INVALID_TITLE', 'Title must be a non-empty string', 400);
  }
  if (!Number.isInteger(copies) || copies <= 0) {
    throw new RepositoryError('INVALID_COPIES', 'Copies must be a positive integer', 400);
  }
}

/**
 * Normalise a book row (internal storage) into the public shape.
 * @param {{id: number|string, title: string, copies: number}} row
 */
function toBook(row) {
  return {
    id: row.id,
    title: row.title,
    availableCopies: row.copies,
  };
}

/**
 * Normalise a loan row into the public shape.
 * @param {{id: number|string, bookId: number|string, userId: string, status: string}} row
 */
function toLoan(row) {
  return {
    id: row.id,
    bookId: row.bookId,
    userId: row.userId,
    status: row.status,
  };
}

module.exports = {
  RepositoryError,
  assertBookInput,
  toBook,
  toLoan,
};