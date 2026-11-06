'use strict';

/**
 * Game service — session lifecycle and scoring for Space Fractions.
 *
 * Responsibilities (space-fractions.md lines 17-24, 47-50; Architecture_View
 * Lines 79-145 ProcessView):
 *   - Create a game from the question pool (or an explicit questionIds list for
 *     reproducible practice). Never expose `correctAnswer` to players.
 *   - Fetch game state, pause/resume, submit answers, and read the score.
 *   - Owner authorization: a game may only be read/mutated by its owner
 *     (other users -> 403 or 404).
 *   - Per-game serialization of scoring and transactional deduplication: the
 *     UNIQUE (game_id, question_id) constraint prevents a repeat answer from
 *     incrementing the score.
 *   - Answering while paused -> 409. Answering a repeated question -> 409 (or
 *     idempotent 200; this implementation uses 409 for repeat).
 *
 * The service depends on three injectable collaborators so the default
 * `npm test` runs without PostgreSQL, Redis or an identity provider:
 *   - repository:       game persistence (see ./repository.js)
 *   - questionProvider: source of question records for new games
 *   - eventPublisher:   emits score events (see ./events.js, RabbitMQ)
 *   - verifier:         OIDC token verifier (shared src/shared/oidc.js)
 *   - userRepository:   sub -> numeric owner id mapping (user-service contract)
 *
 * All owner authorization is performed against the numeric internal user id
 * derived from the verified OIDC `sub`, matching the user-service's mapping
 * contract (space-fractions.md line 48).
 */

const express = require('express');
const { Client } = require('pg');

const oidc = require('../../../src/shared/oidc');
const { validateAnswer } = require('../../../src/shared/fraction');

const PORT = Number(process.env.GAME_SERVICE_PORT || process.env.PORT || 3001);

/** Ownership/authorization error (other user's game -> 403/404). */
class GameServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GameServiceError';
    this.status = status;
  }
}

/** Domain state names as stored in the `games.state` column. */
const GAME_STATE = {
  IN_PROGRESS: 'in_progress',
  PAUSED: 'paused',
  FINISHED: 'finished',
};

/**
 * Resolve the numeric owner id from an Authorization header, reusing the
 * user-service mapping contract (sub -> users.id) via an injected repository.
 *
 * @param {object} userRepository { findBySubject }
 * @param {object} verifier       { verify(token): Promise<payload> }
 * @param {string} [authorizationHeader]
 * @returns {Promise<number>} numeric internal user id
 * @throws {oidc.AuthError} missing/invalid credentials -> HTTP 401
 */
async function resolveOwner(userRepository, verifier, authorizationHeader, profile) {
  const token = oidc.bearerToken(authorizationHeader);
  const payload = await verifier.verify(token);
  const sub = payload.sub;
  const existing = await userRepository.findBySubject(sub);
  const user =
    existing ||
    (await userRepository.findOrCreateBySubject(
      sub,
      profile || payload.preferred_username || sub,
    ));
  return user.id;
}

/**
 * Strip `correctAnswer` from question records for player-facing responses.
 * The provider may return full records including correctAnswer (needed for
 * scoring); players must never receive it.
 */
function toPublicQuestion(q) {
  return { id: q.id, prompt: q.prompt, options: Array.isArray(q.options) ? q.options.slice() : [] };
}

/**
 * Build the game-service Express app.
 *
 * @param {object} [deps]
 * @param {object} [deps.repository]         game repository (pg or in-memory)
 * @param {object} [deps.questionProvider]   { list(), get(id) }
 * @param {object} [deps.eventPublisher]     { publishScore(gameId, score) }
 * @param {object} [deps.verifier]           OIDC verifier
 * @param {object} [deps.userRepository]     sub -> id mapping
 * @param {object} [deps.logger]             logger (default console)
 * @returns {import('express').Express}
 */
function buildApp(deps = {}) {
  const repository = deps.repository;
  if (!repository) throw new Error('game-service requires a repository');
  const questionProvider = deps.questionProvider;
  if (!questionProvider) throw new Error('game-service requires a questionProvider');
  const eventPublisher = deps.eventPublisher || { publishScore: async () => {} };
  const verifier =
    deps.verifier ||
    oidc.createTokenVerifier({
      issuer: process.env.OIDC_ISSUER,
      audience: process.env.OIDC_AUDIENCE,
      jwksUri: process.env.OIDC_JWKS_URI,
    });
  const userRepository = deps.userRepository;
  if (!userRepository) throw new Error('game-service requires a userRepository');
  const log = deps.logger || console;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'game-service' });
  });

  // Shared auth helper for route handlers.
  async function requireOwner(req, res) {
    try {
      return await resolveOwner(userRepository, verifier, req.headers.authorization);
    } catch (err) {
      if (err && err.name === 'AuthError') {
        res.status(401).json({ error: 'unauthorized' });
        return null;
      }
      log.error('auth failed', err.message);
      res.status(500).json({ error: 'internal_error' });
      return null;
    }
  }

  /**
   * POST /api/games?questionIds=1,2,3
   *   body { questionIds?: number[] }   (reproducible practice)
   *   201 { id, questions:[{id,prompt,options}] }
   * The correctAnswer is never returned to the player.
   */
  app.post('/api/games', async (req, res) => {
    const ownerId = await requireOwner(req, res);
    if (ownerId === null) return;

    try {
      const requested = Array.isArray(req.body && req.body.questionIds)
        ? req.body.questionIds
        : null;

      let questions;
      if (requested && requested.length > 0) {
        questions = [];
        for (const qid of requested) {
          if (!Number.isInteger(qid) || qid <= 0) {
            return res.status(400).json({ error: 'invalid_question_id' });
          }
          const q = await questionProvider.get(qid);
          if (!q) return res.status(404).json({ error: 'question_not_found' });
          questions.push(q);
        }
      } else {
        questions = await questionProvider.list();
        // Stable order is guaranteed by the position column in the persistence
        // layer; the in-memory provider returns insertion order.
        if (!questions.length) {
          return res.status(404).json({ error: 'no_questions_available' });
        }
      }

      const game = await repository.create(ownerId, questions);
      await eventPublisher
        .publishScore(game.id, game.score)
        .catch((err) => log.warn('publishScore failed (non-fatal)', err.message));

      return res.status(201).json({
        id: game.id,
        state: GAME_STATE.IN_PROGRESS,
        questions: questions.map(toPublicQuestion),
      });
    } catch (err) {
      log.error('create game failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  /**
   * GET /api/games -> 200 { games:[{id,state,score,questions}] } for the
   * authenticated owner, most recent first. Never includes correctAnswer. The
   * browser uses this to recover an in-flight game after a full page reload so
   * the score always comes from persisted PostgreSQL state.
   */
  app.get('/api/games', async (req, res) => {
    const ownerId = await requireOwner(req, res);
    if (ownerId === null) return;
    try {
      const games = await repository.listByOwner(ownerId);
      return res.status(200).json({
        games: games.map((g) => ({
          id: g.id,
          state: g.state,
          score: g.score,
          questions: (g.questions || []).map(toPublicQuestion),
        })),
      });
    } catch (err) {
      log.error('list games failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  /**
   * GET /api/games/:id -> 200 game state (player view, never correctAnswer).
   * Other user's game -> 404 (do not leak existence).
   */
  app.get('/api/games/:id', async (req, res) => {
    const ownerId = await requireOwner(req, res);
    if (ownerId === null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const game = await repository.get(id);
      if (!game || game.ownerId !== ownerId) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json({
        id: game.id,
        state: game.state,
        score: game.score,
        questions: (game.questions || []).map(toPublicQuestion),
      });
    } catch (err) {
      log.error('get game failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  // Shared pause/resume mutation helper.
  async function mutateState(req, res, nextState) {
    const ownerId = await requireOwner(req, res);
    if (ownerId === null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const game = await repository.get(id);
      if (!game || game.ownerId !== ownerId) {
        return res.status(404).json({ error: 'not_found' });
      }
      const updated = await repository.setState(id, nextState);
      return res.status(200).json({ id: updated.id, state: updated.state, score: updated.score });
    } catch (err) {
      log.error('set state failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  app.post('/api/games/:id/pause', (req, res) => mutateState(req, res, GAME_STATE.PAUSED));
  app.post('/api/games/:id/resume', (req, res) => mutateState(req, res, GAME_STATE.IN_PROGRESS));

  /**
   * POST /api/games/:id/answers { questionId, answer }
   *   200 { correct:boolean, score:integer }
   *   400 malformed fraction / invalid payload
   *   409 paused game or repeated question
   * Scoring and dedup happen in one transaction in the repository.
   */
  app.post('/api/games/:id/answers', async (req, res) => {
    const ownerId = await requireOwner(req, res);
    if (ownerId === null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    const body = req.body || {};
    const questionId = body.questionId;
    const answer = body.answer;
    if (!Number.isInteger(questionId) || questionId <= 0) {
      return res.status(400).json({ error: 'invalid_question_id' });
    }
    if (typeof answer !== 'string' || answer.trim() === '') {
      return res.status(400).json({ error: 'answer_must_be_string' });
    }

    try {
      const game = await repository.get(id);
      if (!game || game.ownerId !== ownerId) {
        return res.status(404).json({ error: 'not_found' });
      }
      if (game.state === GAME_STATE.PAUSED) {
        return res.status(409).json({ error: 'game_paused' });
      }
      // Validate the submitted answer is a well-formed fraction before scoring.
      const question = await questionProvider.get(questionId);
      if (!question) return res.status(404).json({ error: 'question_not_found' });
      const verdict = validateAnswer(question, answer);
      if (verdict.reason === 'answer_malformed') {
        return res.status(400).json({ error: 'malformed_fraction' });
      }

      // scoreAnswer deduplicates via UNIQUE(game_id, question_id); a repeat
      // throws a DuplicateAnswer error the repository surfaces as 409.
      const result = await repository.scoreAnswer(id, questionId, answer, verdict.correct);
      await eventPublisher
        .publishScore(id, result.score)
        .catch((err) => log.warn('publishScore failed (non-fatal)', err.message));

      return res.status(200).json({ correct: result.correct, score: result.score });
    } catch (err) {
      if (err && err.code === 'DUPLICATE_ANSWER') {
        return res.status(409).json({ error: 'answer_already_recorded' });
      }
      log.error('answer failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  /**
   * GET /api/games/:id/score -> 200 { score:integer }. Other user -> 404.
   */
  app.get('/api/games/:id/score', async (req, res) => {
    const ownerId = await requireOwner(req, res);
    if (ownerId === null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }
    try {
      const game = await repository.get(id);
      if (!game || game.ownerId !== ownerId) {
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(200).json({ score: game.score });
    } catch (err) {
      log.error('get score failed', err.message);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return app;
}

/**
 * Build production dependencies (PostgreSQL repository, question pool provider
 * reading from the question-service's repository, RabbitMQ event publisher).
 * Kept lazy so the HTTP handler factory is importable in tests.
 */
function buildProductionDeps() {
  // Lazy requires keep the module importable without those files present until
  // a production runtime actually boots (test-time uses in-memory adapters).
  const { PgGameRepository } = require('./repository');
  const { RabbitMqEventPublisher } = require('./events');
  const { PgQuestionRepository } = require('../../question-service/src/repository');
  const { PgUserRepository } = require('../../user-service/src/index');

  const repository = new PgGameRepository(process.env.DATABASE_URL);
  const questionProvider = new PgQuestionRepository(process.env.DATABASE_URL);
  const userRepository = new PgUserRepository(process.env.DATABASE_URL);
  const eventPublisher = process.env.RABBITMQ_URL
    ? new RabbitMqEventPublisher(process.env.RABBITMQ_URL)
    : null;
  const verifier = oidc.createTokenVerifier({
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE,
    jwksUri: process.env.OIDC_JWKS_URI,
  });
  return { repository, questionProvider, userRepository, eventPublisher, verifier };
}

// Direct execution only (not on import, so tests can require buildApp).
if (require.main === module) {
  const deps = buildProductionDeps();
  const app = buildApp(deps);
  const server = app.listen(PORT, () => {
    console.log(`game-service listening on :${PORT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  buildApp,
  buildProductionDeps,
  resolveOwner,
  toPublicQuestion,
  GAME_STATE,
  GameServiceError,
};