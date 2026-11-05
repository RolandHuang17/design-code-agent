/**
 * Game Service – Entry Point
 *
 * Internal service listening on GAME_SERVICE_PORT (default 3001).
 * Not exposed to browsers directly; gateway proxies requests.
 */

const express = require('express');
const { initPool, runMigrations, closePool, healthCheck } = require('@spacefractions/shared/db');
const { initCache, closeCache } = require('@spacefractions/shared/cache');
const { initMQ, closeMQ } = require('@spacefractions/shared/mq');
const { configure: configureAuth } = require('@spacefractions/shared/auth');
const { errorHandler } = require('@spacefractions/shared/errors');
const { metricsMiddleware, getMetrics, getContentType } = require('@spacefractions/shared/metrics');

const routes = require('./routes');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.GAME_SERVICE_PORT || '3001', 10);
const METRICS_PORT = parseInt(process.env.GAME_METRICS_PORT || '9091', 10);

async function main() {
  // Initialize infrastructure
  configureAuth({});
  await initPool({});
  await initCache({});
  try { await initMQ({}); } catch { /* non-critical */ }

  // Run migrations
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'sql', '001_initial.sql'),
      'utf-8'
    );
    await runMigrations(sql, '001_initial');
    console.log('Game service: migrations applied');
  } catch (err) {
    console.warn('Game service: migration skipped (may already be applied):', err.message);
  }

  const app = express();
  app.use(express.json());
  app.use(metricsMiddleware);

  // Health check
  app.get('/health', async (_req, res) => {
    const dbOk = await healthCheck();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      service: 'game-service',
      database: dbOk ? 'healthy' : 'unhealthy'
    });
  });

  // API routes (mounted under /api/games by gateway, but also available directly)
  app.use('/api/games', routes);

  // Error handler
  app.use(errorHandler);

  // Start main server
  app.listen(PORT, () => {
    console.log(`Game service listening on port ${PORT}`);
  });

  // Metrics server (separate port)
  const metricsApp = express();
  metricsApp.get('/metrics', async (_req, res) => {
    res.set('Content-Type', getContentType());
    res.send(await getMetrics());
  });
  metricsApp.listen(METRICS_PORT, () => {
    console.log(`Game service metrics on port ${METRICS_PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Game service shutting down...');
    await closeCache();
    await closeMQ();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Game service failed to start:', err);
  process.exit(1);
});