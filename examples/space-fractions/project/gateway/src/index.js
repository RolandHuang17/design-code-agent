/**
 * Gateway – Entry Point
 *
 * Single entrypoint for the Space Fractions system, listening on port 3000.
 *
 * Responsibilities:
 *   - serve the browser UI from gateway/public (/) 
 *   - forward /api/* to the four internal services with bounded timeouts
 *   - expose /health (liveness) and /health/ready (aggregated readiness)
 *   - expose Prometheus metrics on a dedicated port (default 9095)
 *   - serve the OpenAPI spec at /openapi.yaml
 *
 * This process does NOT own game/question/user data; each downstream service
 * remains the authoritative owner and returns structured AppError payloads
 * that the gateway relays untouched.
 */

const express = require('express');
const path = require('path');
const { applyGatewayMiddleware } = require('./middleware');
const { errorHandler } = require('@spacefractions/shared/errors');
const { configure: configureAuth } = require('@spacefractions/shared/auth');
const { getMetrics, getContentType } = require('@spacefractions/shared/metrics');
const routes = require('./routes');

const PORT = parseInt(process.env.PORT || '3000', 10);
const METRICS_PORT = parseInt(process.env.GATEWAY_METRICS_PORT || '9095', 10);

function main() {
  // Configure OIDC validation (issue/audience enforcement) for downstream
  // services; the gateway itself is mostly a passthrough but shares the same
  // claims semantics so it can add request-scoped context in the future.
  configureAuth({});

  const app = express();
  applyGatewayMiddleware(app);

  // Static browser UI. Served before the API routes so "/" resolves to
  // index.html and unknown non-/api paths fall through to the UI shell.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // API + meta routes.
  app.use(routes);

  // SPA fallback: any non-API GET returns the UI shell.
  app.get(/^\/(?!api\/|health|openapi).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Central error handler (relays downstream AppError status/code/message).
  app.use(errorHandler);

  const server = app.listen(PORT, () => {
    console.log(`Gateway listening on port ${PORT}`);
  });

  // Metrics endpoint on a dedicated port (scraped by Prometheus).
  const metricsApp = express();
  metricsApp.get('/metrics', async (_req, res) => {
    res.set('Content-Type', getContentType());
    res.send(await getMetrics());
  });
  metricsApp.listen(METRICS_PORT, () => {
    console.log(`Gateway metrics on port ${METRICS_PORT}`);
  });

  // Graceful shutdown.
  const shutdown = () => {
    console.log('Gateway shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();