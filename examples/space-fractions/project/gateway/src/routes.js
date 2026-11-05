/**
 * Gateway – Routes
 *
 * Single entrypoint (port 3000) that forwards to the four internal services.
 *
 * Downstream service base URLs are resolved from environment with sensible
 * Compose defaults so the gateway works both in `docker compose up` and when
 * services are run locally on distinct ports.
 */

const { Router } = require('express');
const path = require('path');
const { proxyRequest, probeService } = require('./middleware');

const router = Router();

// Downstream base URLs (Compose service names by default).
const GAME_SERVICE_URL = process.env.GAME_SERVICE_URL || 'http://localhost:3001';
const QUESTION_SERVICE_URL = process.env.QUESTION_SERVICE_URL || 'http://localhost:3002';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3003';
const ADMIN_SERVICE_URL = process.env.ADMIN_SERVICE_URL || 'http://localhost:3004';

/**
 * Wrap a downstream call and forward its status/body/headers to the client.
 * Downstream AppError payloads are preserved verbatim.
 */
function forward(baseUrl, strippedPathBuilder) {
  return async (req, res, next) => {
    try {
      const strippedPath = strippedPathBuilder(req);
      const result = await proxyRequest(baseUrl, strippedPath, req);
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Health + meta
 * ------------------------------------------------------------------ */

/**
 * GET /health
 * Gateway-level liveness. Returns 200 when the gateway process is up.
 * Dependency states are reported but do not fail the liveness probe.
 */
router.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    service: 'gateway',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /health/ready
 * Aggregate readiness: reports downstream reachability. A ready gateway
 * should report each dependency's ok/failing state without masking.
 */
router.get('/health/ready', async (_req, res) => {
  const [game, question, user, admin] = await Promise.all([
    probeService(GAME_SERVICE_URL),
    probeService(QUESTION_SERVICE_URL),
    probeService(USER_SERVICE_URL),
    probeService(ADMIN_SERVICE_URL)
  ]);

  const allOk = game.ok && question.ok && user.ok && admin.ok;

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'degraded',
    services: {
      game: game.status,
      question: question.status,
      user: user.status,
      admin: admin.status
    }
  });
});

/**
 * GET /openapi.yaml
 * Serve the OpenAPI specification describing this gateway's public contract.
 */
router.get('/openapi.yaml', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'openapi.yaml'));
});

/**
 * GET /api/oidc/config
 * Public (non-secret) OIDC client configuration consumed by the browser UI
 * to run the Authorization Code + PKCE flow. Never exposes a client secret.
 */
router.get('/api/oidc/config', (_req, res) => {
  res.json({
    issuer:
      process.env.OIDC_ISSUER ||
      process.env.ORIGIN_ISSUER ||
      'http://localhost:8080/realms/space-fractions',
    clientId: process.env.OIDC_CLIENT_ID || 'space-fractions-client',
    audience: process.env.OIDC_AUDIENCE || 'account'
  });
});

/* ------------------------------------------------------------------ *
 * Compatibility route (original GET /play from Architecture_Documentation.md)
 * ------------------------------------------------------------------ */

/**
 * GET /play
 * Legacy endpoint retained for backwards compatibility with the original
 * architecture doc. Returns a landing payload describing how to start a game
 * via POST /api/games (no game is created implicitly; this avoids stateful
 * GET side-effects).
 */
router.get('/play', (_req, res) => {
  res.json({
    message: 'Space Fractions',
    play: 'POST /api/games to start a new game',
    help: 'GET /api/help for usage instructions'
  });
});

/* ------------------------------------------------------------------ *
 * Game service (mounted at /api/games)
 * ------------------------------------------------------------------ */

router.post('/api/games', forward(GAME_SERVICE_URL, () => '/api/games'));
router.get('/api/games', forward(GAME_SERVICE_URL, () => '/api/games'));
router.get('/api/games/:id', forward(GAME_SERVICE_URL, (req) => `/api/games/${req.params.id}`));
router.post('/api/games/:id/pause', forward(GAME_SERVICE_URL, (req) => `/api/games/${req.params.id}/pause`));
router.post('/api/games/:id/resume', forward(GAME_SERVICE_URL, (req) => `/api/games/${req.params.id}/resume`));
router.post('/api/games/:id/answers', forward(GAME_SERVICE_URL, (req) => `/api/games/${req.params.id}/answers`));
router.get('/api/games/:id/score', forward(GAME_SERVICE_URL, (req) => `/api/games/${req.params.id}/score`));

/* ------------------------------------------------------------------ *
 * Question service (mounted at /api/questions)
 * ------------------------------------------------------------------ */

router.get('/api/questions', forward(QUESTION_SERVICE_URL, () => '/api/questions'));
router.get('/api/questions/search', forward(QUESTION_SERVICE_URL, () => '/api/questions/search'));
router.get('/api/questions/:id', forward(QUESTION_SERVICE_URL, (req) => `/api/questions/${req.params.id}`));

/* ------------------------------------------------------------------ *
 * User service (mounted at /api/users)
 * ------------------------------------------------------------------ */

router.get('/api/users/me', forward(USER_SERVICE_URL, () => '/api/users/me'));
router.get('/api/users/oidc/callback', forward(USER_SERVICE_URL, () => '/api/users/oidc/callback'));
router.get('/api/users/:id', forward(USER_SERVICE_URL, (req) => `/api/users/${req.params.id}`));

/* ------------------------------------------------------------------ *
 * Admin service (mounted at /api/admin)
 * ------------------------------------------------------------------ */

router.get('/api/admin/questions', forward(ADMIN_SERVICE_URL, () => '/api/admin/questions'));
router.post('/api/admin/questions', forward(ADMIN_SERVICE_URL, () => '/api/admin/questions'));
router.get('/api/admin/questions/:id', forward(ADMIN_SERVICE_URL, (req) => `/api/admin/questions/${req.params.id}`));
router.put('/api/admin/questions/:id', forward(ADMIN_SERVICE_URL, (req) => `/api/admin/questions/${req.params.id}`));
router.delete('/api/admin/questions/:id', forward(ADMIN_SERVICE_URL, (req) => `/api/admin/questions/${req.params.id}`));

module.exports = router;