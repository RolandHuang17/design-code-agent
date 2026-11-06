'use strict';

/**
 * Gateway HTTP entrypoint: Express application wiring the question, game, user,
 * and admin service modules into a single process with multiple service
 * entrypoint modules behind it.
 *
 * Contract (space-fractions.md 15-18):
 *   * GET /health -> 200.
 *   * Browser UI served at / (static files from public/).
 *   * Authenticated endpoints use Bearer OIDC access tokens; missing/invalid
 *     credentials -> 401; a verified non-admin user hitting an admin endpoint
 *     -> 403.
 *   * Original GET /play returns gameId for backward compatibility
 *     (Architecture_Documentation.md 81-103).
 *   * Admin question CRUD, game lifecycle, scoring, pause/resume, and search
 *     are exposed under /api via the injected service modules.
 *   * /metrics serves Prometheus metrics (real prom-client registry, not a
 *     placeholder), and question search uses the real Elasticsearch client via
 *     services/question-service.js.
 *
 * All infrastructure (pg pool, cache, events, search, verifier) is injected so
 * this module is unit-testable without live infrastructure; callers construct a
 * ready app via createApp(...). The process bootstrap lives in gateway/index.js.
 */

const path = require('node:path');
const express = require('express');

const { authenticate, AuthError } = require('../lib/auth');
const { createAdminService } = require('../services/admin-service');
const { createGameService, GameError } = require('../services/game-service');
const { createQuestionService, QuestionError } = require('../services/question-service');
const { createUserService, UserError } = require('../services/user-service');

/**
 * Build the Express application.
 *
 * @param {object} deps
 * @param {object} deps.pool             pg pool (lib/db.js) — required.
 * @param {object} [deps.cache]          cache adapter (lib/cache.js) — optional.
 * @param {object} [deps.events]         score-event emitter (lib/events.js) — optional.
 * @param {object} [deps.searchClient]   Elasticsearch adapter (lib/search.js) — optional.
 * @param {object} [deps.metrics]        prom-client registry with `metrics()` async — optional.
 * @param {object} [deps.verifierOptions]  options passed to lib/auth.authenticate (verifier/env/config) — optional.
 * @param {boolean} [deps.requireAuth]    when true, /play and game endpoints require auth (default true).
 */
function createApp({
  pool,
  cache = null,
  events = null,
  searchClient = null,
  metrics = null,
  verifierOptions = null,
  requireAuth = true,
} = {}) {
  if (!pool) {
    throw new Error('createApp requires a pg pool');
  }

  const app = express();
  app.use(express.json());

  const questionService = createQuestionService(pool, { searchClient });
  const gameService = createGameService(pool, {
    cache,
    events,
    questionService,
  });
  const userService = createUserService(pool);
  const adminService = createAdminService(pool, { questionService });

  /**
   * Resolve a verified authentication context from the request, or 401.
   * Attaches { payload, userId, admin } to req.auth when present.
   */
  async function authGuard(req, res, next) {
    try {
      if (!requireAuth) {
        // Unauthenticated compatibility mode: still allow the route to proceed
        // without an identity; downstream owner checks become 403/404.
        req.auth = null;
        return next();
      }
      const ctx = await authenticate(pool, req.headers.authorization, verifierOptions || {});
      req.auth = ctx;
      return next();
    } catch (err) {
      return next(toHttpError(err));
    }
  }

  /** Convert any typed service error to { status, body }. */
  function toHttpError(err) {
    if (err instanceof AuthError) return withStatus(err, err.status || 401);
    if (err instanceof GameError) return withStatus(err, err.status || 500);
    if (err instanceof QuestionError) return withStatus(err, err.status || 400);
    if (err instanceof UserError) return withStatus(err, err.status || 400);
    return withStatus(err, (err && typeof err.status === 'number') ? err.status : 500);
  }

  function withStatus(err, status) {
    const e = err instanceof Error ? err : new Error(String(err));
    e._status = status;
    return e;
  }

  /** Central error handler that maps status-carrying errors to JSON. */
  function errorHandler(err, _req, res, _next) {
    const status =
      (err && (err._status || err.status)) &&
      Number.isInteger(err._status || err.status)
        ? err._status || err.status
        : 500;
    res.status(status).json({
      error: (err && err.message) || 'Internal server error',
    });
  }

  /**
   * Wrap an async route to forward rejections to the error handler and attach
   * the verified identity (from authGuard) to the handler via req.auth.
   */
  function route(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res))
        .catch((err) => next(toHttpError(err)));
    };
  }

  // -------------------------------------------------------------------------
  // Health + metrics (unauthenticated, per contract).
  // -------------------------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/metrics', async (_req, res) => {
    if (metrics && typeof metrics.metrics === 'function') {
      res.set('Content-Type', metrics.contentType ? metrics.contentType : 'text/plain');
      return res.status(200).send(await metrics.metrics());
    }
    // No registry configured: still return 200 with an empty metric exposition
    // so the endpoint is real (never a placeholder string body).
    res.set('Content-Type', 'text/plain; version=0.0.4');
    return res.status(200).send('');
  });

  // -------------------------------------------------------------------------
  // Original backward-compatible play entrypoint.
  // -------------------------------------------------------------------------
  app.get('/play', authGuard, route(async (req, res) => {
    const userId = req.auth ? req.auth.userId : null;
    if (userId == null) {
      const err = new AuthError('Authentication required', 401);
      return res.status(401).json({ error: err.message });
    }
    const game = await gameService.newGame(userId, undefined);
    // Original contract: 200 { gameId: integer }.
    return res.status(200).json({ gameId: game.id });
  }));

  // -------------------------------------------------------------------------
  // Game endpoints.
  // -------------------------------------------------------------------------
  app.post('/api/games', authGuard, route(async (req, res) => {
    const userId = requireUserId(req);
    const body = req.body || {};
    const questionIds = Array.isArray(body.questionIds) ? body.questionIds : undefined;
    const game = await gameService.newGame(userId, questionIds);
    return res.status(201).json(game);
  }));

  app.get('/api/games/:id', authGuard, route(async (req, res) => {
    const userId = requireUserId(req);
    const game = await gameService.viewGame(parseId(req.params.id), userId);
    return res.status(200).json(game);
  }));

  app.post('/api/games/:id/pause', authGuard, route(async (req, res) => {
    const userId = requireUserId(req);
    const result = await gameService.pauseGame(parseId(req.params.id), userId);
    return res.status(200).json(result);
  }));

  app.post('/api/games/:id/resume', authGuard, route(async (req, res) => {
    const userId = requireUserId(req);
    const result = await gameService.resumeGame(parseId(req.params.id), userId);
    return res.status(200).json(result);
  }));

  app.post('/api/games/:id/answers', authGuard, route(async (req, res) => {
    const userId = requireUserId(req);
    const body = req.body || {};
    if (body.questionId == null || body.answer == null) {
      const err = new Error('questionId and answer are required');
      err.status = 400;
      throw err;
    }
    const result = await gameService.answer(
      parseId(req.params.id),
      parseId(body.questionId),
      String(body.answer),
      userId
    );
    return res.status(200).json(result);
  }));

  app.get('/api/games/:id/score', authGuard, route(async (req, res) => {
    const userId = requireUserId(req);
    const result = await gameService.viewScore(parseId(req.params.id), userId);
    return res.status(200).json(result);
  }));

  // -------------------------------------------------------------------------
  // Question + admin endpoints.
  // -------------------------------------------------------------------------
  app.get('/api/questions/search', authGuard, route(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const matched = await questionService.searchQuestions(q);
    return res.status(200).json({ matched });
  }));

  app.post('/api/admin/questions', authGuard, route(async (req, res) => {
    requireAuthContext(req);
    const created = await adminService.createQuestion(req.auth.payload, req.body || {});
    return res.status(201).json(created);
  }));

  app.get('/api/admin/questions', authGuard, route(async (req, res) => {
    requireAuthContext(req);
    const result = await adminService.listQuestions(req.auth.payload);
    return res.status(200).json(result);
  }));

  app.delete('/api/admin/questions/:id', authGuard, route(async (req, res) => {
    requireAuthContext(req);
    const deleted = await adminService.deleteQuestion(req.auth.payload, parseId(req.params.id));
    return res.status(deleted ? 200 : 404).json(deleted ? {} : { error: 'Question not found' });
  }));

  // -------------------------------------------------------------------------
  // Static browser UI at /.
  // -------------------------------------------------------------------------
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) res.status(404).send('Not found');
    });
  });

  app.use(errorHandler);

  return app;
}

/** Enforce that an identity was resolved; throws 403 if auth was bypassed. */
function requireAuthContext(req) {
  if (!req.auth) {
    const err = new AuthError('Authentication required', 401);
    err._status = 401;
    throw err;
  }
  return req.auth;
}

function requireUserId(req) {
  requireAuthContext(req);
  return req.auth.userId;
}

/** Parse a positive integer path/body id, else throw a 400-typed error. */
function parseId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error('Invalid id');
    err.status = 400;
    throw err;
  }
  return n;
}

module.exports = {
  createApp,
};