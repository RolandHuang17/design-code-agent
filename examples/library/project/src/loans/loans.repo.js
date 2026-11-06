'use strict';

/**
 * Loans repository: PostgreSQL data access for loans.
 *
 * `loans.js` owns validation and domain rules; this module owns only SQL and
 * row mapping. It is consumed by the Postgres store so that SQL text and row
 * mapping stay in one place. The heavy transactional work (BEGIN, row lock,
 * atomically decrement/increment stock) lives in the store implementation;
 * these helpers produce the individual parameterized statements it composes.
 *
 * Server-side aliasing keeps the returned rows on the camelCase contract keys
 * (`bookId`, `userId`) even though PostgreSQL columns are quoted camelCase
 * identifiers. The partial unique index `loans_active_unique` backstops the
 * one-active-loan-per-(book,reader) rule, but the store also checks explicitly
 * so it can distinguish a duplicate from a no-stock conflict.
 */

/** @typedef {{id: string, bookId: string, userId: string, status: string}} LoanRow */

/**
 * Select the row for a single active loan of a given book by a given reader.
 * Forces a row lock (`FOR UPDATE`) so the borrow transaction is safe against
 * concurrent borrowers/serialization anomalies.
 * @param {number} bookId positive integer id.
 * @param {string} userId non-empty reader id.
 * @returns {{text: string, values: unknown[]}}
 */
function selectActiveLoan(bookId, userId) {
  return {
    text: `
      SELECT id, "bookId" AS "bookId", "userId" AS "userId", status
      FROM loans
      WHERE "bookId" = $1 AND "userId" = $2 AND status = 'active'
      FOR UPDATE
    `,
    values: [bookId, userId],
  };
}

/**
 * Insert a new active loan.
 * @param {{bookId: number, userId: string}} data
 * @returns {{text: string, values: unknown[]}}
 */
function insertLoan(data) {
  return {
    text: `
      INSERT INTO loans ("bookId", "userId", status)
      VALUES ($1, $2, 'active')
      RETURNING id, "bookId" AS "bookId", "userId" AS "userId", status
    `,
    values: [data.bookId, data.userId],
  };
}

/**
 * Select a single loan by id with its book id for the return workflow.
 * @param {number} id loan id.
 * @returns {{text: string, values: unknown[]}}
 */
function selectLoanById(id) {
  return {
    text: `
      SELECT id, "bookId" AS "bookId", "userId" AS "userId", status
      FROM loans
      WHERE id = $1
    `,
    values: [id],
  };
}

/**
 * Mark a loan as returned, setting its returned_at timestamp, only when it is
 * still active. Row is locked so a concurrent duplicate return cannot run past
 * a fresh one.
 * @param {number} id loan id.
 * @returns {{text: string, values: unknown[]}}
 */
function updateLoanReturned(id) {
  return {
    text: `
      UPDATE loans
      SET status = 'returned', returned_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id, "bookId" AS "bookId", "userId" AS "userId", status
    `,
    values: [id],
  };
}

/**
 * List every loan, newest first.
 * @returns {{text: string, values: unknown[]}}
 */
function selectAllLoans() {
  return {
    text: `
      SELECT id, "bookId" AS "bookId", "userId" AS "userId", status
      FROM loans
      ORDER BY id DESC
    `,
    values: [],
  };
}

/**
 * Map a raw pg row to the REST contract shape `{id, bookId, userId, status}`.
 * @param {LoanRow} row
 * @returns {{id: string, bookId: string, userId: string, status: string}}
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
  selectActiveLoan,
  insertLoan,
  selectLoanById,
  updateLoanReturned,
  selectAllLoans,
  toLoan,
};