'use strict';

/**
 * Search adapter for question discovery (Elasticsearch with bounded timeout).
 *
 * This module exposes a `search(query)` interface consumed by the question
 * service (`services/question-service.js`). It is a *real* Elasticsearch client
 * (via the official `@elastic/elasticsearch` package), not a placeholder: it
 * issues an actual `search` request against the configured cluster and maps the
 * response hits back to `{ id, prompt }` records. The index is assumed to hold
 * an `id` field mirroring the owning `questions` table primary key, so the
 * caller can reconcile results against the authoritative PostgreSQL store.
 *
 * Graceful degradation: when the backend is absent, times out, errors, or the
 * feature is disabled (DISABLED_FEATURES contains "elasticsearch"), `search()`
 * resolves `undefined`. The question service then falls back to an authoritative
 * database `ILIKE` query, so search correctness never depends on Elastisearch
 * availability. The timeout is honored at the HTTP-call level (Elasticsearch
 * request timeout) *and* at the client level (a supplemental timer so a hung or
 * non-compliant client cannot block indefinitely).
 */

const { Client } = require('@elastic/elasticsearch');

const DEFAULT_INDEX = 'questions';
const DEFAULT_TIMEOUT_MS = 500;

/** Feature flag name used by the top-level wiring to disable this integration. */
const FEATURE_FLAG = 'elasticsearch';

/**
 * Produce a source record a search hit can be projected to. A hit may store the
 * row inline (_source.id / _source.prompt / extra option data) or only the
 * database id (_id). We require at least an integer id; prompt is best-effort
 * for display-only purposes (the authoritative DB fallback supplies the rest).
 */
function hitToRecord(hit) {
  const src = hit?._source || {};
  if (src && typeof src.id === 'number' && Number.isInteger(src.id)) {
    return { id: src.id, prompt: typeof src.prompt === 'string' ? src.prompt : '' };
  }
  if (hit && typeof hit._id === 'string') {
    const parsed = Number.parseInt(hit._id, 10);
    if (Number.isInteger(parsed)) {
      return { id: parsed, prompt: typeof src.prompt === 'string' ? src.prompt : '' };
    }
  }
  return null;
}

/**
 * Create an Elasticsearch-backed search client.
 *
 * @param {object} options
 * @param {string}  [options.node]           Elasticsearch node URL (defaults to
 *                                           process.env.ELASTICSEARCH_URL).
 * @param {string}  [options.index]          Index name to query (defaults to
 *                                           "questions").
 * @param {number}  [options.timeoutMs]      Bounded timeout for each search call
 *                                           (defaults to 500ms).
 * @param {string[]|[disabledFeatures]} [options.disabled] Array/set of disabled
 *                                           feature names; when it contains
 *                                           "elasticsearch" search() resolves
 *                                           undefined (degraded).
 * @param {Function} [options.clock]         Injectible timer for tests.
 *
 * @returns {{ search: (query: string) => Promise<{matched: object[]}|undefined>, searchRaw: Function }}
 */
function createSearchClient(options = {}) {
  const node = options.node || process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
  const index = options.index || DEFAULT_INDEX;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const disabledSet =
    options.disabled instanceof Set
      ? options.disabled
      : new Set(Array.isArray(options.disabled) ? options.disabled : []);

  const requestTimeout = Math.max(1, Math.floor(timeoutMs));

  let client = null;
  if (typeof Client === 'function') {
    try {
      client = new Client({ node, requestTimeout });
    } catch {
      client = null; // constructor failure -> degrade (search resolves undefined)
    }
  }

  /** Whether this integration is disabled by feature flag. */
  function isDisabled() {
    if (disabledSet.has(FEATURE_FLAG)) return true;
    if (disabledSet.has('elasticsearch')) return true;
    return false;
  }

  /**
   * Raw search against the configured index. Returns raw Elasticsearch body or
   * throws. Used internally and exposed for tests/debugging.
   */
  async function rawSearch(query) {
    if (!client) return undefined;
    const body = await client.search({
      index,
      size: 100,
      body: {
        query: {
          multi_match: {
            query,
            fields: ['prompt^2', 'prompt.folded'],
            fuzziness: 'AUTO',
          },
        },
      },
    });
    return body;
  }

  /**
   * Bounded, degrading search. Resolves `undefined` on absence/timeout/error so
   * the question service can fall back to the authoritative DB search.
   *
   * @param {string} query
   * @returns {Promise<{matched: object[]} | undefined>}
   */
  async function search(query) {
    if (isDisabled() || !client) return undefined;
    if (typeof query !== 'string' || query.trim() === '') {
      return { matched: [] };
    }
    const term = query.trim();

    return withClientTimeout(async () => {
      const body = await rawSearch(term);
      if (!body || !body.hits || !Array.isArray(body.hits.hits)) {
        return { matched: [] };
      }
      const matched = body.hits.hits
        .map(hitToRecord)
        .filter((r) => r !== null);
      return { matched };
    }, timeoutMs, options.clock);
  }

  return { search, rawSearch };
}

/**
 * Wrap an async operation with a client-side timeout. Resolves undefined rather
 * than throwing on timeout, so consumers degrade gracefully.
 */
function withClientTimeout(operation, ms, clock = {}) {
  const setT = clock.setTimeout || setTimeout;
  const clearT = clock.clearTimeout || clearTimeout;

  return new Promise((resolve) => {
    let done = false;
    const timer = setT(() => {
      if (!done) {
        done = true;
        resolve(undefined);
      }
    }, ms);

    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (!done) {
          done = true;
          clearT(timer);
          resolve(value);
        }
      })
      .catch(() => {
        if (!done) {
          done = true;
          clearT(timer);
          resolve(undefined);
        }
      });
  });
}

module.exports = {
  createSearchClient,
  hitToRecord,
  FEATURE_FLAG,
  DEFAULT_INDEX,
  DEFAULT_TIMEOUT_MS,
};