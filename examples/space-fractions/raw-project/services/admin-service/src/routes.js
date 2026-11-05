/**
 * Admin Service – HTTP Routes
 *
 * Authenticated administrator-only question CRUD. Mounted under
 * /api/admin by the gateway (and directly on this service).
 *
 *   POST   /api/admin/questions            – create question (201)
 *   GET    /api/admin/questions            – list questions (includes correct_answer)
 *   GET    /api/admin/questions/:id        – single question (includes correct_answer)
 *   PUT    /api/admin/questions/:id        – update question
 *   DELETE /api/admin/questions/:id        – delete question (204)
 *
 * Authorization: every route requires a valid Bearer OIDC access token AND
 * the `admin` realm role. Unauthenticated requests yield 401; authenticated
 * non-admin requests yield 403 (per the acceptance contract).
 *
 * Server-side validation:
 *   - prompt must be a non-empty string
 *   - options must be an array of 2..10 non-empty strings
 *   - correctAnswer must be a well-formed exact rational ("a/b" or integer)
 *   - correctAnswer must be one of options (the correct answer is always a
 *     listed option, matching the multiple-choice model)
 */

const { Router } = require('express');
const { requireAuth, requireAdmin } = require('@spacefractions/shared/auth');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require('@spacefractions/shared/errors');
const { query, queryOne } = require('@spacefractions/shared/db');
const { isValidFraction, fractionsEqual, formatFraction } = require('@spacefractions/shared/fraction');
const { questionsCreated } = require('@spacefractions/shared/metrics');
const { indexQuestion, deleteQuestion: deleteQuestionDoc } = require('../../question-service/src/search');

const { resolveInternalUserId } = require('@spacefractions/shared/identity');

const router = Router();

const LIMIT_MAX = 500;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;

/**
 * Normalize and validate a question payload ({ prompt, options, correctAnswer }).
 * Returns the normalized { prompt, options, correctAnswer } on success.
 * Throws BadRequestError for malformed input.
 */
function validateQuestionPayload(body) {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('Request body must be a JSON object');
  }

  const { prompt, options, correctAnswer } = body;

  // prompt: non-empty string with a length cap
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new BadRequestError('prompt must be a non-empty string');
  }
  if (prompt.length > 2000) {
    throw new BadRequestError('prompt exceeds maximum length of 2000 characters');
  }

  // options: array of 2..10 non-empty strings, no duplicates (after trim)
  if (!Array.isArray(options)) {
    throw new BadRequestError('options must be an array of strings');
  }
  if (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) {
    throw new BadRequestError(
      `options must contain between ${OPTIONS_MIN} and ${OPTIONS_MAX} strings`
    );
  }
  const seen = new Set();
  for (const opt of options) {
    if (typeof opt !== 'string' || opt.trim() === '') {
      throw new BadRequestError('each option must be a non-empty string');
    }
    if (opt.length > 200) {
      throw new BadRequestError('an option exceeds maximum length of 200 characters');
    }
    if (seen.has(opt.trim())) {
      throw new BadRequestError('options must not contain duplicates');
    }
    seen.add(opt.trim());
  }

  // correctAnswer: well-formed exact fraction AND one of the options
  if (typeof correctAnswer !== 'string' || correctAnswer.trim() === '') {
    throw new BadRequestError('correctAnswer must be a non-empty string');
  }
  if (!isValidFraction(correctAnswer)) {
    throw new BadRequestError(
      'correctAnswer must be a well-formed fraction ("a/b", denominator != 0)'
    );
  }
  // The correct answer must appear among the options (compare as exact
  // rationals so "1/2" and "2/4" are considered the same answer).
  const normalizedCorrect = formatFraction(correctAnswer);
  const optionMatches = options.some((opt) => fractionsEqual(opt, correctAnswer));
  if (!optionMatches) {
    throw new BadRequestError('correctAnswer must be one of the provided options');
  }

  return {
    prompt: prompt.trim(),
    options,
    correctAnswer: normalizedCorrect,
  };
}

/**
 * Serialize a question row for admin responses (includes correct_answer).
 */
function toAdminQuestion(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    options: row.options,
    correctAnswer: row.correct_answer,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolve the internal user id for the authenticated caller (from OIDC `sub`).
 * Used to stamp `created_by` on new questions and to authorize ownership.
 */
async function resolveCallerUserId(claims) {
  const sub = claims && claims.sub;
  if (!sub) {
    throw new BadRequestError('Token missing subject (sub) claim');
  }
  const row = await queryOne('SELECT id FROM users WHERE sub = $1', [sub]);
  return row ? row.id : null;
}

// Apply auth middlewares to all admin routes. Order matters: requireAuth
// populates req.user, then requireAdmin enforces the realm role.
router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/questions
 * List all questions (with correct_answer), newest first. Optional ?limit.
 */
router.get('/questions', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : LIMIT_MAX;
    if (Number.isNaN(limit) || limit < 1 || limit > LIMIT_MAX) {
      throw new BadRequestError(`limit must be between 1 and ${LIMIT_MAX}`);
    }

    const result = await query(
      `SELECT id, prompt, options, correct_answer, created_by, created_at, updated_at
       FROM questions
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({
      questions: result.rows.map(toAdminQuestion),
      count: result.rows.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/questions/:id
 * Single question (with correct_answer).
 */
router.get('/questions/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError('Invalid question id');
    }

    const row = await queryOne(
      `SELECT id, prompt, options, correct_answer, created_by, created_at, updated_at
       FROM questions WHERE id = $1`,
      [id]
    );

    if (!row) {
      throw new NotFoundError('Question not found');
    }

    res.json(toAdminQuestion(row));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/questions
 * Create a question. Body: { prompt, options: [string], correctAnswer }.
 * Returns 201 with the created question.
 */
router.post('/questions', async (req, res, next) => {
  try {
    const normalized = validateQuestionPayload(req.body);
    const createdBy = await resolveCallerUserId(req.user);

    const result = await query(
      `INSERT INTO questions (prompt, options, correct_answer, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, prompt, options, correct_answer, created_by, created_at, updated_at`,
      [
        normalized.prompt,
        JSON.stringify(normalized.options),
        normalized.correctAnswer,
        createdBy,
      ]
    );

    const row = result.rows[0];

    // Best-effort Elasticsearch indexing (non-fatal).
    try {
      await indexQuestion({ id: row.id, prompt: row.prompt, options: row.options });
    } catch (err) {
      console.warn('Admin service: index question failed:', err.message);
    }

    questionsCreated.inc();

    res.status(201).json(toAdminQuestion(row));
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/questions/:id
 * Update (replace) a question. Same validation as create.
 */
router.put('/questions/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError('Invalid question id');
    }

    const existing = await queryOne('SELECT id FROM questions WHERE id = $1', [id]);
    if (!existing) {
      throw new NotFoundError('Question not found');
    }

    const normalized = validateQuestionPayload(req.body);

    const result = await query(
      `UPDATE questions
       SET prompt = $2, options = $3, correct_answer = $4, updated_at = NOW()
       WHERE id = $1
       RETURNING id, prompt, options, correct_answer, created_by, created_at, updated_at`,
      [
        id,
        normalized.prompt,
        JSON.stringify(normalized.options),
        normalized.correctAnswer,
      ]
    );

    const row = result.rows[0];

    try {
      await indexQuestion({ id: row.id, prompt: row.prompt, options: row.options });
    } catch (err) {
      console.warn('Admin service: index question failed:', err.message);
    }

    res.json(toAdminQuestion(row));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/questions/:id
 * Delete a question. Returns 204 No Content on success.
 */
router.delete('/questions/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError('Invalid question id');
    }

    const result = await query('DELETE FROM questions WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      throw new NotFoundError('Question not found');
    }

    try {
      await deleteQuestionDoc(id);
    } catch (err) {
      console.warn('Admin service: delete question doc failed:', err.message);
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.validateQuestionPayload = validateQuestionPayload;
module.exports.toAdminQuestion = toAdminQuestion;