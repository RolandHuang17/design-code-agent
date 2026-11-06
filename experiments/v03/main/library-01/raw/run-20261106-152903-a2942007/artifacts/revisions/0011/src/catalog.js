'use strict';

/**
 * Catalog business module.
 *
 * Thin business layer over the repository contract (src/repository.js). The
 * repository adapters already enforce shared validation and error semantics;
 * this module expresses the catalog use cases explicitly so routes bind to
 * stable behaviour rather than raw adapter calls:
 *
 *   - createBook: create a title with a positive number of copies.
 *   - listBooks:  list titles with their currently available copies.
 *   - getBook:    fetch one title, reporting a 404 when it does not exist.
 */

const { RepositoryError } = require('./repository');

/**
 * @param {object} repo - repository implementing the shared contract in
 *   src/repository.js (createBook, listBooks, getBook, borrow, listLoans,
 *   getLoan, returnLoan).
 */
function createCatalogService(repo) {
  /**
   * Create a book. Delegates validation of the title/copies to the repository,
   * which throws RepositoryError with an HTTP status on invalid input.
   * @param {{title: string, copies: number}} input
   * @returns {{id: number, title: string, availableCopies: number}}
   */
  async function createBook(input) {
    const { title, copies } = input == null ? {} : input;
    return repo.createBook({ title, copies });
  }

  /**
   * List all books with available copies.
   * @returns {Promise<Array<{id: number, title: string, availableCopies: number}>>}
   */
  async function listBooks() {
    return repo.listBooks();
  }

  /**
   * Get a single book, or null when missing.
   * @param {number|string} id
   * @returns {{id: number, title: string, availableCopies: number}|null}
   */
  async function getBook(id) {
    return repo.getBook(id);
  }

  return { createBook, listBooks, getBook };
}

module.exports = {
  createCatalogService,
  RepositoryError,
};