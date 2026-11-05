/**
 * Gateway – Middleware
 *
 * Cross-cutting concerns applied to every request passing through the
 * single entrypoint (port 3000):
 *   - request logging (non-sensitive)
 *   - Prometheus HTTP metrics via the shared metrics registry
 *   - bounded downstream HTTP proxy with per-request timeouts
 *   - JSON body parsing
 */

const { metricsMiddleware } = require('@spacefractions/shared/metrics');

/**
 * Bounded downstream request helper.
 *
 * Makes a fetch() to an internal service with a hard timeout so a slow or
 * unresponsive downstream never hangs the gateway (see the "bounded
 * downstream timeouts" requirement). Returns the parsed JSON body plus
 * status/headers, or throws a GatewayTimeoutError on timeout and a
 * ServiceUnavailableError on connection failure.
 */
const { GatewayTimeoutError, ServiceUnavailableError } = require('@spacefractions/shared/errors');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.DOWNSTREAM_TIMEOUT_MS || '10000', 10);

/**
 * Determine if a service is reachable. Used by the aggregate health check.
 */
async function probeService(baseUrl, path = '/health', timeoutMs = 3000) {
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return {
      ok: resp.ok,
      status: resp.status,
      body: await resp.json().catch(() => null)
    };
  } catch (err) {
    return { ok: false, status: 0, body: { error: err.message } };
  }
}

/**
 * Proxy an inbound request to a downstream service.
 *
 * @param {string} baseUrl - downstream base URL e.g. http://game-service:3001
 * @param {string} path - path to forward (already-stripped prefix)
 * @param {object} req - Express request
 * @param {number} timeoutMs - optional override timeout
 * @returns {Promise<{status: number, headers: Headers, body: any}>}
 */
async function proxyRequest(baseUrl, path, req, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const method = req.method;
  const headers = {
    'Content-Type': 'application/json'
  };

  // Forward authorization so downstream services can enforce ownership
  // and roles independently of the gateway.
  if (req.headers.authorization) {
    headers['Authorization'] = req.headers.authorization;
  }
  if (req.headers['x-request-id']) {
    headers['X-Request-Id'] = req.headers['x-request-id'];
  }

  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

  let resp;
  try {
    resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new GatewayTimeoutError('Downstream service timed out');
    }
    throw new ServiceUnavailableError('Downstream service unavailable');
  }

  let body = null;
  const contentType = resp.headers.get('content-type') || '';
  if (resp.status !== 204 && (contentType.includes('application/json') || contentType === '')) {
    body = await resp.json().catch(() => null);
  }

  return { status: resp.status, headers: resp.headers, body };
}

/**
 * Simple structured request logger. Logs method, path and status only
 * (never request bodies, which may contain answers or credentials).
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    console.log(
      `${req.method} ${req.originalUrl || req.path} ${res.statusCode} ${durationMs}ms`
    );
  });
  next();
}

/**
 * Compose the full middleware stack for the gateway Express app.
 * Order: JSON parsing -> logging -> metrics -> (routes) -> error handler.
 */
function applyGatewayMiddleware(app) {
  app.use(require('express').json());
  app.use(requestLogger);
  app.use(metricsMiddleware);
  return app;
}

module.exports = {
  applyGatewayMiddleware,
  proxyRequest,
  probeService,
  requestLogger,
  DEFAULT_TIMEOUT_MS
};