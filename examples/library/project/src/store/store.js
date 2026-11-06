'use strict';

/**
 * Store interface.
 *
 * A store is the single data-access boundary between the Catalog/Loans
 * business modules and persistence. Business modules never touch SQL or
 * in-memory structures directly; they rely on this contract, which lets the
 * same domain rules run over:
 *
 *   - PostgresStore (production): real PostgreSQL16 with transactional row
 *     locks on a single client (see src/store/postgres.store.js).
 *   - MemoryStore  (tests): a test-only adapter for `npm test`, which must
 *     pass without a live PostgreSQL. It is never selected by the server
 *     entrypoint, so there is no in-memory fallback in production.
 *
 * This file exports the shape documentation and the repository modules' row
 * mappers used by the Postgres store, plus the store factory used by the
 * server to choose the correct implementation at boot.
 */

/**
 * @typedef {object} Store
 *
 * Catalog part (FR1, FR2):
 * @property {(data: {title: string, copies: number}) => Promise<object>} createBook
 *           Creates a title with `copies` copies; resolves to
 *           `{id, title, availableCopies}` with `availableCopies === copies`.
 * @property {() => Promise<Array<{id: string, title: string, availableCopies: number}>>} listBooks
 *           Lists every book with remaining copies.
 * @property {(id: number) => Promise<object|null|undefined>} getBook
 *           Resolves to `{id, title, availableCopies}` or null/undefined when
 *           the book does not exist.
 *
 * Loans part (FR2, FR3, FR4, NFR1):
 * @property {(args: {bookId: number, userId: string}) => Promise<{outcome: string, loan?: object}>} borrow
 *           Atomically validates stock and the absence of an active loan, then
 *           decrements `availableCopies` and inserts an active loan. Resolves
 *           with outcome `'ok'` (+ `loan`), `'not_found'`, `'no_stock'`, or
 *           `'duplicate'`.
 * @property {(id: number) => Promise<{outcome: string, loan?: object}>} returnLoan
 *           Restores exactly one copy on first return (outcome `'ok'`), and is
 *           idempotent on repeat (outcome `'already'`, no stock change).
 *           Unknown loans resolve `'not_found'`.
 * @property {() => Promise<Array<{id: string, bookId: string, userId: string, status: string}>>} listLoans
 *           Lists every loan.
 */

/**
 * Injected-test adapter: used only by tests so `npm test` runs without a live
 * PostgreSQL. Implementation lives in src/store/memory.store.js.
 *
 * @param {{now?: () => number}} options optional clock for deterministic tests.
 * @returns {Store}
 */
function createMemoryStore(options) {
  // Lazily require to keep this interface file free of implementation weight;
  // resolves to src/store/memory.store.js.
  // eslint-disable-next-line global-require
  const { createMemoryStore: build } = require('./memory.store');
  return build(options);
}

/**
 * Production adapter: PostgreSQL16 with transactional row-lock semantics.
 * Implementation lives in src/store/postgres.store.js.
 *
 * @param {object} pool a node-postgres `Pool` (or any client exposing `connect`
 *                      and `query`).
 * @returns {Store}
 */
function createPostgresStore(pool) {
  // eslint-disable-next-line global-require
  const { createPostgresStore: build } = require('./postgres.store');
  return build(pool);
}

module.exports = {
  createMemoryStore,
  createPostgresStore,
};