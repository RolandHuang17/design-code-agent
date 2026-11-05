/**
 * Question Service – Entry Point
 *
 * Internal service listening on QUESTION_SERVICE_PORT (default 3002).
 * Not exposed to browsers directly; gateway proxies requests.
 * Responsible for question retrieval and full-text search.
 */

const express = require('express');
const { initPool, runMigrations, closePool, healthCheck: dbHealth } = require('@spacefractions/shared/db');
const { initCache, closeCache } = require('@spacefractions/shared/cache');
const { configure: configureAuth } = require('@spacefractions/shared/auth');
const { errorHandler } = require('@spacefractions/shared/errors');
const { metricsMiddleware, getMetrics, getContentType } = require('@spacefractions/shared/metrics');

const routes = require('./routes');
const { initSearch, healthCheck: esHealth, closeSearch } = require('./search');

const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.QUESTION_SERVICE_PORT || '3002', 10);
const METRICS_PORT = parseInt(process.env.QUESTION_METRICS_PORT || '9092', 10);

async function main() {
  // Initialize infrastructure
  configureAuth({});

  // PostgreSQL is required; fail fast if unavailable.
  await initPool({});

  // Cache and search are best-effort; degrade gracefully on failure.
  try { await initCache({}); } catch (err) { console.warn('Question service: Redis unavailable:', err.message); }
  initSearch({});

  // Run migrations (idempotent via IF NOT EXISTS)
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'sql', '001_initial.sql'),
      'utf-8'
    );
    await runMigrations(sql, '001_initial');
    console.log('Question service: migrations applied');
  } catch (err) {
    console.warn('Question service: migration skipped:', err.message);
  }

  const app = express();
  app.use(express.json());
  app.use(metricsMiddleware);

  // Health check
  app.get('/health', async (_req, res) => {
    const dbOk = await dbHealth();
    res.status(200).json({
      status: 'ok',
      service: 'question-service',
      database: dbOk ? 'healthy' : 'unhealthy',
      elasticsearch: 'see /health/search'
    });
  });

  // Detailed search health
  app.get('/health/search', async (_req, res) => {
    const esOk = await esHealth();
    res.status(200).json({
      service: 'question-service',
      elasticsearch: esOk ? 'healthy' : 'unavailable'
    });
  });

  // API routes (mounted under /api/questions by gateway, also available directly)
  app.use('/api/questions', routes);

  // Error handler
  app.use(errorHandler);

  // Start main server
  app.listen(PORT, () => {
    console.log(`Question service listening on port ${PORT}`);
  });

  // Metrics server (separate port)
  const metricsApp = express();
  metricsApp.get('/metrics', async (_req, res) => {
    res.set('Content-Type', getContentType());
    res.send(await getMetrics());
  });
  metricsApp.listen(METRICS_PORT, () => {
    console.log(`Question service metrics on port ${METRICS_PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Question service shutting down...');
    await closeSearch();
    await closeCache();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Question service failed to start:', err);
  process.exit(1);
});