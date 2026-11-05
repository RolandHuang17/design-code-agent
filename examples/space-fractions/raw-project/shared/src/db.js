/**
 * PostgreSQL database pool and query helpers.
 */

const { Pool } = require('pg');

let pool = null;

/**
 * Initialize the database pool.
 */
function initPool(config) {
  if (pool) return pool;

  pool = new Pool({
    host: config.PGHOST || process.env.PGHOST || 'localhost',
    port: parseInt(config.PGPORT || process.env.PGPORT || '5432', 10),
    database: config.PGDATABASE || process.env.PGDATABASE || 'spacefractions',
    user: config.PGUSER || process.env.PGUSER || 'spacefractions',
    password: config.PGPASSWORD || process.env.PGPASSWORD || 'spacefractions',
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });

  return pool;
}

/**
 * Get the current pool instance.
 */
function getPool() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initPool() first.');
  }
  return pool;
}

/**
 * Execute a query with params.
 */
async function query(sql, params) {
  const client = await getPool().connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

/**
 * Execute a query and return a single row or null.
 */
async function queryOne(sql, params) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

/**
 * Run `fn(client)` inside a PostgreSQL transaction on a single dedicated
 * client. `client` supports `query` and `queryOne` (single-row helper).
 * Commits on success, rolls back on error. Releases the client to the pool
 * in all cases.
 *
 * @param {(client: {query: Function, queryOne: Function}) => Promise<any>} fn
 * @returns {Promise<any>} fn's return value
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const txClient = {
      query: (sql, params) => client.query(sql, params),
      queryOne: async (sql, params) => {
        const r = await client.query(sql, params);
        return r.rows[0] || null;
      }
    };
    let result;
    try {
      result = await fn(txClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Strip leading/trailing whitespace and, when the whole script is wrapped
 * in an explicit `BEGIN;` / `COMMIT;` pair, remove that wrapper so the
 * migration can be executed inside our own transaction. This avoids nested
 * `BEGIN` (which PostgreSQL treats as a warning) and keeps a single,
 * well-defined transaction boundary owned by runMigrations.
 */
function unwrapExplicitTransaction(sqlContent) {
  let sql = String(sqlContent || '').trim();
  if (!sql) return sql;
  if (/^BEGIN\s*;?\s*$/i.test(sql)) {
    // unlikely leading BEGIN on its own first line; handled by regex below
  }
  const beginMatch = /^BEGIN\s*;?\s*(?:\r?\n|$)/i;
  const endMatch = /\bCOMMIT\s*;?\s*$/i;
  let start = sql;
  if (beginMatch.test(sql) && endMatch.test(sql)) {
    // Remove the leading BEGIN and trailing COMMIT.
    sql = sql.replace(beginMatch, '');
    sql = sql.replace(endMatch, '');
    sql = sql.trim();
    // If a trailing semicolon was left dangling after COMMIT removal, trim it.
    sql = sql.replace(/;\s*$/, '');
    sql = sql.trim();
  }
  return sql;
}

/**
 * Run a migration from a SQL string on a single owned client inside a
 * transaction with proper rollback on error.
 *
 * The SQL content may contain arbitrary statements (multi-statement `DO $$`
 * blocks, etc.) that cannot be safely split on semicolons. We execute the
 * whole (possibly unwrapped) content in one `client.query()` call on a
 * single connection.
 *
 * Robustness guarantees:
 * - A single owned client is borrowed and released in a finally block.
 * - The migration and its `_schema_migrations` record insert happen in one
 *   transaction; any error rolls back fully, leaving no partial state.
 * - A PostgreSQL advisory lock (`pg_advisory_xact_lock`) serializes
 *   concurrent service startups so two processes cannot both try to apply
 *   the same migration simultaneously.
 * - If the migration was already applied (per `_schema_migrations`), we skip
 *   running it again, making repeated startup safe and idempotent.
 *
 * @param {string} sqlContent - raw SQL migration text
 * @param {string} [name='migration'] - stable identifier for this migration
 */
async function runMigrations(sqlContent, name = 'migration') {
  const script = unwrapExplicitTransaction(sqlContent);
  const client = await getPool().connect();
  let released = false;
  try {
    // Serialize migrations across concurrent processes/connections. The lock
    // is transaction-scoped: it is released automatically at COMMIT/ROLLBACK.
    // Use a deterministic 64-bit key derived from the migration name.
    const lockKey = hashStringToInt64(name);

    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // Ensure the tracking table exists before recording/applying.
      await client.query(
        'CREATE TABLE IF NOT EXISTS _schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
      );

      const applied = await client.query(
        'SELECT 1 FROM _schema_migrations WHERE name = $1',
        [name]
      );
      if (applied.rowCount === 0) {
        // Run the full migration as one unit on this client.
        if (script) {
          await client.query(script);
        }
        await client.query(
          'INSERT INTO _schema_migrations (name) VALUES ($1)',
          [name]
        );
      }

      await client.query('COMMIT');
      return { applied: applied.rowCount === 0, name };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    }
  } finally {
    if (!released) {
      released = true;
      client.release();
    }
  }
}

/**
 * Deterministic FNV-1a hash of a string reduced to a signed 64-bit integer
 * (BigInt), suitable for pg_advisory_xact_lock's bigint argument.
 */
function hashStringToInt64(str) {
  const s = String(str);
  let h = 0xcbf29ce484222325n; // FNV offset basis (64-bit)
  const prime = 0x100000001b3n; // FNV prime (64-bit)
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  // Interpret as signed 64-bit (two's complement) for pg bigint range.
  if (h > 0x7fffffffffffffffn) {
    h = h - 0x10000000000000000n;
  }
  return h.toString();
}

/**
 * Health check: can we connect to the database?
 */
async function healthCheck() {
  try {
    await query('SELECT 1');
    return true;
  } catch (err) {
    console.error('Database health check failed:', err.message);
    return false;
  }
}

/**
 * Close the pool.
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initPool,
  getPool,
  query,
  queryOne,
  withTransaction,
  runMigrations,
  healthCheck,
  closePool
};