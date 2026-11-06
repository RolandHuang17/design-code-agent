'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { bootstrap, schemaSql } = require('../src/db');

/**
 * A test-only fake pool exposing .query(text) so bootstrap can be exercised
 * without a live PostgreSQL. It records every query string it receives.
 */
function fakePool() {
  const queries = [];
  return {
    queries,
    async query(text) {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('schemaSql (NFR2 / ARCH-DEP-2 / SUPP-IDEMPOTENT-SEED)', () => {
  it('returns the full idempotent schema/seed SQL', () => {
    const sql = schemaSql();
    assert.strictEqual(typeof sql, 'string');
    assert.ok(sql.length > 0);
  });

  it('creates tables and indexes idempotently', () => {
    const sql = schemaSql();
    assert.match(sql, /CREATE TABLE IF NOT EXISTS books/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS loans/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS loans_active_unique/);
  });

  it('seeds only when tables are empty (never overwrites user-created books)', () => {
    const sql = schemaSql();
    // The seed is a DO block guarded by a count check on both tables.
    assert.match(sql, /IF \(SELECT count\(\*\) FROM books\) = 0/);
    assert.match(sql, /AND \(SELECT count\(\*\) FROM loans\) = 0/);
  });
});

describe('bootstrap (NFR2 / ARCH-DEP-2 / SUPP-IDEMPOTENT-SEED)', () => {
  it('runs the schema SQL on a single query call', async () => {
    const pool = fakePool();
    await bootstrap(pool);
    assert.strictEqual(pool.queries.length, 1);
    assert.strictEqual(pool.queries[0], schemaSql());
  });

  it('is idempotent: repeated bootstrap calls run the same idempotent SQL', async () => {
    const pool = fakePool();

    await bootstrap(pool);
    await bootstrap(pool);

    assert.strictEqual(pool.queries.length, 2);
    assert.strictEqual(pool.queries[0], pool.queries[1]);
    // Both runs use IF NOT EXISTS / guarded seed for idempotency.
    assert.match(pool.queries[0], /CREATE TABLE IF NOT EXISTS/);
    assert.match(pool.queries[1], /IF \(SELECT count\(\*\) FROM books\) = 0/);
  });
});