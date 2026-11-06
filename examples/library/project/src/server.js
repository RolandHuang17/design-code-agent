'use strict';

/**
 * Gateway server entrypoint for the library borrowing application.
 *
 * This file owns process lifecycle only: it reads environment configuration,
 * connects a PostgreSQL pool, bootstraps the (idempotent) schema, selects the
 * PostgresStore (never the in-memory test adapter), and starts the Express app
 * on the container port. Business rules live in src/catalog and src/loans;
 * HTTP wiring lives in src/http/app.js; persistence lives in the store and db
 * modules.
 *
 * Environment variables:
 *   PORT             listen port (default 3000, the compose container port).
 *   PUBLIC_ORIGIN    browser-facing origin; forwarded for redirects and any
 *                    client-facing URL construction by the UI/gateway.
 *   OIDC_ISSUER      identity-provider issuer URL (read/forwarded only; no OAuth
 *                    flow is implemented — reader IDs are caller-provided, not
 *                    authenticated identities).
 *   OIDC_PUBLIC_ORIGIN identity-provider public URL (read/forwarded only).
 *   DATABASE_URL     PostgreSQL connection string (defaults to a local compose
 *                    service DNS name).
 *
 * The exported `createServer`/`start` split keeps this file unit-testable
 * without opening a real socket or touching PostgreSQL.
 */

const { Pool } = require('pg');

const { createApp } = require('./http/app');
const { bootstrap } = require('./db');
const { createPostgresStore } = require('./store/store');

/** Default listening port (container port for the compose gateway). */
const DEFAULT_PORT = 3000;

/** Default PostgreSQL connection string for the compose `postgres` service. */
const DEFAULT_DATABASE_URL =
  'postgresql://library:library@postgres:5432/library';

/**
 * Read string config with a default, trimming accidental whitespace.
 * @param {string} key environment variable name.
 * @param {string} fallback value when unset/empty.
 * @returns {string}
 */
function readEnv(key, fallback) {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/**
 * Parse the listen port, falling back to the default on any non-numeric input.
 * @param {string|undefined} raw
 * @returns {number}
 */
function readPort(raw) {
  const port = Number.parseInt(raw, 10);
  return Number.isNaN(port) ? DEFAULT_PORT : port;
}

/**
 * Build the express app wired to a Postgres-backed store. Exposed so tests can
 * construct the full stack against a given pool without binding a socket.
 * @param {import('pg').Pool} pool
 * @returns {import('express').Express}
 */
function createServer(pool) {
  const store = createPostgresStore(pool);
  return createApp(store);
}

/**
 * Connect to PostgreSQL, bootstrap the schema, and start listening.
 *
 * Schema bootstrap is idempotent (CREATE TABLE IF NOT EXISTS; seed only when
 * empty), so repeated startup never overwrites user-created books or loans.
 *
 * @returns {Promise<void>}
 */
async function start() {
  const connectionString = readEnv('DATABASE_URL', DEFAULT_DATABASE_URL);
  const port = readPort(process.env.PORT);

  const pool = new Pool({ connectionString, max: 10 });

  try {
    // Bootstrap before serving so the first request never hits a missing table.
    await bootstrap(pool);
  } catch (err) {
    console.error('failed to bootstrap database schema:', err.message);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const app = createServer(pool);

  const server = app.listen(port, () => {
    console.log(`library gateway listening on port ${port}`);
  });

  // PUBLIC_ORIGIN and OIDC_* are forwarded (read) as documented gateway public
  // URL configuration; no OAuth flow consumes them in this demonstration.
  const publicOrigin = readEnv('PUBLIC_ORIGIN', '');
  const oidcIssuer = readEnv('OIDC_ISSUER', '');
  const oidcPublicOrigin = readEnv('OIDC_PUBLIC_ORIGIN', '');
  if (publicOrigin) {
    console.log(`public origin: ${publicOrigin}`);
  }
  if (oidcIssuer || oidcPublicOrigin) {
    console.log(
      'OIDC endpoints configured (forwarded only; no auth flow is implemented)',
    );
  }

  // Graceful shutdown: close the HTTP socket then the pool so in-flight
  // transactions can finish and connections are returned to PostgreSQL.
  const shutdown = async (signal) => {
    console.log(`received ${signal}, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only auto-start when run directly (not when required by a test).
if (require.main === module) {
  start().catch((err) => {
    console.error('fatal startup error:', err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
  start,
  readEnv,
  readPort,
  DEFAULT_PORT,
  DEFAULT_DATABASE_URL,
};