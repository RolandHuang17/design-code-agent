'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let schemaSqlCache = null;

/**
 * Load the schema/seed SQL file. Cached in-process so repeated bootstraps
 * don't re-read from disk.
 * @returns {string}
 */
function schemaSql() {
  if (schemaSqlCache === null) {
    schemaSqlCache = fs.readFileSync(SCHEMA_PATH, 'utf8');
  }
  return schemaSqlCache;
}

/**
 * Idempotent PostgreSQL schema bootstrap and seed.
 *
 * Runs the schema.sql DDL/seed on a single client. The SQL itself uses
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` and seeds only
 * when both tables are empty, so repeated startup never overwrites
 * user-created books or loans.
 *
 * @param {import('pg').Pool} pool PostgreSQL pool (or any object exposing `.query(text)`).
 * @returns {Promise<void>}
 */
async function bootstrap(pool) {
  await pool.query(schemaSql());
}

module.exports = { bootstrap, schemaSql };