/**
 * Question Service – Elasticsearch search helper.
 *
 * Provides a bounded-timeout search abstraction over the `questions` index.
 * If Elasticsearch is unavailable, the search falls back to a PostgreSQL
 * ILIKE scan so the service degrades gracefully rather than erroring.
 */

const { Client } = require('@elastic/elasticsearch');
const { query } = require('@spacefractions/shared/db');

const INDEX = 'questions';
const DEFAULT_TIMEOUT_MS = 1500;

let client = null;
let indexEnsured = false;

/**
 * Initialize the Elasticsearch client (lazy, non-fatal on failure).
 */
function initSearch(config) {
  if (client) return client;

  const node = config.ELASTICSEARCH_URL || process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

  client = new Client({
    node,
    requestTimeout: DEFAULT_TIMEOUT_MS,
    maxRetries: 1
  });

  return client;
}

/**
 * Best-effort index creation with mapping. Does not throw on failure.
 */
async function ensureIndex() {
  if (!client || indexEnsured) return;

  try {
    const exists = await client.indices.exists({ index: INDEX });
    if (!exists) {
      await client.indices.create({
        index: INDEX,
        mappings: {
          properties: {
            id: { type: 'integer' },
            prompt: { type: 'text' },
            options: { type: 'text' }
          }
        }
      });
    }
    indexEnsured = true;
  } catch (err) {
    console.warn('Question service: index setup skipped:', err.message);
  }
}

/**
 * Index a question document into Elasticsearch (fire-and-forget best effort).
 */
async function indexQuestion(question) {
  if (!client) return;
  try {
    await client.index({
      index: INDEX,
      id: String(question.id),
      document: {
        id: question.id,
        prompt: question.prompt,
        options: Array.isArray(question.options) ? question.options : []
      },
      refresh: false
    });
  } catch (err) {
    console.warn('Question service: index document failed:', err.message);
  }
}

/**
 * Remove a question document from Elasticsearch (fire-and-forget).
 */
async function deleteQuestion(id) {
  if (!client) return;
  try {
    await client.delete({ index: INDEX, id: String(id) });
  } catch (err) {
    // 404 means already removed; ignore other errors as non-critical
    if (err.meta && err.meta.statusCode !== 404) {
      console.warn('Question service: delete document failed:', err.message);
    }
  }
}

/**
 * Search questions by a text query.
 *
 * Attempts Elasticsearch first (with an explicit bounded timeout). On any
 * error, falls back to a PostgreSQL ILIKE scan against prompt/options.
 *
 * Returns an array of { id, prompt, options } without correct_answer.
 */
async function searchQuestions(queryText) {
  const trimmed = (queryText || '').trim();

  // Empty query: return recent questions from PostgreSQL.
  if (!trimmed) {
    const result = await query(
      'SELECT id, prompt, options FROM questions ORDER BY created_at DESC LIMIT 100'
    );
    return result.rows;
  }

  // Try Elasticsearch
  if (client) {
    try {
      await ensureIndex();
      const esResult = await client.search({
        index: INDEX,
        size: 100,
        _source: ['id', 'prompt', 'options'],
        query: {
          multi_match: {
            query: trimmed,
            fields: ['prompt', 'options']
          }
        }
      });

      return esResult.hits.hits.map(h => h._source);
    } catch (err) {
      console.warn('Question service: ES search failed, falling back to SQL:', err.message);
    }
  }

  // Fallback: PostgreSQL ILIKE
  const like = `%${trimmed}%`;
  const result = await query(
    `SELECT id, prompt, options
     FROM questions
     WHERE prompt ILIKE $1 OR options::text ILIKE $1
     ORDER BY created_at DESC LIMIT 100`,
    [like]
  );
  return result.rows;
}

/**
 * Health check for Elasticsearch connectivity.
 */
async function healthCheck() {
  if (!client) return false;
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the client.
 */
async function closeSearch() {
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore
    }
    client = null;
    indexEnsured = false;
  }
}

module.exports = {
  initSearch,
  ensureIndex,
  indexQuestion,
  deleteQuestion,
  searchQuestions,
  healthCheck,
  closeSearch,
  INDEX
};