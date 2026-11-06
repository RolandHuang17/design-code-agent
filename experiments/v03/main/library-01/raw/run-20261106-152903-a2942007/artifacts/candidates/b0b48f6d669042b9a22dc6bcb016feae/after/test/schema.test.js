'use strict';

/**
 * Schema bootstrap tests (NFR2 idempotency, deployment bootstrap).
 *
 * Uses a fake pool that records SQL queries and returns canned results, so
 * `npm test` runs without a live PostgreSQL. The real database behavior
 * (persistence across restart) is exercised by the runtime HTTP acceptance
 * via Docker Compose, which these tests mirror at the SQL-call level.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { bootstrap, SEED_BOOKS } = require('../src/schema');

function makeFakePool(bookCount) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('COUNT(*)::int')) {
        return { rows: [{ count: bookCount }] };
      }
      return { rows: [] };
    },
  };
}

describe('schema bootstrap', () => {
  it('runs idempotent CREATE TABLE IF NOT EXISTS statements', async () => {
    const pool = makeFakePool(0);
    await bootstrap(pool);

    const schemaSql = pool.queries[0].sql;
    assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS books/i);
    assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS loans/i);
    assert.match(
      schemaSql,
      /CREATE UNIQUE INDEX IF NOT EXISTS loans_active_unique/i,
    );
  });

  it('seeds books only when the books table is empty', async () => {
    const pool = makeFakePool(0);
    await bootstrap(pool);

    const inserts = pool.queries.filter((q) =>
      q.sql.includes('INSERT INTO books'),
    );
    assert.equal(inserts.length, SEED_BOOKS.length);
  });

  it('does not overwrite existing books on repeated startup (NFR2)', async () => {
    const pool = makeFakePool(3); // user-created books already present
    await bootstrap(pool);

    const inserts = pool.queries.filter((q) =>
      q.sql.includes('INSERT INTO books'),
    );
    assert.equal(inserts.length, 0);
  });
});