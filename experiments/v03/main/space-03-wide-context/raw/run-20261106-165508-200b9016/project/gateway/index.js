'use strict';

/**
 * Process bootstrap for the Space Fractions gateway.
 *
 * Constructs the concrete infrastructure adapters (PostgreSQL pool, Redis
 * cache, RabbitMQ score events, Elasticsearch search client, Prometheus
 * metrics) using process environment variables, then builds the Express app via
 * createApp(...) and starts the HTTP server. All integrations degrade
 * gracefully when their backing service is absent or disabled (assumption A-6),
 * so the gateway remains reachable (GET /health -> 200) with PostgreSQL alone.
 *
 * Environment variables respected here (see .env.example):
 *   PORT                  HTTP listen port (default 3000 for the Compose
 *                          browser gateway contract).
 *   DATABASE_URL          PostgreSQL connection string / config (lib/db.js).
 *   REDIS_URL             Redis URL (lib/cache.js).
 *   RABBITMQ_URL          AMQP URL (lib/events.js).
 *   ELASTICSEARCH_URL     Elasticsearch node (lib/search.js).
 *   DISABLED_FEATURES     Comma-separated feature names to disable
 *                          (redis|rabbitmq|elasticsearch|metrics).
 *   OIDC_ISSUER           Public issuer used to validate tokens.
 *   OIDC_JWKS_URI         Internal JWKS URL (defaults to issuer + certs path).
 *   OIDC_AUDIENCE         Expected access-token audience (optional).
 *   REQUIRE_AUTH          "false" disables mandatory auth (dev/test only).
 */

const { createPool, migrate } = require('../lib/db');
const { createCache } = require('../lib/cache');
const { createEventEmitter } = require('../lib/events');
const { createSearchClient } = require('../lib/search');
const { createApp } = require('./app');

function parseDisabledFeatures(raw) {
  const value = (raw || process.env.DISABLED_FEATURES || '');
  return new Set(
    String(value)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parsePort() {
  const port = Number(process.env.PORT || 3000);
  return Number.isInteger(port) && port > 0 ? port : 3000;
}

/**
 * Build the metrics registry (prom-client). Returns null when disabled so the
 * /metrics endpoint still answers 200 with an empty exposition.
 */
function buildMetrics(disabled) {
  if (disabled.has('metrics')) return null;
  try {
    // eslint-disable-next-line global-require
    const client = require('prom-client');
    const registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry });
    return {
      metrics: () => registry.metrics(),
      contentType: registry.contentType,
    };
  } catch (err) {
    // prom-client is a declared dependency; if it is not installed this must
    // surface rather than silently degrade to a fake metrics endpoint.
    console.warn(`metrics disabled: prom-client unavailable (${err.message})`);
    return null;
  }
}

async function main() {
  const disabled = parseDisabledFeatures();
  const requireAuth = process.env.REQUIRE_AUTH !== 'false';

  const pool = createPool(process.env.DATABASE_URL || undefined);

  // Apply idempotent migrations on startup; failure is fatal because PostgreSQL
  // is the system of record and the gateway cannot serve correct game state
  // without it. (Space Fractions migrations are idempotent by construction.)
  try {
    const applied = await migrate(pool);
    console.log(`migrations applied: ${applied.join(', ')}`);
  } catch (err) {
    console.error(`migration failed: ${err.message}`);
    pool.end().catch(() => {});
    process.exit(1);
  }

  const cache = createCache({ disabled });
  const events = createEventEmitter({ disabled });
  const searchClient = createSearchClient({ disabled });
  const metrics = buildMetrics(disabled);

  const app = createApp({
    pool,
    cache,
    events,
    searchClient,
    metrics,
    verifierOptions: {},
    requireAuth,
  });

  const port = parsePort();
  const server = app.listen(port, () => {
    console.log(`Space Fractions gateway listening on 0.0.0.0:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      pool.end()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
    // Force-exit if connections do not drain promptly.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`gateway failed to start: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});