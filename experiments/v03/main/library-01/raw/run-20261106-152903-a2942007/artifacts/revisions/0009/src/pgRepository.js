'use strict';

/**
 * PostgreSQL repository implementing the shared repository contract in
 * src/repository.js. Borrowing and returning run inside a transaction on a
 * single client with row locks so concurrent borrowers cannot push available
 * copies below zero and concurrent returns never restore stock more than once.
 */

const {
  RepositoryError,
  assertBookInput,
  toBook,
  toLoan,
} = require('./repository');

const BOOK_COLUMNS = 'id, title, copies';

function rowToBook(row) {
  return toBook(row);
}

function rowToLoan(row) {
  return toLoan({
    id: row.id,
    bookId: row.book_id,
    userId: row.user_id,
    status: row.status,
  });
}

class PgRepository {
  /**
   * @param {import('pg').Pool} pool - PostgreSQL connection pool.
   */
  constructor(pool) {
    this.pool = pool;
  }

  async createBook({ title, copies }) {
    assertBookInput(title, copies);
    try {
      const result = await this.pool.query(
        'INSERT INTO books (title, copies) VALUES ($1, $2) RETURNING ' + BOOK_COLUMNS,
        [title, copies]
      );
      return rowToBook(result.rows[0]);
    } catch (err) {
      if (err.code === '23514') {
        throw new RepositoryError('INVALID_COPIES', 'Copies must be a positive integer', 400);
      }
      throw err;
    }
  }

  async listBooks() {
    const result = await this.pool.query(
      'SELECT ' + BOOK_COLUMNS + ' FROM books ORDER BY id'
    );
    return result.rows.map(rowToBook);
  }

  async getBook(id) {
    const result = await this.pool.query(
      'SELECT ' + BOOK_COLUMNS + ' FROM books WHERE id = $1',
      [id]
    );
    return result.rows.length === 0 ? null : rowToBook(result.rows[0]);
  }

  /**
   * Borrow one available copy for a reader. Uses a transaction and FOR UPDATE
   * row lock on the book to serialise concurrent borrowers.
   */
  async borrow(bookId, userId) {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new RepositoryError('INVALID_USER_ID', 'userId must be a non-empty string', 400);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const bookResult = await client.query(
        'SELECT id, title, copies FROM books WHERE id = $1 FOR UPDATE',
        [bookId]
      );
      if (bookResult.rows.length === 0) {
        throw new RepositoryError('NOT_FOUND', 'Book not found', 404);
      }
      const book = bookResult.rows[0];

      if (book.copies <= 0) {
        throw new RepositoryError('NO_STOCK', 'No available copies', 409);
      }

      const duplicate = await client.query(
        "SELECT id FROM loans WHERE book_id = $1 AND user_id = $2 AND status = 'active'",
        [bookId, userId]
      );
      if (duplicate.rows.length > 0) {
        throw new RepositoryError('DUPLICATE_LOAN', 'Reader already has an active loan', 409);
      }

      const loanResult = await client.query(
        "INSERT INTO loans (book_id, user_id, status) VALUES ($1, $2, 'active') RETURNING id, book_id, user_id, status",
        [bookId, userId]
      );

      await client.query('UPDATE books SET copies = copies - 1 WHERE id = $1', [bookId]);

      await client.query('COMMIT');
      return rowToLoan(loanResult.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listLoans() {
    const result = await this.pool.query(
      'SELECT id, book_id, user_id, status FROM loans ORDER BY id'
    );
    return result.rows.map(rowToLoan);
  }

  async getLoan(id) {
    const result = await this.pool.query(
      'SELECT id, book_id, user_id, status FROM loans WHERE id = $1',
      [id]
    );
    return result.rows.length === 0 ? null : rowToLoan(result.rows[0]);
  }

  /**
   * Return a loan. Idempotent: returning an already-returned loan leaves stock
   * untouched. The transition from active -> returned increments stock exactly
   * once inside a transaction with a row lock.
   */
  async returnLoan(id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const loanResult = await client.query(
        'SELECT id, book_id, user_id, status FROM loans WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (loanResult.rows.length === 0) {
        throw new RepositoryError('NOT_FOUND', 'Loan not found', 404);
      }
      const loan = loanResult.rows[0];

      if (loan.status === 'returned') {
        await client.query('COMMIT');
        return rowToLoan(loan);
      }

      await client.query(
        "UPDATE loans SET status = 'returned', returned_at = now() WHERE id = $1",
        [id]
      );
      await client.query('UPDATE books SET copies = copies + 1 WHERE id = $1', [loan.book_id]);

      await client.query('COMMIT');

      const updated = await this.pool.query(
        'SELECT id, book_id, user_id, status FROM loans WHERE id = $1',
        [id]
      );
      return rowToLoan(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { PgRepository };