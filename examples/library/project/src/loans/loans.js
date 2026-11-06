'use strict';

/**
 * Loans business module.
 *
 * Pure domain logic over an injected store. This module owns the borrow/return
 * rules (FR2-FR4, NFR1) and maps store outcomes to domain results/errors. The
 * store (Postgres in production, in-memory adapter in tests) is responsible
 * for the atomic transaction, row locking, and idempotency guarantees; this
 * module only concerns itself with validation and translating store replies
 * into a stable, route-mappable shape.
 */

/**
 * Loans errors carry a stable code for route-level HTTP mapping.
 *   - VALIDATION  -> 400
 *   - NOT_FOUND   -> 404
 *   - CONFLICT    -> 409
 */
class LoansError extends Error {
  /**
   * @param {string} code one of 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT'
   * @param {string} message human-readable reason
   */
  constructor(code, message) {
    super(message);
    this.name = 'LoansError';
    this.code = code;
  }
}

const VALID_USER_ID_MAX_LENGTH = 500;

/**
 * Validate and normalize the `{ bookId, userId }` input used to borrow a book.
 *
 * `bookId` accepts a positive integer number or a numeric string: PostgreSQL
 * `BIGSERIAL` ids are surfaced by `pg` as strings, and the fixed REST contract
 * types bookId without a JSON type constraint (unlike `userId: string`). This
 * mirrors `parsePositiveInt` used by getBook/returnLoan. `userId` must be a
 * non-empty string (caller-provided, not authenticated).
 * @param {{bookId: unknown, userId: unknown}} input
 * @returns {{bookId: number, userId: string}}
 * @throws {LoansError} code 'VALIDATION' when invalid.
 */
function validateBorrowInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new LoansError('VALIDATION', 'request body must be an object');
  }

  const parsedBookId = parsePositiveInt(input.bookId);
  if (parsedBookId === null) {
    throw new LoansError('VALIDATION', 'bookId must be a positive integer');
  }
  const bookId = parsedBookId;

  const userId = input.userId;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new LoansError('VALIDATION', 'userId must be a non-empty string');
  }
  const trimmedUserId = userId.trim();
  if (trimmedUserId.length > VALID_USER_ID_MAX_LENGTH) {
    throw new LoansError(
      'VALIDATION',
      `userId must be at most ${VALID_USER_ID_MAX_LENGTH} characters`,
    );
  }

  return { bookId, userId: trimmedUserId };
}

/**
 * Borrow an available copy for a caller-provided reader ID (FR2, FR3).
 *
 * The store is expected to run this atomically: lock the book row, verify
 * remaining stock and the absence of an active loan for (bookId, userId),
 * decrement availableCopies, and insert an active loan. The store signals the
 * outcome via a stable result code so this module can map it to domain errors:
 *   - 'ok'          -> active loan
 *   - 'not_found'   -> NOT_FOUND (book does not exist)
 *   - 'no_stock'    -> CONFLICT (insufficient copies)
 *   - 'duplicate'   -> CONFLICT (already an active loan for this reader/book)
 * @param {{borrow: (args: {bookId: number, userId: string}) => Promise<{outcome: string, loan?: object}>}} store
 * @param {{bookId: unknown, userId: unknown}} input
 * @returns {Promise<object>} active loan `{id, bookId, userId, status:"active"}`.
 * @throws {LoansError}
 */
async function borrow(store, input) {
  const { bookId, userId } = validateBorrowInput(input);
  const result = await store.borrow({ bookId, userId });

  switch (result.outcome) {
    case 'ok':
      return result.loan;
    case 'not_found':
      throw new LoansError('NOT_FOUND', 'book not found');
    case 'no_stock':
      throw new LoansError('CONFLICT', 'no copies available');
    case 'duplicate':
      throw new LoansError('CONFLICT', 'reader already has an active loan for this book');
    default:
      throw new LoansError('CONFLICT', 'loan could not be created');
  }
}

/**
 * Return a loan, restoring one copy exactly once (FR4).
 *
 * The store guarantees idempotency at the transaction/status level: an
 * already-returned loan yields 'already' with no stock change, while a fresh
 * return yields 'ok' with the stock incremented once. Both round-trips keep
 * the same HTTP status (200); only the domain outcome differs.
 * @param {{returnLoan: (id: number) => Promise<{outcome: string, loan?: object}>}} store
 * @param {unknown} id raw loan id from the route.
 * @returns {Promise<object>} returned loan `{id, bookId, userId, status:"returned"}`.
 * @throws {LoansError}
 */
async function returnLoan(store, id) {
  const parsed = parsePositiveInt(id);
  if (parsed === null) {
    throw new LoansError('NOT_FOUND', 'loan not found');
  }
  const result = await store.returnLoan(parsed);
  switch (result.outcome) {
    case 'ok':
    case 'already':
      return result.loan;
    case 'not_found':
      throw new LoansError('NOT_FOUND', 'loan not found');
    default:
      throw new LoansError('NOT_FOUND', 'loan not found');
  }
}

/**
 * List all loans.
 * @param {{listLoans: () => Promise<object[]>}} store
 * @returns {Promise<{loans: object[]}>}
 */
async function listLoans(store) {
  const loans = await store.listLoans();
  return { loans };
}

/**
 * Parse a value as a positive integer id. Returns null for anything invalid.
 * @param {unknown} value
 * @returns {number|null}
 */
function parsePositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

module.exports = {
  LoansError,
  borrow,
  returnLoan,
  listLoans,
  validateBorrowInput,
  parsePositiveInt,
};