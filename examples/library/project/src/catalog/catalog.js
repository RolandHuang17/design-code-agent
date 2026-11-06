'use strict';

/**
 * Catalog business module.
 *
 * Pure domain logic over an injected store. The store exposes opaque data
 * access (Postgres in production, in-memory adapter in tests); this module
 * owns validation and maps store outcomes to domain results/errors so route
 * handlers can translate them to HTTP statuses without knowing about SQL.
 */

const VALID_TITLE_MAX_LENGTH = 500;

/**
 * Catalog errors carry a stable code for route-level HTTP mapping.
 *   - VALIDATION      -> 400
 *   - NOT_FOUND       -> 404
 */
class CatalogError extends Error {
  /**
   * @param {string} code one of 'VALIDATION' | 'NOT_FOUND'
   * @param {string} message human-readable reason
   */
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

/**
 * Validate and normalize the `{ title, copies }` input used to create a book.
 * @param {{title: unknown, copies: unknown}} input
 * @returns {{title: string, copies: number}}
 * @throws {CatalogError} with code 'VALIDATION' when invalid.
 */
function validateBookInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CatalogError('VALIDATION', 'request body must be an object');
  }

  const title = input.title;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new CatalogError('VALIDATION', 'title must be a non-empty string');
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length > VALID_TITLE_MAX_LENGTH) {
    throw new CatalogError(
      'VALIDATION',
      `title must be at most ${VALID_TITLE_MAX_LENGTH} characters`,
    );
  }

  const copies = input.copies;
  if (typeof copies !== 'number' || !Number.isInteger(copies) || copies <= 0) {
    throw new CatalogError('VALIDATION', 'copies must be a positive integer');
  }

  return { title: trimmedTitle, copies };
}

/**
 * Create a title with a positive number of copies (FR1).
 * @param {{createBook: (data: {title: string, copies: number}) => Promise<object>}} store
 * @param {{title: unknown, copies: unknown}} input
 * @returns {Promise<object>} created book `{id, title, availableCopies}`.
 */
async function createBook(store, input) {
  const { title, copies } = validateBookInput(input);
  return store.createBook({ title, copies });
}

/**
 * List all books with their remaining copies.
 * @param {{listBooks: () => Promise<object[]>}} store
 * @returns {Promise<object[]>}
 */
async function listBooks(store) {
  const books = await store.listBooks();
  return { books };
}

/**
 * Fetch a single book by id.
 * @param {{getBook: (id: unknown) => Promise<object|null|undefined>}} store
 * @param {unknown} id raw id from the route.
 * @returns {Promise<object>} `{id, title, availableCopies}`.
 * @throws {CatalogError} code 'NOT_FOUND' for unknown or invalid id.
 */
async function getBook(store, id) {
  const parsed = parsePositiveInt(id);
  if (parsed === null) {
    throw new CatalogError('NOT_FOUND', 'book not found');
  }
  const book = await store.getBook(parsed);
  if (book == null) {
    throw new CatalogError('NOT_FOUND', 'book not found');
  }
  return book;
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
  CatalogError,
  createBook,
  listBooks,
  getBook,
  validateBookInput,
  parsePositiveInt,
};