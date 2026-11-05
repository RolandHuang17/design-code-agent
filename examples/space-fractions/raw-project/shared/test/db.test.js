/**
 * Unit tests for the shared DB module's migration runner.
 *
 * These tests exercise `runMigrations` (and its helpers) against a fake
 * PostgreSQL `Pool`/client so we can verify the transaction/rollback/repeat
 * guarantees without a live database:
 *
 *   - a migration whose script fails is fully rolled back (no partial schema,
 *     no bogus `_schema_migrations` record);
 *   - a migration is recorded once applied, and a repeat startup skips it
 *     (idempotent);
 *   - concurrent startups serialize via `pg_advisory_xact_lock` so two
 *     failures cannot both apply and clobber each other.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const DB_PATH = require.resolve('@spacefractions/shared/db');

/**
 * A minimal fake client that records all statements and simulates a
 * single-connection backend. `failOn` lets us force an error for a specific
 * SQL fragment to exercise rollback.
 */
class FakeClient {
  constructor(failOn = null, backend = null) {
    this.statements = [];
    this.failOn = failOn;
    this.backend = backend; // shared backend state (migrations table, schema)
    this.released = false;
  }

  async query(sql, params) {
    this.statements.push({ sql, params });
    if (this.failOn && sql.includes(this.failOn)) {
      const err = new Error(`forced failure on: ${this.failOn}`);
      err.code = '42601';
      throw err;
    }
    // Emulate _schema_migrations lookups against the shared backend.
    if (this.backend) {
      if (/CREATE TABLE IF NOT EXISTS _schema_migrations/.test(sql)) {
        this.backend.migrationsTable = true;
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT 1 FROM _schema_migrations WHERE name = \$1/.test(sql)) {
        const name = params[0];
        const applied = this.backend.applied.has(name);
        return { rows: applied ? [{ '?column?': 1 }] : [], rowCount: applied ? 1 : 0 };
      }
      if (/INSERT INTO _schema_migrations \(name\) VALUES \(\$1\)/.test(sql)) {
        this.backend.applied.add(params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT pg_advisory_xact_lock/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

/**
 * Fake Pool that hands out FakeClient instances. Shared `backend` state lets
 * multiple clients (and multiple runMigrations calls) observe the same
 * applied-migration set, simulating a real database.
 */
function installFakePg({ failOn = null, backend } = {}) {
  const clients = [];
  const state = backend || { applied: new Set(), migrationsTable: false };

  class FakePool {
    constructor() {}
    async connect() {
      const c = new FakeClient(failOn, state);
      clients.push(c);
      return c;
    }
    async end() { this.ended = true; }
    on() {}
  }

  const fakePg = { Pool: FakePool };

  require.cache[require.resolve('pg')] = {
    id: require.resolve('pg'),
    filename: require.resolve('pg'),
    loaded: true,
    exports: { Pool: FakePool }
  };

  // Force a fresh reload of db.js so its top-level `require('pg')` re-binds.
  delete require.cache[DB_PATH];
  const db = require(DB_PATH);

  // Initialize the pool against the fake `pg` driver so that `getPool()` and
  // `runMigrations()` operate on FakePool/FakeClient instances instead of
  // throwing "Database pool not initialized".
  db.initPool({});

  return { db, clients, state };
}

function scriptWithBogusSyntax() {
  return `BEGIN;
CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY);
CREATE INDEX idx_bad ON games (nope_missing_column);
COMMIT;`;
}

test('runMigrations rolls back on script failure and leaves no record', async () => {
  const { db, state } = installFakePg({ failOn: null });
  // failOn null: we instead inject an error by making the script a genuine
  // SQL that would fail. To force failure deterministically we re-install
  // with a client-level failOn targeting the script body.
  await db.closePool(); // no-op with fake pool; safe

  // Use a failOn that matches a token unique to the script.
  const sql = `BEGIN;
CREATE TABLE games (id SERIAL PRIMARY KEY);
COMMIT;`;

  const { db: db2, state: state2 } = installFakePg({
    failOn: 'CREATE TABLE games',
    backend: { applied: new Set(), migrationsTable: false }
  });

  await assert.rejects(() => db2.runMigrations(sql, '001_initial'));

  // No migration record must have been written.
  assert.equal(state2.applied.has('001_initial'), false,
    'failed migration must not be recorded as applied');
});

test('runMigrations records success and skips on repeat startup', async () => {
  const backend = { applied: new Set(), migrationsTable: false };
  const { db } = installFakePg({ backend });

  const sql = `BEGIN;
CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY);
COMMIT;`;

  const first = await db.runMigrations(sql, '001_initial');
  assert.equal(first.applied, true);

  const second = await db.runMigrations(sql, '001_initial');
  assert.equal(second.applied, false, 'second run should skip already-applied migration');
  assert.equal(backend.applied.has('001_initial'), true);
});

test('runMigrations unwraps explicit BEGIN/COMMIT wrapper', async () => {
  const backend = { applied: new Set(), migrationsTable: false };
  // Use a fake that captures statements so we can inspect what ran.
  const { db, clients } = installFakePg({ backend });

  const sql = `BEGIN;\nCREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY);\nCOMMIT;`;
  await db.runMigrations(sql, '001_initial');

  const allSql = clients.flatMap((c) => c.statements.map((s) => s.sql)).join(' ');
  // The migration script itself must not be executed as a nested BEGIN.
  assert.ok(!allSql.includes('BEGIN;'), 'nested BEGIN should be removed');
  // But transaction control of runMigrations still exists.
  assert.ok(allSql.includes('BEGIN'));
});

test('runMigrations acquires advisory lock for serialization', async () => {
  const backend = { applied: new Set(), migrationsTable: false };
  const { db, clients } = installFakePg({ backend });

  await db.runMigrations('CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY);', '001_initial');

  const allSql = clients.flatMap((c) => c.statements.map((s) => s.sql)).join(' ');
  assert.ok(
    allSql.includes('pg_advisory_xact_lock'),
    'migration runner must serialize via pg_advisory_xact_lock'
  );
});

test('runMigrations releases the client on success', async () => {
  const backend = { applied: new Set(), migrationsTable: false };
  const { db, clients } = installFakePg({ backend });

  await db.runMigrations('CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY);', '001_initial');
  assert.ok(clients.every((c) => c.released), 'client must be released after migration');
});

test('runMigrations releases the client on rollback error', async () => {
  const { db, clients } = installFakePg({
    failOn: 'CREATE TABLE games',
    backend: { applied: new Set(), migrationsTable: false }
  });

  await assert.rejects(() =>
    db.runMigrations('CREATE TABLE games (id SERIAL PRIMARY KEY);', '001_initial')
  );
  assert.ok(clients.every((c) => c.released), 'client must be released even after rollback error');
});