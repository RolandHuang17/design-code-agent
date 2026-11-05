/**
 * Game Engine – core game logic for Space Fractions.
 *
 * States: 'playing', 'paused', 'completed'
 * Transitions:
 *   playing  -> paused   (pause)
 *   paused   -> playing  (resume)
 *   playing  -> completed (all questions answered)
 *
 * Scoring:
 *   - Each correct answer to a not-yet-correctly-answered question: +1
 *   - Re-answering correctly: idempotent (no score change)
 *   - Score never decreases
 */

const { query, queryOne, withTransaction } = require('@spacefractions/shared/db');
const { fractionsEqual, isValidFraction } = require('@spacefractions/shared/fraction');
const { BadRequestError, ConflictError, NotFoundError } = require('@spacefractions/shared/errors');

/**
 * Create a new game for the given user with the specified questions.
 */
async function createGame(userId, questionIds) {
  // If no question IDs provided, fetch all available questions
  if (!questionIds || questionIds.length === 0) {
    const result = await query('SELECT id FROM questions ORDER BY created_at, id');
    questionIds = result.rows.map(r => r.id);
  }

  if (questionIds.length === 0) {
    throw new BadRequestError('No questions available to create a game');
  }

  const result = await query(
    `INSERT INTO games (user_id, state, score, question_ids, current_question_index)
     VALUES ($1, 'playing', 0, $2, 0)
     RETURNING *`,
    [userId, questionIds]
  );

  return result.rows[0];
}

/**
 * Get a game by ID. Validates ownership (unless isAdmin).
 */
async function getGame(gameId, userId, isAdmin) {
  const game = await queryOne('SELECT * FROM games WHERE id = $1', [gameId]);
  if (!game) {
    throw new NotFoundError('Game not found');
  }

  // Authorization: only owner or admin can access
  if (!isAdmin && game.user_id !== userId) {
    throw new NotFoundError('Game not found');
  }

  return game;
}

/**
 * Get the current question for a game.
 */
async function getCurrentQuestion(gameId) {
  const game = await queryOne('SELECT * FROM games WHERE id = $1', [gameId]);
  if (!game) throw new NotFoundError('Game not found');

  if (game.state === 'completed') {
    return null;
  }

  const idx = game.current_question_index;
  if (idx >= game.question_ids.length) {
    return null;
  }

  const qId = game.question_ids[idx];
  const question = await queryOne(
    'SELECT id, prompt, options FROM questions WHERE id = $1',
    [qId]
  );

  return question;
}

/**
 * Pause a game. Only valid from 'playing' state.
 */
async function pauseGame(gameId) {
  const game = await queryOne('SELECT * FROM games WHERE id = $1', [gameId]);
  if (!game) throw new NotFoundError('Game not found');

  if (game.state === 'paused') {
    // Already paused – idempotent
    return game;
  }

  if (game.state !== 'playing') {
    throw new ConflictError(`Cannot pause game in state: ${game.state}`);
  }

  const result = await query(
    `UPDATE games SET state = 'paused', updated_at = NOW()
     WHERE id = $1 AND state = 'playing'
     RETURNING *`,
    [gameId]
  );

  if (!result.rows[0]) {
    throw new ConflictError('Game state changed concurrently');
  }

  return result.rows[0];
}

/**
 * Resume a game. Only valid from 'paused' state.
 */
async function resumeGame(gameId) {
  const game = await queryOne('SELECT * FROM games WHERE id = $1', [gameId]);
  if (!game) throw new NotFoundError('Game not found');

  if (game.state === 'playing') {
    // Already playing – idempotent
    return game;
  }

  if (game.state !== 'paused') {
    throw new ConflictError(`Cannot resume game in state: ${game.state}`);
  }

  const result = await query(
    `UPDATE games SET state = 'playing', updated_at = NOW()
     WHERE id = $1 AND state = 'paused'
     RETURNING *`,
    [gameId]
  );

  if (!result.rows[0]) {
    throw new ConflictError('Game state changed concurrently');
  }

  return result.rows[0];
}

/**
 * Serialize each game's answer mutations with a PostgreSQL row lock.
 * Deduplication, score and progress changes commit together on one client.
 * External acceptance additionally checks real concurrent HTTP requests.
 */
async function submitAnswer(gameId, questionId, answer, userId, isAdmin, publishScoreEvent) {
  // Basic validation outside the transaction: a malformed fraction or an
  // out-of-game question cannot possibly score.
  if (!isValidFraction(answer)) {
    throw new BadRequestError('Malformed fraction answer');
  }

  return withTransaction(async (tx) => {
    // Lock the game row for the duration of the transaction. This serializes
    // concurrent submissions against the same game and (re)checks ownership,
    // pause and completion state atomically with the score mutation.
    const game = await tx.queryOne(
      'SELECT * FROM games WHERE id = $1 FOR UPDATE',
      [gameId]
    );
    if (!game) {
      throw new NotFoundError('Game not found');
    }
    if (!isAdmin && game.user_id !== userId) {
      throw new NotFoundError('Game not found');
    }

    if (game.state === 'paused') {
      throw new ConflictError('Cannot answer while game is paused');
    }

    // The question must actually belong to this game.
    if (!game.question_ids.includes(questionId)) {
      throw new BadRequestError('Question is not part of this game');
    }

    // Resolve the correct answer.
    const question = await tx.queryOne(
      'SELECT id, correct_answer FROM questions WHERE id = $1',
      [questionId]
    );
    if (!question) {
      throw new NotFoundError('Question not found');
    }

    const correct = fractionsEqual(answer, question.correct_answer);

    const completed = game.current_question_index >= game.question_ids.length;

    // Completed sessions reject further writes; in-progress duplicate answers
    // remain idempotent. This is within the documented 200-or-409 contract.
    if (game.state === 'completed' || completed) {
      throw new ConflictError('Game is already completed');
    }

    const previous = await tx.queryOne(
      'SELECT * FROM game_answers WHERE game_id = $1 AND question_id = $2',
      [gameId, questionId]
    );
    const newlyScored = correct && !previous?.scored;
    await tx.query(
      `INSERT INTO game_answers (game_id, question_id, answer, correct, scored)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (game_id, question_id) DO UPDATE SET
         answer = EXCLUDED.answer, correct = EXCLUDED.correct,
         scored = game_answers.scored OR EXCLUDED.scored`,
      [gameId, questionId, answer, correct, correct || !!previous?.scored]
    );
    const nextIndex = game.current_question_index +
      Number(game.question_ids[game.current_question_index] === questionId);
    const nextState = nextIndex >= game.question_ids.length ? 'completed' : game.state;
    const row = await tx.queryOne(
      `UPDATE games SET score = score + $1, current_question_index = $2,
         state = $3, updated_at = NOW() WHERE id = $4 RETURNING score, state`,
      [Number(newlyScored), nextIndex, nextState, gameId]
    );
    const finalScore = numberScore(row.score);
    const finalState = row.state;

    if (newlyScored && publishScoreEvent) {
      try {
        await publishScoreEvent(gameId, userId, finalScore, questionId);
      } catch {
        // Non-critical; do not fail the transaction over telemetry.
      }
    }

    return {
      correct,
      score: finalScore,
      gameState: finalState
    };
  });
}

function numberScore(v) {
  return typeof v === 'number' ? v : parseInt(v, 10);
}

/**
 * Get the score for a game.
 */
async function getScore(gameId) {
  const game = await queryOne('SELECT id, score, state FROM games WHERE id = $1', [gameId]);
  if (!game) throw new NotFoundError('Game not found');
  return { score: game.score, state: game.state };
}

module.exports = {
  createGame,
  getGame,
  getCurrentQuestion,
  pauseGame,
  resumeGame,
  submitAnswer,
  getScore
};
