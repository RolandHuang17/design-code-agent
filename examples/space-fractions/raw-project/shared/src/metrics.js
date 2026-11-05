/**
 * Prometheus metrics for all services.
 * Each service exposes its own metrics on a configurable port.
 */

const client = require('prom-client');

// Create a Registry
const register = new client.Registry();

// Default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

const gamesCreated = new client.Counter({
  name: 'spacefractions_games_created_total',
  help: 'Total number of games created'
});

const answersSubmitted = new client.Counter({
  name: 'spacefractions_answers_submitted_total',
  help: 'Total number of answers submitted',
  labelNames: ['correct']
});

const questionsCreated = new client.Counter({
  name: 'spacefractions_questions_created_total',
  help: 'Total number of questions created'
});

const activeGames = new client.Gauge({
  name: 'spacefractions_active_games',
  help: 'Number of games currently being played'
});

register.registerMetric(httpRequestDuration);
register.registerMetric(httpRequestsTotal);
register.registerMetric(gamesCreated);
register.registerMetric(answersSubmitted);
register.registerMetric(questionsCreated);
register.registerMetric(activeGames);

/**
 * Express middleware to track HTTP metrics.
 */
function metricsMiddleware(req, res, next) {
  const start = Date.now();
  const origEnd = res.end;

  res.end = function (...args) {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    const statusCode = res.statusCode.toString();

    httpRequestDuration.observe({ method: req.method, route, status_code: statusCode }, duration);
    httpRequestsTotal.inc({ method: req.method, route, status_code: statusCode });

    origEnd.apply(res, args);
  };

  next();
}

/**
 * Return metrics in Prometheus text format.
 */
async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for metrics.
 */
function getContentType() {
  return register.contentType;
}

module.exports = {
  register,
  metricsMiddleware,
  getMetrics,
  getContentType,
  gamesCreated,
  answersSubmitted,
  questionsCreated,
  activeGames,
  httpRequestDuration,
  httpRequestsTotal
};