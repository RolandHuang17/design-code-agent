'use strict';

/**
 * Loans business module.
 *
 * This is the business layer for borrowing and returning books. The actual
 * transactional/row-lock behaviour (serialising concurrent borrowers on a
 * single client, idempotent returns that restore stock exactly once) lives in
 * the repository adapters so that the PostgreSQL and in-memory implementations
 * share identical semantics. This module depends only on the repository
 * contract injected at construction time, so unit/API tests can drive the
 * same code path with the in-memory adapter while the real PostgreSQL adapter
 * serves the runtime.
 *
 * Domain rules enforced here (and mirrored by every adapter):
 *   - at most one active loan per (bookId, userId);
 *   - a reader may not borrow more copies than remain in stock;
 *   - returnLoan is idempotent: the first active -> returned transition
 *     restores one copy, subsequent returns leave stock unchanged.
 */

const { RepositoryError } = require('./repository');

/**
 * @param {object} repository - repository instance implementing the contract
 *   described in src/repository.js (borrow, returnLoan, listLoans, getLoan).
 */
function createLoansModule(repository) {
  /**
   * Borrow one available copy for a reader.
   * @param {number|string} bookId
   * @param {string} userId - explicitly entered reader ID (demonstration input).
   * @returns {Promise<{id, bookId, userId, status: 'active'}>}
   */
  async function borrow(bookId, userId) {
    if (userId == null || typeof userId !== 'string' || userId.trim() === '') {
      throw new RepositoryError('INVALID_USER_ID', 'userId must be a non-empty string', 400);
    }
    if (!Number.isInteger(bookId) || bookId <= 0) {
      throw new RepositoryError('INVALID_BOOK_ID', 'bookId must be a positive integer', 400);
    }
    return repository.borrow(bookId, userId);
  }

  /**
   * Return a loan. Idempotent: repeated returns do not increment stock again.
   * @param {number|string} loanId
   * @returns {Promise<{id, bookId, userId, status: 'returned'}>}
   */
  async function returnLoan(loanId) {
    return repository.returnLoan(loanId);
  }

  function listLoans() {
    return repository.listLoans();
  }

  function getLoan(loanId) {
    return repository.getLoan(loanId);
  }

  return { borrow, returnLoan, listLoans, getLoan };
}

module.exports = { createLoansModule };