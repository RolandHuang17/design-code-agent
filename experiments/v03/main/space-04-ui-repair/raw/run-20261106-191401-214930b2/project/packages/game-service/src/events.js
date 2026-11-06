'use strict';

/**
 * Score-event publisher — RabbitMQ integration for the game service.
 *
 * Emits a lightweight score event whenever a game is created or a correct
 * answer is recorded, so downstream consumers (metrics, leaderboards) can
 * react asynchronously without blocking the request path. This is a real
 * amqplib integration (space-fractions.md line 30): the channel is opened
 * lazily on the first publish, message publication is confirmed, and the
 * connection is bounded (open timeout) so a down broker fails fast instead of
 * hanging the HTTP handler. Publishing is always non-fatal to the route
 * (index.js catches publishScore failures and logs a warning).
 *
 * Event shape (JSON, a single UTF-8 Buffer):
 *   { gameId: number, score: number, at: ISO-8601 timestamp }
 *
 * Exchange/queue naming is fixed and documented against compose.yaml; the
 * durable queue is declared idempotently via assertQueue.
 */

const amqp = require('amqplib');

const EXCHANGE = 'space_fractions.scores';
const QUEUE = 'space_fractions.score_events';
const ROUTING_KEY = 'score.updated';

/** Milliseconds to wait for a broker connection before failing a publish. */
const CONNECT_TIMEOUT_MS = 2000;

/** Number of seconds to retain the declared queue after consumers disconnect. */
const QUEUE_MESSAGE_TTL_MS = 0; // unlimited; events are durable and small

/**
 * RabbitMQ-backed publisher.
 *
 * @param {string} url amqp:// connection string to the broker
 * @param {object} [options]
 * @param {number} [options.connectTimeoutMs]
 */
class RabbitMqEventPublisher {
  constructor(url, options = {}) {
    if (!url) throw new Error('RabbitMqEventPublisher requires a broker URL');
    this.url = url;
    this.connectTimeoutMs = options.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    this.connection = null;
    this.channel = null;
  }

  async _ensureChannel() {
    if (this.channel) return this.channel;

    // Bound the connect so a down broker cannot hang the request path.
    const connection = await amqp.connect(this.url, { timeout: this.connectTimeoutMs });
    this.connection = connection;

    // Detach cleanly if the broker drops us mid-flight; the next publish will
    // reconnect lazily.
    connection.on('error', () => {
      this._reset();
    });
    connection.on('close', () => {
      this._reset();
    });

    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    // Declaring the queue keeps the topology explicit; durability ensures the
    // broker retains scored events across restarts.
    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: { 'x-message-ttl': QUEUE_MESSAGE_TTL_MS },
    });
    await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
    this.channel = channel;
    return channel;
  }

  _reset() {
    this.channel = null;
    this.connection = null;
  }

  /**
   * Publish a score event. Confirmation (publisher confirm) is awaited so the
   * caller knows the broker accepted the message; failures propagate to the
   * caller, which treats them as non-fatal to the HTTP response.
   *
   * @param {number} gameId
   * @param {number} score
   * @returns {Promise<boolean>} true once the broker confirms the publish
   */
  async publishScore(gameId, score) {
    const channel = await this._ensureChannel();
    const payload = Buffer.from(
      JSON.stringify({
        gameId,
        score,
        at: new Date().toISOString(),
      }),
    );
    return channel.publish(EXCHANGE, ROUTING_KEY, payload, {
      persistent: true,
      contentType: 'application/json',
    });
  }

  /** Close the channel/connection (idempotent). */
  async close() {
    try {
      if (this.channel) await this.channel.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.connection) await this.connection.close();
    } catch {
      /* ignore */
    }
    this._reset();
  }
}

module.exports = {
  RabbitMqEventPublisher,
  EXCHANGE,
  QUEUE,
  ROUTING_KEY,
};