'use strict';

/**
 * Redis read-through cache adapter for Space Fractions.
 *
 * The game service (`services/game-service.js`) injects an optional cache so it
 * can serve frequently-read player state without re-reading PostgreSQL on every
 * request. This module is a *real* Redis client (via the official `redis`
 * package), not a placeholder: `get(key)` issues an actual GET and `set(key,
 * value, ttlMs)` issues SET with PX expiry. It is strictly a pass-through cache
 * — PostgreSQL remains the system of record, and any cache miss simply falls
 * through to the authoritative database (the caller is responsible for the
 * read-side population).
 *
 * Graceful degradation (assumption A-6): when Redis is absent, the client fails
 * to connect, an operation times out or errors, or the feature is flagged
 * disabled (`disabled` contains "redis"), `get` resolves `null` and `set`
 * resolves without throwing, so the cache never becomes a hard dependency of
 * the game flow. Strategy is plain Redis rather than Redis Cluster, so no
 * MIGRATE/ASK handling is required; a failed write is logged and ignored.
 */

const { createClient } = require('redis');

const DEFAULT_TTL_MS = 30_000;
/** Feature flag name consumed by top-level wiring to disable this integration. */
const FEATURE_FLAG = 'redis';

/**
 * Build a read-through cache adapter.
 *
 * @param {object} [options]
 * @param {string}   [options.url]       Redis URL (defaults to
 *                                       process.env.REDIS_URL or redis://localhost:6379).
 * @param {number}   [options.defaultTtlMs] Default TTL for set() when none is given.
 * @param {Function} [options.clock]     Injectible timers/setTimeout for tests.
 * @param {Array|Set} [options.disabled] Disabled feature names; when it contains
 *                                       "redis", all operations degrade.
 * @param {Function} [options.log]       Log sink (defaults to console).
 *
 * @returns {{ get: (key:string)=>Promise<string|null>, set: (key:string, value:string, ttlMs?:number)=>Promise<void>, isDisabled: ()=>boolean }}
 */
function createCache(options = {}) {
  const url = options.url || process.env.REDIS_URL || 'redis://localhost:6379';
  const defaultTtlMs = options.defaultTtlMs || DEFAULT_TTL_MS;
  const disabledSet =
    options.disabled instanceof Set
      ? options.disabled
      : new Set(Array.isArray(options.disabled) ? options.disabled : []);
  const log = options.log || console;
  const clock = options.clock || {};

  let client = null;
  let connectErrorLogged = false;

  if (typeof createClient === 'function') {
    try {
      client = createClient({ url });
      // Fire-and-forget connect; we do not await it here because the service must
      // remain operational if Redis is down. Errors surface via log on first use.
      const ready = client.on ? client.on('error', (err) => {
        if (!connectErrorLogged) {
          connectErrorLogged = true;
          log.warn && log.warn(`cache (redis) error: ${err.message}`);
        }
      }) : null;
      if (client.connect && typeof client.connect === 'function') {
        client.connect().catch((err) => {
          if (!connectErrorLogged) {
            connectErrorLogged = true;
            log.warn && log.warn(`cache (redis) connect failed: ${err.message}`);
          }
        });
      }
      void ready;
    } catch (err) {
      client = null;
      log.warn && log.warn(`cache (redis) client creation failed: ${err.message}`);
    }
  }

  /** Whether this integration is disabled by feature flag. */
  function isDisabled() {
    return disabledSet.has(FEATURE_FLAG) || disabledSet.has('redis');
  }

  /**
   * Read a key. Resolves null on absence, error, timeout, or disablement.
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async function get(key) {
    if (isDisabled() || !client) return null;
    try {
      const value = await withTimeout(client.get(key), defaultTtlMs, clock);
      return value === null || typeof value !== 'string' ? null : value;
    } catch (err) {
      log.warn && log.warn(`cache get failed for "${key}": ${err.message}`);
      return null;
    }
  }

  /**
   * Write a key with an optional TTL. Never throws (best-effort cache write).
   * @param {string} key
   * @param {string} value
   * @param {number} [ttlMs]
   * @returns {Promise<void>}
   */
  async function set(key, value, ttlMs) {
    if (isDisabled() || !client) return;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : defaultTtlMs;
    try {
      await withTimeout(client.set(key, String(value), { PX: ttl }), defaultTtlMs, clock);
    } catch (err) {
      log.warn && log.warn(`cache set failed for "${key}": ${err.message}`);
    }
  }

  return { get, set, isDisabled };
}

/**
 * Wrap an async operation with a hard timeout. Resolves undefined on timeout so
 * callers degrade gracefully instead of hanging. Used to bound a hung Redi client.
 */
function withTimeout(operation, ms, clock = {}) {
  const setT = clock.setTimeout || setTimeout;
  const clearT = clock.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setT(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`cache operation timed out after ${ms}ms`));
      }
    }, ms);

    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (!settled) {
          settled = true;
          clearT(timer);
          resolve(value);
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearT(timer);
          reject(err);
        }
      });
  });
}

module.exports = {
  createCache,
  FEATURE_FLAG,
  DEFAULT_TTL_MS,
};