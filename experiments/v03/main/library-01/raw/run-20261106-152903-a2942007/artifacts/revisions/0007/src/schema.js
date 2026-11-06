'use strict';

/**
 * PostgreSQL schema bootstrap for the library borrowing application.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS so repeated startup never fails.
 * Seed data is inserted only when the books table is empty, so user-created
 * books are preserved across restarts.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS books (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  copies INTEGER NOT NULL CHECK (copies >= 0)
);

CREATE TABLE IF NOT EXISTS loans (
  id BIGSERIAL PRIMARY KEY,
  book_id BIGINT NOT NULL REFERENCES books(id),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'returned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS loans_active_unique
  ON loans (book_id, user_id)
  WHERE status = 'active';
`;

const SEED_BOOKS = [
  { title: 'The Great Gatsby', copies: 3 },
  { title: '1984', copies: 2 },
  { title: 'To Kill a Mockingbird', copies: 1 },
];

/**
 * Create tables and indexes idempotently, then seed books only when empty.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool.
 */
async function bootstrap(pool) {
  await pool.query(SCHEMA_SQL);

  const existing = await pool.query('SELECT COUNT(*)::int AS count FROM books');
  if (existing.rows[0].count > 0) {
    return;
  }

  for (const book of SEED_BOOKS) {
    await pool.query('INSERT INTO books (title, copies) VALUES ($1, $2)', [
      book.title,
      book.copies,
    ]);
  }
}

module.exports = { bootstrap, SEED_BOOKS };