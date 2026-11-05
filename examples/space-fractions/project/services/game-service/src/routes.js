/**
 * Game Service – HTTP Routes
 */

const { Router } = require('express');
const gameEngine = require('./game-engine');
const { requireAuth, requireAdmin, optionalAuth } = require('@spacefractions/shared/auth');
const { BadRequestError, NotFoundError } = require('@spacefractions/shared/errors');
const { gamesCreated, answersSubmitted, activeGames } = require('@spacefractions/shared/metrics');
const { publishScoreUpdated } = require('@spacefractions/shared/mq');
const { get, set } = require('@spacefractions/shared/cache');
const { query } = require('@spacefractions/shared/db');
const { resolveInternalUserId } = require('@spacefractions/shared/identity');

const router = Router();

/**
 * POST /api/games
 * Create a new game. Requires authentication.
 * Body (optional): { questionIds: [id, ...] }
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const userId = await getUserId(req.user);
    const questionIds = req.body?.questionIds || null;

    const game = await gameEngine.createGame(userId, questionIds);

    // Fetch questions WITHOUT correctAnswer
    const questions = await Promise.all(
      game.question_ids.map(async (qId) => {
        const q = await require('@spacefractions/shared/db').queryOne(
          'SELECT id, prompt, options FROM questions WHERE id = $1',
          [qId]
        );
        return q;
      })
    );

    gamesCreated.inc();
    activeGames.inc();

    // Cache the game
    await set(`game:${game.id}`, game, 1800);

    res.status(201).json({
      id: game.id,
      state: game.state,
      questions: questions.filter(Boolean),
      currentQuestionIndex: game.current_question_index
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/games/:id
 * Get game state. Only owner or admin can access.
 * Never includes correctAnswer.
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = await getUserId(req.user);
    const isAdmin = isAdminUser(req.user);
    const gameId = parseInt(req.params.id, 10);

    // Try cache first
    let game = await get(`game:${gameId}`);
    if (!game) {
      game = await gameEngine.getGame(gameId, userId, isAdmin);
      await set(`game:${gameId}`, game, 1800);
    } else {
      // Verify ownership
      if (!isAdmin && game.user_id !== userId) {
        return next(new NotFoundError('Game not found'));
      }
    }

    // Get questions without correctAnswer
    const questions = await Promise.all(
      game.question_ids.map(async (qId) => {
        const q = await require('@spacefractions/shared/db').queryOne(
          'SELECT id, prompt, options FROM questions WHERE id = $1',
          [qId]
        );
        return q;
      })
    );

    res.json({
      id: game.id,
      state: game.state,
      score: game.score,
      questions: questions.filter(Boolean),
      currentQuestionIndex: game.current_question_index,
      totalQuestions: game.question_ids.length,
      createdAt: game.created_at,
      updatedAt: game.updated_at
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/games/:id/pause
 * Pause the game. Owner only.
 */
router.post('/:id/pause', requireAuth, async (req, res, next) => {
  try {
    const userId = await getUserId(req.user);
    const isAdmin = isAdminUser(req.user);
    const gameId = parseInt(req.params.id, 10);

    // Verify ownership
    await gameEngine.getGame(gameId, userId, isAdmin);

    const game = await gameEngine.pauseGame(gameId);
    await set(`game:${gameId}`, game, 1800);

    res.json({ id: game.id, state: game.state });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/games/:id/resume
 * Resume the game. Owner only.
 */
router.post('/:id/resume', requireAuth, async (req, res, next) => {
  try {
    const userId = await getUserId(req.user);
    const isAdmin = isAdminUser(req.user);
    const gameId = parseInt(req.params.id, 10);

    await gameEngine.getGame(gameId, userId, isAdmin);

    const game = await gameEngine.resumeGame(gameId);
    await set(`game:${gameId}`, game, 1800);

    res.json({ id: game.id, state: game.state });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/games/:id/answers
 * Submit an answer. Owner only. Paused games return 409.
 */
router.post('/:id/answers', requireAuth, async (req, res, next) => {
  try {
    const userId = await getUserId(req.user);
    const isAdmin = isAdminUser(req.user);
    const gameId = parseInt(req.params.id, 10);
    const { questionId, answer } = req.body;

    if (!questionId || answer === undefined) {
      throw new BadRequestError('questionId and answer are required');
    }

    await gameEngine.getGame(gameId, userId, isAdmin);

    const result = await gameEngine.submitAnswer(
      gameId, parseInt(questionId, 10), answer, userId, isAdmin,
      publishScoreUpdated
    );

    answersSubmitted.inc({ correct: result.correct ? 'true' : 'false' });

    // Clear cache
    await require('@spacefractions/shared/cache').del(`game:${gameId}`);

    res.json({
      correct: result.correct,
      score: result.score,
      gameState: result.gameState
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/games/:id/score
 * Get game score. Owner or admin only.
 */
router.get('/:id/score', requireAuth, async (req, res, next) => {
  try {
    const userId = await getUserId(req.user);
    const isAdmin = isAdminUser(req.user);
    const gameId = parseInt(req.params.id, 10);

    // Verify ownership
    const game = await gameEngine.getGame(gameId, userId, isAdmin);

    res.json({ score: game.score, state: game.state });
  } catch (err) {
    next(err);
  }
});

/**
 * Helper: Resolve the numeric internal user ID from the verified OIDC claims.
 *
 * `games.user_id` is a numeric FK to `users.id`, while the OIDC `sub` claim is
 * a stable provider-issued string (e.g. a Keycloak UUID). We must map `sub`
 * -> `users.id` via the canonical shared resolver so that game ownership
 * checks compare like-for-like integers and cross-user access yields 404/403,
 * never a type mismatch. The resolver performs an idempotent upsert, so a
 * first-time caller is lazily provisioned before any game row is created.
 */
async function getUserId(user) {
  return resolveInternalUserId(user);
}

/**
 * Helper: Check if the user has admin role.
 */
function isAdminUser(user) {
  const roles = user?.realm_access?.roles || [];
  return roles.includes('admin');
}

module.exports = router;