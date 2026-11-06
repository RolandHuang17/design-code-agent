'use strict';

/**
 * PostgresStore: production data-access adapter backed by PostgreSQL16.
 *
 * This is the only adapter selected by the server entrypoint; there is no
 * in-memory fallback. Borrowing and returning run inside a transaction on a
 * single dedicated client (BEGIN ... COMMIT) with an explicit row lock on the
 * target book row (`SELECT ... FOR UPDATE`), so concurrent borrowers of the
 * last copy serialize correctly and stock can never go negative (NFR1).
 *
 * It consumes the parameterized statements and row mappers from
 * `catalog.repo.js` / `loans.repo.js`, keeping every SQL text and row-map in a
 * single place rather than scattering them through the store.
 */

const catalogRepo = require('../catalog/catalog.repo');
const loansRepo = require('../loans/loans.repo');

/**
 * Build a Postgres-backed store over a node-postgres Pool.
 *
 * `pool` only needs to expose `query(text, values)` (used by the simple,
 * auto-commit catalog reads/writes) and `connect()` (returning a client with
 * `query`/`release`) for the transactional loan workflows. The db bootstrap
 * module relies on the same `query` shape.
 *
 * @param {import('pg').Pool} pool
 * @returns {import('./store').Store}
 */
function createPostgresStore(pool) {
  return {
    // ---- Catalog ------------------------------------------------

    async createBook({ title, copies }) {
      const q = catalogRepo.insertBook({ title, copies });
      const result = await pool.query(q.text, q.values);
      return catalogRepo.toBook(result.rows[0]);
    },

    async listBooks() {
      const q = catalogRepo.selectAllBooks();
      const result = await pool.query(q.text, q.values);
      return result.rows.map((row) => catalogRepo.toBook(row));
    },

    async getBook(id) {
      const q = catalogRepo.selectBookById(id);
      const result = await pool.query(q.text, q.values);
      if (result.rows.length === 0) return null;
      return catalogRepo.toBook(result.rows[0]);
    },

    // ---- Loans ---------------------------------------------------

    async borrow({ bookId, userId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the book row so concurrent borrowers serialize on it. Locking
        // in FOR UPDATE also brings the current availableCopies visible to
        // this transaction's snapshot for the decrement below.
        const bookRes = await client.query(
          'SELECT id, "availableCopies" FROM books WHERE id = $1 FOR UPDATE',
          [bookId],
        );
        if (bookRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return { outcome: 'not_found' };
        }

        // Explicit duplicate check (distinct error from no-stock). The partial
        // unique index backstops this, but an explicit check maps the failure
        // to a stable `duplicate` outcome.
        const activeLoan = await client.query(
          loansRepo.selectActiveLoan(bookId, userId).text,
          loansRepo.selectActiveLoan(bookId, userId).values,
        );
        if (activeLoan.rows.length > 0) {
          await client.query('ROLLBACK');
          return { outcome: 'duplicate' };
        }

        const available = bookRes.rows[0]['availableCopies'];
        if (available <= 0) {
          await client.query('ROLLBACK');
          return { outcome: 'no_stock' };
        }

        // Atomically decrement stock and insert the active loan.
        await client.query(
          'UPDATE books SET "availableCopies" = "availableCopies" - 1 WHERE id = $1',
          [bookId],
        );
        const ins = loansRepo.insertLoan({ bookId, userId });
        const inserted = await client.query(ins.text, ins.values);

        await client.query('COMMIT');
        return { outcome: 'ok', loan: loansRepo.toLoan(inserted.rows[0]) };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async returnLoan(id) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const loanRes = await client.query(
          loansRepo.selectLoanById(id).text,
          loansRepo.selectLoanById(id).values,
        );
        if (loanRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return { outcome: 'not_found' };
        }

        const loan = loansRepo.toLoan(loanRes.rows[0]);

        // Idempotent return: an already-returned loan yields 'already' and
        // changes nothing; a fresh return flips status to 'returned' and
        // restores exactly one copy.
        if (loan.status !== 'active') {
          await client.query('ROLLBACK');
          return { outcome: 'already', loan };
        }

        // Lock the book row to serialize with concurrent borrowers.
        const bookRes = await client.query(
          'SELECT id FROM books WHERE id = $1 FOR UPDATE',
          [loan.bookId],
        );
        if (bookRes.rows.length === 0) {
          // Book was deleted underneath the loan (ON DELETE CASCADE would have
          // removed the loan row too, so this is defensive only).
          await client.query('ROLLBACK');
          return { outcome: 'not_found' };
        }

        const upd = loansRepo.updateLoanReturned(id);
        const updated = await client.query(upd.text, upd.values);

        // If the UPDATE returned no rows, another concurrent return already
        // marked it returned; re-read to report the same idempotent result.
        let returnedLoan;
        if (updated.rows.length > 0) {
          returnedLoan = loansRepo.toLoan(updated.rows[0]);
          await client.query(
            'UPDATE books SET "availableCopies" = "availableCopies" + 1 WHERE id = $1',
            [loan.bookId],
          );
          await client.query('COMMIT');
          return { outcome: 'ok', loan: returnedLoan };
        }

        // Concurrent duplicate: stock was already restored by the other
        // transaction; do not increment again (FR4).
        await client.query('ROLLBACK');
        const reread = await pool.query(
          loansRepo.selectLoanById(id).text,
          loansRepo.selectLoanById(id).values,
        );
        return { outcome: 'already', loan: loansRepo.toLoan(reread.rows[0]) };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async listLoans() {
      const q = loansRepo.selectAllLoans();
      const result = await pool.query(q.text, q.values);
      return result.rows.map((row) => loansRepo.toLoan(row));
    },
  };
}

module.exports = { createPostgresStore };