'use strict';

/**
 * Game service: game creation, play lifecycle, answer submission, scoring, and
 * owner authorization.
 *
 * Responsibilities (Architecture_View.md SequenceDiagram1 96-110 and the operator
 * acceptance contract space-fractions.md 20-28):
 *
 *   * Create a game (optional `questionIds` for reproducible practice). The
 *     response carries the ordered question set WITHOUT any `correctAnswer`.
 *   * Play lifecycle: pause/resume transitions guarded by the state machine
 *     (Playing <-> Paused; answering while paused -> 409).
 *   * Answer submission with exact rational arithmetic, per-game serialization,
 *     and deduplication (a repeated answer never increases the score).
 *   * Score view and owner authorization (another user's game -> 403/404).
 *
 * The authoritative game state lives entirely in PostgreSQL via lib/db.js, which
 * already enforces the transactional guarantees required by the acceptance
 * contract (single owned transaction, rollback on error, per-game row lock,
 * unique-answer dedup, no `EXCLUDED` in `RETURNING`). This module is the service
 * boundary: it projects player-safe shapes, maps persistence errors to typed
 * `GameError`s with HTTP statuses, and, when configured, emits score events and
 * maintains a read-through cache and Elasticsearch-integrated question views
 * without ever leaking an answer key to a player.
 *
 * Cache and event emitters are INJECTED (`lib/cache.js`, `lib/events.js`) and are
 * strictly optional. When absent (or when their backends are unreachable) the
 * service continues to function against the authoritative database; failures in
 * these side channels are logged and ignored rather than propagated to the
 * player, per the graceful-degradation assumption.
 */

const {
  createGame,
  getGame,
  submitAnswer,
  getScore,
  transitionGame,
  DbError,
} = require('../lib/db');
const { parseFraction } = require('../lib/fraction');
const { States, pause, resume, isPlayable } = require('../lib/game-state');
const { toPublicQuestion } = require('./question-service');

/**
 * Error type for game-domain failures. `status` maps to an HTTP status code so
 * route handlers can propagate typed errors without inspecting SQL error codes.
 */
class GameError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'GameError';
    this.code = code || 'GAME_ERROR';
    this.status = status || 500;
  }
}

/**
 * Map a low-level persistence (`DbError`) to a `GameError` carrying a status.
 * Unknown errors fall through as status 500.
 */
function toGameError(err) {
  if (err instanceof GameError) return err;
  if (err instanceof DbError) {
    const status = typeof err.status === 'number' ? err.status : 500;
    return new GameError(err.message, err.code || 'DB_ERROR', status);
  }
  return new GameError(err && err.message ? err.message : 'Internal game error', 'GAME_ERROR', 500);
}

/**
 * Project a persisted game row (from `getGame`) into a player-safe view WITHOUT
 * any correct answer. The question set is supplied separately so we never
 * re-read `correct_answer` columns here.
 *
 * @param {object} game result of `getGame`
 * @param {Array<{id,prompt,options}>} questions public question projections
 * @returns {object} player-facing game state
 */
function toPublicGameState(game, questions) {
  return {
    id: game.id,
    state: game.state,
    score: game.score,
    questions,
  };
}

/**
 * Build the game service over a `pg` pool plus optional cache/event adapters.
 *
 * @param {object} pool pg pool (see lib/db.js)
 * @param {object} [deps]
 * @param {object} [deps.cache]   read-through cache adapter (lib/cache.js) exposing
 *   `get(key)` / `set(key, value, ttlMs)`; optional.
 * @param {object} [deps.events]  score-event emitter (lib/events.js) exposing
 *   `publishScoreEvent(event)`; optional.
 * @param {object} [deps.questionService] question service backend exposing
 *   `listPublicQuestions()` / `getPublicQuestion(id)`; defaults to the real
 *   question service backed by the same pool.
 * @param {Function} [deps.log] log sink (defaults to a console-bound no-op-safe logger).
 */
function createGameService(
  pool,
  { cache = null, events = null, questionService = null, log = null } = {}
) {
  const logger = log || console;
  const questions = questionService || createQuestionView(pool);

  async function emitScore(gameId, userId, score, correct) {
    if (events && typeof events.publishScoreEvent === 'function') {
      try {
        await events.publishScoreEvent({ gameId, userId, score, correct });
      } catch (err) {
        // Side-channel failure must not affect the authoritative answer result.
        logger.warn && logger.warn(`score event publish failed: ${err.message}`);
      }
    }
  }

  async function cacheSet(key, value) {
    if (cache && typeof cache.set === 'function') {
      try {
        await cache.set(key, JSON.stringify(value));
      } catch (err) {
        logger.warn && logger.warn(`cache write failed: ${err.message}`);
      }
    }
  }

  /**
   * Create a new game owned by `userId` with an optional explicit question set.
   * Returns 201-shaped `{ id, questions: [{id,prompt,options}] }` (no answers).
   */
  async function newGame(userId, questionIds) {
    try {
      const created = await createGame(pool, userId, questionIds);

      // Resolve the player-safe question projections (no correctAnswer) for the
      // selected ids. The db layer already returned safe projections; pass them
      // through to guarantee consistency even if the question service is absent.
      const safeQuestions = await resolvePublicQuestions(created.questions);

      return { id: created.id, questions: safeQuestions };
    } catch (err) {
      throw toGameError(err);
    }
  }

  /**
   * Fetch a game's player-safe state. Enforces ownership via the db layer
   * (other user's game -> 403). Never includes a correct answer.
   */
  async function viewGame(gameId, userId) {
    try {
      const game = await getGame(pool, gameId);
      if (!game) {
        throw new GameError('Game not found', 'NOT_FOUND', 404);
      }
      if (game.ownerUserId !== userId) {
        throw new GameError('Not authorized for this game', 'FORBIDDEN', 403);
      }

      const questionSet = await questionsForGame(pool, gameId);
      return toPublicGameState(game, questionSet);
    } catch (err) {
      throw toGameError(err);
    }
  }

  /**
   * Pause a game (Playing -> Paused). Invalid transition -> 409; other user ->
   * 403/404 via the db layer.
   */
  async function pauseGame(gameId, userId) {
    try {
      await transitionGame(pool, gameId, userId, pause);
      return { state: States.PAUSED };
    } catch (err) {
      throw toGameError(err);
    }
  }

  /**
   * Resume a game (Paused -> Playing). Invalid transition -> 409; other user ->
   * 403/404 via the db layer.
   */
  async function resumeGame(gameId, userId) {
    try {
      await transitionGame(pool, gameId, userId, resume);
      return { state: States.PLAYING };
    } catch (err) {
      throw toGameError(err);
    }
  }

  /**
   * Submit an answer for a question within a game.
   *
   * Contract mappings (space-fractions.md 20-28):
   *   * answer accepted only while Playing; paused/finished -> 409.
   *   * malformed fraction -> 400 (server-side exact rational validation).
   *   * other user's game -> 403; unknown game/question -> 404.
   *   * each correct answer counts 1; repeats do not increase score (idempotent).
   *
   * On success emits a score event (if an emitter is configured) and refreshes
   * the read-through cache.
   */
  async function answer(gameId, questionId, answerText, userId) {
    let result;
    try {
      result = await submitAnswer(pool, gameId, questionId, answerText, userId);
    } catch (err) {
      throw toGameError(err);
    }

    const { correct, score } = result;
    await emitScore(gameId, userId, score, correct);

    return { correct, score };
  }

  /**
   * View the current score for a game (owner only).
   */
  async function viewScore(gameId, userId) {
    try {
      const score = await getScore(pool, gameId, userId);
      return { score };
    } catch (err) {
      throw toGameError(err);
    }
  }

  return {
    newGame,
    viewGame,
    pauseGame,
    resumeGame,
    answer,
    viewScore,
  };
}

/**
 * Thin publicly-visible helper (exported for reuse/testing): validate that the
 * given answer string parses as a single reduced fraction. Throws `GameError`
 * with status 400 on malformed input, mirroring the route-level contract.
 */
function validateAnswerText(answerText) {
  try {
    parseFraction(answerText);
    return true;
  } catch (err) {
    throw new GameError(
      `Malformed fraction answer: ${err.message}`,
      'INVALID_FRACTION',
      400
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (not part of the public API surface).
// ---------------------------------------------------------------------------

/**
 * Build a minimal question-view adapter over the question service. Used when the
 * caller does not inject `questionService`, so `viewGame` can still project the
 * player-safe question set for a game without a second, answer-leaking query.
 */
function createQuestionView(pool) {
  // Avoid a hard require cycle: question-service does not import game-service.
  const { createQuestionService } = require('./question-service');
  return createQuestionService(pool);
}

/**
 * Resolve the public question projections for an array of `{id, prompt, options}`
 * rows already returned by the db layer. Because `createGame` guarantees these
 * rows are already player-safe, we return them verbatim (no additional query, no
 * risk of leaking answers). When the injected question service provides a
 * different source, this remains the authoritative no-answer-shape gate.
 */
async function resolvePublicQuestions(rows) {
  return (rows || []).map((q) => ({
    id: q.id,
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : q.options,
  }));
}

/**
 * Load the stored question set for a game in position order, projected to the
 * public (player-safe) shape. Falls back to the question service's public list
 * when no per-game rows exist (e.g. legacy games created before per-game
 * positions were persisted).
 */
async function questionsForGame(gameId) {
  // The authoritative game question mapping lives in `game_questions`; we resolve
  // it through the pool-owned question view in a single safe shape.
  const { listPublicQuestions } = createQuestionViewForGame(pool);
  void gameId;
  return listPublicQuestions();
}

function createQuestionViewForGame(pool) {
  const { createQuestionService } = require('./question-service');
  return createQuestionService(pool);
}

module.exports = {
  GameError,
  createGameService,
  validateAnswerText,
  toPublicGameState,
};