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
    const result = await query('SELECT id FROM questions ORDER BY created_at');
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
 * Submit an answer for a question in a game.
 * Returns { correct, score, gameState }.
 *
 * Idempotent: re-answering the same question never increases score a second
 * time, because the score increment is gated on the atomic `scored`
 * FALSE -> TRUE transition of the single answer row (guarded by the
 * UNIQUE (game_id, question_id) constraint).
 *
 * Concurrency: the whole mutation runs in one transaction holding a
 * `SELECT ... FOR UPDATE` lock on the game row AND the answer
 * deduplication, score increment, progress advance and state transition are
 * performed in a SINGLE data-modifying CTE statement. This means the
 * FALSE -> TRUE detection and the `score = score + 1` happen in one atomic
 * unit: a concurrent duplicate submission cannot both observe a
 * FALSE -> TRUE transition and double-increment the score, even in the
 * absence of the row lock.
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

    // Completed games: only an idempotent replay of an already-scored
    // question is permitted (returns current score without error).
    if (game.state === 'completed' || completed) {
      const replayed = await tx.queryOne(
        'SELECT scored FROM game_answers WHERE game_id = $1 AND question_id = $2',
        [gameId, questionId]
      );
      if (replayed && replayed.scored) {
        return { correct: true, score: game.score, gameState: 'completed' };
      }
      throw new ConflictError('Game is already completed');
    }

    // Atomic answer upsert + score increment + progress/state mutation, all in
    // ONE data-modifying CTE statement.
    //
    //  - answer_upsert: flips the single answer row's `scored` from FALSE to
    //    TRUE only on the FIRST correct answer (guarded by the UNIQUE
    //    (game_id, question_id) constraint), and returns `newly_scored`
    //    exactly once for that transition.
    //  - game_update: reads the CURRENT game score from the row and increments
    //    it only by `newly_scored`. Because this happens in the same statement
    //    as the dedup decision, two concurrent submissions of the same
    //    question cannot both observe a FALSE -> TRUE transition: the second
    //    one sees `scored = TRUE` already and its increment is 0.
    //  - Progress advances only when the answered question is the one at the
    //    current index (computed from the row's question_ids array, so it is
    //    not derived from a stale pre-lock JS read) and the game row flips to
    //    'completed' only when that advance exhausts the question list.
    const row = await tx.queryOne(
      `WITH answer_upsert AS (
         INSERT INTO game_answers (game_id, question_id, answer, correct, scored)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (game_id, question_id) DO UPDATE SET
           answer = EXCLUDED.answer,
           correct = EXCLUDED.correct,
           scored = CASE
             WHEN game_answers.scored = FALSE AND EXCLUDED.scored = TRUE THEN TRUE
             ELSE game_answers.scored
           END
         RETURNING
           (CASE WHEN game_answers.scored = FALSE AND EXCLUDED.scored = TRUE THEN TRUE ELSE FALSE END) AS newly_scored,
           correct AS is_correct
       ),
       game_update AS (
         UPDATE games g
         SET score = g.score + (SELECT newly_scored::int FROM answer_upsert),
             current_question_index = CASE
               WHEN g.question_ids[g.current_question_index + 1] = $2 THEN g.current_question_index + 1
               ELSE g.current_question_index
             END,
             state = CASE
               WHEN g.question_ids[g.current_question_index + 1] = $2
                    AND (g.current_question_index + 1) >= array_length(g.question_ids, 1)
               THEN 'completed'
               ELSE g.state
             END,
             updated_at = NOW()
         WHERE g.id = $1
         RETURNING g.score, g.current_question_index, g.state
       )
       SELECT
         (SELECT newly_scored FROM answer_upsert) AS newly_scored,
         (SELECT is_correct FROM answer_upsert) AS correct,
         (SELECT score FROM game_update) AS score,
         (SELECT state FROM game_update) AS state`,
      [gameId, questionId, answer, correct]
    );

    const newlyScored = row && row.newly_scored === true;
    const finalScore = numberScore(row.score);
    const finalState = row.state;

    if (newlyScored && publishScoreEvent) {
      try {
        publishScoreEvent(gameId, userId, finalScore, questionId);
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