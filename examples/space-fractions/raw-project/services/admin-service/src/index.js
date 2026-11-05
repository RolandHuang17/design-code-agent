/**
 * Admin Service – Entry Point
 *
 * Internal service listening on ADMIN_SERVICE_PORT (default 3004).
 * Not exposed to browsers directly; the gateway proxies /api/admin here.
 * Responsible for authenticated administrator question CRUD.
 *
 * Requires: PostgreSQL (fail-fast), Redis (best-effort), OIDC issuer config.
 * Elasticsearch is used indirectly via the question-service search helper so
 * admin CRUD keeps the search index in sync (best-effort, non-fatal).
 */

const express = require('express');
const {
  initPool,
  runMigrations,
  closePool,
  healthCheck: dbHealth,
} = require('@spacefractions/shared/db');
const { initCache, closeCache } = require('@spacefractions/shared/cache');
const { configure: configureAuth } = require('@spacefractions/shared/auth');
const { errorHandler } = require('@spacefractions/shared/errors');
const {
  metricsMiddleware,
  getMetrics,
  getContentType,
} = require('@spacefractions/shared/metrics');

const routes = require('./routes');
const { initSearch, healthCheck: esHealth, closeSearch } = require('../../question-service/src/search');

const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.ADMIN_SERVICE_PORT || '3004', 10);
const METRICS_PORT = parseInt(process.env.ADMIN_METRICS_PORT || '9094', 10);

async function main() {
  // Initialize OIDC auth configuration from environment.
  configureAuth({});

  // PostgreSQL is required; fail fast if unavailable.
  await initPool({});

  // Cache and search are best-effort; degrade gracefully on failure.
  try {
    await initCache({});
  } catch (err) {
    console.warn('Admin service: Redis unavailable:', err.message);
  }
  initSearch({});

  // Run migrations (idempotent via IF NOT EXISTS).
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'sql', '001_initial.sql'),
      'utf-8'
    );
    await runMigrations(sql);
    console.log('Admin service: migrations applied');
  } catch (err) {
    console.warn('Admin service: migration skipped:', err.message);
  }

  const app = express();
  app.use(express.json());
  app.use(metricsMiddleware);

  // Health check (unauthenticated).
  app.get('/health', async (_req, res) => {
    const dbOk = await dbHealth();
    res.status(200).json({
      status: 'ok',
      service: 'admin-service',
      database: dbOk ? 'healthy' : 'unhealthy',
    });
  });

  app.get('/health/search', async (_req, res) => {
    const esOk = await esHealth();
    res.status(200).json({
      service: 'admin-service',
      elasticsearch: esOk ? 'healthy' : 'unavailable',
    });
  });

  // Admin API routes.
  app.use('/api/admin', routes);

  // Error handler.
  app.use(errorHandler);

  // Start main server.
  app.listen(PORT, () => {
    console.log(`Admin service listening on port ${PORT}`);
  });

  // Metrics server (separate port).
  const metricsApp = express();
  metricsApp.get('/metrics', async (_req, res) => {
    res.set('Content-Type', getContentType());
    res.send(await getMetrics());
  });
  metricsApp.listen(METRICS_PORT, () => {
    console.log(`Admin service metrics on port ${METRICS_PORT}`);
  });

  // Graceful shutdown.
  const shutdown = async () => {
    console.log('Admin service shutting down...');
    await closeSearch();
    await closeCache();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Admin service failed to start:', err);
  process.exit(1);
});