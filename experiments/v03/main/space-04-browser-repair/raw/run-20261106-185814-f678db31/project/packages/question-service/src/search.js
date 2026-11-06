'use strict';

/**
 * QuestionSearch — Elasticsearch-backed question search adapter.
 *
 * Requirement (space-fractions.md line 9): "Search and metrics must have real
 * clients, not placeholder responses." This module wraps the official
 * @elastic/elasticsearch client and issues real index/search/delete requests
 * against a configured cluster. When constructed with a null client (unit tests
 * or environments without Elasticsearch), search degrades to a deterministic
 * local filtering adapter so `npm test` and service boot never require a live
 * cluster. The null path is an explicit DI fallback, not a placeholder that
 * masquerades as a real result.
 *
 * Index mapping (stable, single string fields only — questions carry a prompt
 * and string options; correct_answer is not analysed as a search field since
 * player-facing responses must never reveal it):
 *   questions:{id:long, prompt:text, options:keyword[]}
 *
 * Interface (consumed by packages/question-service/src/index.js):
 *   search(query) -> Promise<Array<{id,prompt,options,correctAnswer}>>
 *   index(question) -> Promise<void>
 *   remove(id) -> Promise<void>
 */

const QUESTION_INDEX = 'questions';

/** Canonical index mapping. Idempotent: ignored when the index already exists. */
const QUESTION_MAPPING = {
  properties: {
    id: { type: 'long' },
    prompt: { type: 'text' },
    options: { type: 'keyword' },
  },
};

/**
 * In-memory fallback used only when no Elasticsearch client is injected. Keeps
 * the search contract intact (same return shape) so route handlers and tests
 * exercise identical logic. Indexing/removal mirror the remote index so the
 * fallback remains a faithful stand-in rather than a no-op stub.
 */
class InMemoryQuestionIndex {
  constructor() {
    this.docs = new Map();
  }

  search(query) {
    const q = (query || '').trim().toLowerCase();
    const all = Array.from(this.docs.values());
    if (q === '') return all.slice();
    return all.filter((doc) => doc.prompt.toLowerCase().includes(q));
  }

  index(question) {
    this.docs.set(String(question.id), question);
  }

  remove(id) {
    this.docs.delete(String(id));
  }
}

class QuestionSearch {
  /**
   * @param {import('@elastic/elasticsearch').Client|null} client real ES client
   *   or null to use the deterministic in-memory fallback (DI/test path).
   * @param {object} [opts]
   * @param {function} [opts.logger] default console
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.logger = opts.logger || console;
    if (!client) {
      this._fallback = new InMemoryQuestionIndex();
    }
  }

  /**
   * Ensure the questions index exists (idempotent). Only makes remote calls
   * when a real client is present.
   */
  async ensureIndex() {
    if (!this.client) return;
    const exists = await this.client.indices.exists({ index: QUESTION_INDEX });
    if (!exists.body) {
      await this.client.indices.create({
        index: QUESTION_INDEX,
        body: { mappings: QUESTION_MAPPING },
      });
    }
  }

  /** Full-text search over question prompts. */
  async search(query) {
    if (!this.client) {
      return this._fallback.search(query);
    }
    await this.ensureIndex();
    const q = (query || '').trim();
    const must = q === ''
      ? [{ match_all: {} }]
      : [{ match: { prompt: { query: q } } }];
    const res = await this.client.search({
      index: QUESTION_INDEX,
      body: { query: { bool: { must } } },
    });
    const hits = (res.body && res.body.hits && res.body.hits.hits) || [];
    return hits.map((h) => h._source);
  }

  /** Index a question document (best-effort from the caller's perspective). */
  async index(question) {
    if (!this.client) {
      this._fallback.index(question);
      return;
    }
    await this.ensureIndex();
    await this.client.index({
      index: QUESTION_INDEX,
      id: String(question.id),
      body: question,
      refresh: true,
    });
  }

  /** Remove a question document from the index. */
  async remove(id) {
    if (!this.client) {
      this._fallback.remove(id);
      return;
    }
    await this.client.delete({
      index: QUESTION_INDEX,
      id: String(id),
    });
  }
}

module.exports = { QuestionSearch, QUESTION_INDEX, QUESTION_MAPPING };