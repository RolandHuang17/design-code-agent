/**
 * User Service – Entry Point
 *
 * Internal service listening on USER_SERVICE_PORT (default 3003).
 * Not exposed to browsers directly; gateway proxies requests.
 * Responsible for user profile resolution and OIDC token helpers.
 */

const express = require('express');
const { initPool, runMigrations, closePool, healthCheck: dbHealth } = require('@spacefractions/shared/db');
const { initCache, closeCache, healthCheck: cacheHealth } = require('@spacefractions/shared/cache');
const { configure: configureAuth } = require('@spacefractions/shared/auth');
const { errorHandler } = require('@spacefractions/shared/errors');
const { metricsMiddleware, getMetrics, getContentType } = require('@spacefractions/shared/metrics');

const routes = require('./routes');

const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.USER_SERVICE_PORT || '3003', 10);
const METRICS_PORT = parseInt(process.env.USER_METRICS_PORT || '9093', 10);

async function main() {
  // Configure OIDC validation (issuer/audience from environment).
  configureAuth({});

  // PostgreSQL is required; fail fast if unavailable.
  await initPool({});

  // Cache is best-effort; degrade gracefully on failure.
  try { await initCache({}); } catch (err) { console.warn('User service: Redis unavailable:', err.message); }

  // Run migrations (idempotent via IF NOT EXISTS).
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'sql', '001_initial.sql'),
      'utf-8'
    );
    await runMigrations(sql);
    console.log('User service: migrations applied');
  } catch (err) {
    console.warn('User service: migration skipped:', err.message);
  }

  const app = express();
  app.use(express.json());
  app.use(metricsMiddleware);

  // Health check
  app.get('/health', async (_req, res) => {
    const dbOk = await dbHealth();
    const cacheOk = await cacheHealth();
    res.status(200).json({
      status: 'ok',
      service: 'user-service',
      database: dbOk ? 'healthy' : 'unhealthy',
      cache: cacheOk ? 'healthy' : 'unavailable'
    });
  });

  // API routes (mounted under /api/users by gateway, also available directly)
  app.use('/api/users', routes);

  // Error handler
  app.use(errorHandler);

  // Start main server
  app.listen(PORT, () => {
    console.log(`User service listening on port ${PORT}`);
  });

  // Metrics server (separate port)
  const metricsApp = express();
  metricsApp.get('/metrics', async (_req, res) => {
    res.set('Content-Type', getContentType());
    res.send(await getMetrics());
  });
  metricsApp.listen(METRICS_PORT, () => {
    console.log(`User service metrics on port ${METRICS_PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('User service shutting down...');
    await closeCache();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('User service failed to start:', err);
  process.exit(1);
});