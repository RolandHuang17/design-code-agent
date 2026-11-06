'use strict';

/**
 * Catalog repository: PostgreSQL data access for books.
 *
 * `catalog.js` owns validation and domain rules; this module owns only SQL.
 * It is consumed by the Postgres store so that SQL text and row mapping stay
 * in one place rather than being scattered through the store implementation.
 *
 * Server-side aliasing ensures returned rows use the camelCase contract keys
 * (`availableCopies`) even though PostgreSQL columns are quoted camelCase
 * identifiers. Parameterized statements prevent SQL injection.
 */

/** @typedef {{id: string, title: string, availableCopies: number}} BookRow */

/**
 * Insert a new book row. `availableCopies` starts equal to `copies` (FR1).
 * @param {{title: string, copies: number}} data validated input.
 * @returns {{text: string, values: unknown[]}}
 */
function insertBook(data) {
  return {
    text: `
      INSERT INTO books (title, copies, "availableCopies")
      VALUES ($1, $2, $2)
      RETURNING id, title, "availableCopies" AS "availableCopies"
    `,
    values: [data.title, data.copies],
  };
}

/**
 * List every book, newest first, with its remaining copies.
 * @returns {{text: string, values: unknown[]}}
 */
function selectAllBooks() {
  return {
    text: `
      SELECT id, title, "availableCopies" AS "availableCopies"
      FROM books
      ORDER BY id DESC
    `,
    values: [],
  };
}

/**
 * Fetch a single book by id.
 * @param {number} id positive integer id.
 * @returns {{text: string, values: unknown[]}}
 */
function selectBookById(id) {
  return {
    text: `
      SELECT id, title, "availableCopies" AS "availableCopies"
      FROM books
      WHERE id = $1
    `,
    values: [id],
  };
}

/**
 * Map a raw pg row to the REST contract shape `{id, title, availableCopies}`.
 * pg returns BIGSERIAL as a string, so id is left as-is (JSON serializer keeps
 * it numeric for clients either way), but it is normalized here defensively.
 * @param {BookRow} row
 * @returns {{id: string, title: string, availableCopies: number}}
 */
function toBook(row) {
  return {
    id: row.id,
    title: row.title,
    availableCopies: row.availableCopies,
  };
}

module.exports = {
  insertBook,
  selectAllBooks,
  selectBookById,
  toBook,
};