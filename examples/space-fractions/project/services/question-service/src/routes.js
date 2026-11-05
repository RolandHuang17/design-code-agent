/**
 * Question Service – HTTP Routes
 *
 * Public read endpoints (never expose correct_answer):
 *   GET /api/questions            – list questions (optionally filtered by ids)
 *   GET /api/questions/search     – full-text search (Elasticsearch w/ SQL fallback)
 *   GET /api/questions/:id        – single question
 */

const { Router } = require('express');
const { optionalAuth } = require('@spacefractions/shared/auth');
const { BadRequestError, NotFoundError } = require('@spacefractions/shared/errors');
const { query, queryOne } = require('@spacefractions/shared/db');
const { searchQuestions } = require('./search');

const router = Router();

const PUBLIC_SELECT = 'id, prompt, options, created_at, updated_at';

/**
 * Parse and validate a comma-separated id list into integers.
 */
function parseIdList(idsParam) {
  if (!idsParam) return null;
  const raw = String(idsParam).split(',').map(s => s.trim()).filter(Boolean);
  if (raw.length === 0) return null;
  const ids = raw.map(s => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestError(`Invalid question id: ${s}`);
    }
    return n;
  });
  return ids;
}

/**
 * GET /api/questions
 * List questions. Optional query params:
 *   ?ids=1,2,3 – return only these questions (order preserved)
 *   ?limit=...  – cap results
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const ids = parseIdList(req.query.ids);
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    if (Number.isNaN(limit) || limit < 1 || limit > 500) {
      throw new BadRequestError('limit must be between 1 and 500');
    }

    let rows;
    if (ids) {
      // Preserve requested order
      rows = await query(
        `SELECT ${PUBLIC_SELECT} FROM questions WHERE id = ANY($1::int[])`,
        [ids]
      );
      const byId = new Map(rows.rows.map(r => [r.id, r]));
      rows = { rows: ids.map(id => byId.get(id)).filter(Boolean) };
    } else {
      rows = await query(
        `SELECT ${PUBLIC_SELECT} FROM questions ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
    }

    res.json({ questions: rows.rows, count: rows.rows.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/questions/search?q=...
 * Full-text search over prompts and options.
 */
router.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const q = req.query.q;
    const results = await searchQuestions(q);
    res.json({ questions: results, count: results.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/questions/:id
 * Single question (never includes correct_answer).
 */
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestError('Invalid question id');
    }

    const question = await queryOne(
      `SELECT ${PUBLIC_SELECT} FROM questions WHERE id = $1`,
      [id]
    );

    if (!question) {
      throw new NotFoundError('Question not found');
    }

    res.json(question);
  } catch (err) {
    next(err);
  }
});

module.exports = router;