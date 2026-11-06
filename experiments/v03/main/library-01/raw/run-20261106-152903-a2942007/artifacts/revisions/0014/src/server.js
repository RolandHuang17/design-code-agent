'use strict';

/**
 * Gateway entrypoint.
 *
 * Connects to PostgreSQL via a connection pool, runs the idempotent schema
 * bootstrap, serves the browser UI at / and the REST API, and exposes /health.
 * Connection settings are driven by environment variables (.env).
 */

const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');
const { createApp } = require('./app');
const { PgRepository } = require('./pgRepository');
const { bootstrap } = require('./schema');

const PORT = Number(process.env.PORT) || 3000;

function createPool() {
  return new Pool({
    host: process.env.PGHOST || 'postgres',
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE || 'library',
    user: process.env.PGUSER || 'library',
    password: process.env.PGPASSWORD || 'library',
  });
}

async function main() {
  const pool = createPool();

  // Idempotent schema bootstrap; seeds only when the books table is empty so
  // repeated startup never overwrites user-created books.
  await bootstrap(pool);

  const repository = new PgRepository(pool);
  const app = createApp(repository);

  // Serve browser UI at /.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Library gateway listening on port ${PORT}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { app, server, pool };
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start gateway:', err);
    process.exit(1);
  });
}

module.exports = { main, createPool };