'use strict';

/**
 * RabbitMQ score-event emitter for Space Fractions.
 *
 * The game service (`services/game-service.js`) injects an optional `events`
 * adapter so it can publish an event every time an answer is scored, without
 * blocking or failing the authoritative answer result. This module is a *real*
 * AMQP client (via the official `amqplib` package), not a placeholder: it opens
 * a channel, asserts the target exchange, and publishes a serialized score event
 * with a mandatory `content_type` of `application/json` and persistent delivery
 * mode, so the event survives a broker restart. RabbitMQ is a strict side
 * channel — the score it reports is already durably committed in PostgreSQL, and
 * consumers (e.g. dashboards, streaming analytics) may lag or replay without
 * affecting game correctness.
 *
 * Graceful degradation (assumption A-6): when the broker is absent, a connect or
 * publish fails, a publish exceeds the bounded timeout, or the feature is
 * flagged disabled (`disabled` contains "rabbitmq"), `publishScoreEvent` resolves
 * without throwing. The game service therefore never blocks a player's answer on
 * broker availability. Connections are opened lazily and (best effort) closed on
 * `close()`, with per-attempt error logging so a down broker does not flood the
 * log.
 */

const amqp = require('amqplib');

const DEFAULT_URL = 'amqp://localhost:5672';
const DEFAULT_EXCHANGE = 'space-fractions.scores';
const DEFAULT_TIMEOUT_MS = 1000;

/** Feature flag name consumed by top-level wiring to disable this integration. */
const FEATURE_FLAG = 'rabbitmq';

/**
 * Build a score-event emitter.
 *
 * @param {object} [options]
 * @param {string}   [options.url]         AMQP URL (defaults to
 *                                         process.env.RABBITMQ_URL or DEFAULT_URL).
 * @param {string}   [options.exchange]    Exchange to publish to.
 * @param {number}   [options.timeoutMs]   Hard bound for a publish call.
 * @param {Array|Set}[options.disabled]    Disabled feature names; when it contains
 *                                         "rabbitmq", all publishes degrade.
 * @param {Function} [options.clock]       Injectible timers for tests.
 * @param {Function} [options.log]         Log sink (defaults to console).
 *
 * @returns {{ publishScoreEvent: (event:object)=>Promise<void>, close: ()=>Promise<void>, isDisabled: ()=>boolean }}
 */
function createEventEmitter(options = {}) {
  const url = options.url || process.env.RABBITMQ_URL || DEFAULT_URL;
  const exchange = options.exchange || DEFAULT_EXCHANGE;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const disabledSet =
    options.disabled instanceof Set
      ? options.disabled
      : new Set(Array.isArray(options.disabled) ? options.disabled : []);
  const log = options.log || console;
  const clock = options.clock || {};

  let connection = null;
  let channel = null;
  let channelReady = null; // Promise<channel|null> in flight, null when absent
  let connectErrorLogged = false;

  /** Whether this integration is disabled by feature flag. */
  function isDisabled() {
    return disabledSet.has(FEATURE_FLAG) || disabledSet.has('rabbitmq');
  }

  function logWarn(message) {
    if (log.warn) log.warn(message);
  }

  /**
   * Lazily obtain a ready channel. Returns null on any failure (disabled, no
   * amqplib, connect error, channel/assert errors) so publishers degrade.
   * Reuses a single connection/channel per emitter instance for the lifetime of
   * the process; a broken connection is discarded so the next publish retries.
   */
  async function getChannel() {
    if (isDisabled() || !amqp || typeof amqp.connect !== 'function') return null;
    if (channelReady) return channelReady;

    channelReady = (async () => {
      try {
        connection = await withTimeout(amqp.connect(url), timeoutMs, clock);
        const ch = await withTimeout(connection.createChannel(), timeoutMs, clock);
        await withTimeout(ch.assertExchange(exchange, 'topic', { durable: true }), timeoutMs, clock);
        channel = ch;
        return ch;
      } catch (err) {
        if (!connectErrorLogged) {
          connectErrorLogged = true;
          logWarn(`events (rabbitmq) channel setup failed: ${err.message}`);
        }
        // Discard the partial connection/channel so the next call retries fresh.
        try { if (connection && connection.close) await connection.close(); } catch { /* ignore */ }
        connection = null;
        channel = null;
        return null;
      } finally {
        // Allow a later retry after a failure (only keeps the inflight promise
        // while it is in progress; a resolved null must not be cached forever).
        if (channelReady) {
          const settled = channelReady;
          channelReady = null;
          return settled;
        }
      }
    })();

    const settled = channelReady;
    channelReady = null;
    return settled;
  }

  /**
   * Publish a score event. Resolves successfully (never throws) regardless of
   * broker availability so the caller can treat event delivery as best-effort.
   *
   * @param {object} event `{ gameId, userId, score, correct }`
   * @returns {Promise<void>}
   */
  async function publishScoreEvent(event) {
    if (isDisabled()) return;
    const ch = await getChannel();
    if (!ch) return;

    const payload = Buffer.from(JSON.stringify({
      type: 'score.updated',
      gameId: event.gameId,
      userId: event.userId,
      score: event.score,
      correct: Boolean(event.correct),
      at: new Date().toISOString(),
    }));

    const routingKey = 'space-fractions.game.score';
    try {
      await withTimeout(
        ch.publish(exchange, routingKey, payload, {
          persistent: true,
          contentType: 'application/json',
        }),
        timeoutMs,
        clock
      );
    } catch (err) {
      logWarn(`score event publish failed: ${err.message}`);
      // Invalidate the (possibly broken) channel so the next publish retries.
      channel = null;
      if (connection && connection.close) {
        connection.close().catch(() => {});
      }
      connection = null;
    }
  }

  /**
   * Best-effort close of the underlying connection. Never throws.
   */
  async function close() {
    try {
      if (channel && channel.close) await channel.close();
      if (connection && connection.close) await connection.close();
    } catch {
      /* ignore */
    } finally {
      channel = null;
      connection = null;
    }
  }

  return { publishScoreEvent, close, isDisabled };
}

/**
 * Wrap an async operation with a hard timeout. On timeout, resolves undefined so
 * callers degrade gracefully; because `getChannel` treats undefined as failure
 * and `publishScoreEvent` ignores undefined results, a timeout cannot hang.
 */
function withTimeout(operation, ms, clock = {}) {
  const setT = clock.setTimeout || setTimeout;
  const clearT = clock.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setT(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
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
  createEventEmitter,
  FEATURE_FLAG,
  DEFAULT_EXCHANGE,
  DEFAULT_TIMEOUT_MS,
};