/**
 * RabbitMQ message queue client.
 * Used for score events (non-blocking, fire-and-forget).
 */

const amqp = require('amqplib');

let connection = null;
let channel = null;

const EXCHANGE = 'spacefractions.events';
const SCORE_QUEUE = 'score.updated';

/**
 * Initialize RabbitMQ connection and channel.
 */
async function initMQ(config) {
  if (channel) return;

  const url = config.RABBITMQ_URL || process.env.RABBITMQ_URL || 'amqp://localhost:5672';

  connection = await amqp.connect(url);
  connection.on('error', (err) => {
    console.error('RabbitMQ connection error:', err);
  });
  connection.on('close', () => {
    console.log('RabbitMQ connection closed');
    channel = null;
    connection = null;
  });

  channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

  console.log('RabbitMQ connected');
}

/**
 * Publish a score updated event.
 */
async function publishScoreUpdated(gameId, userId, score, questionId) {
  if (!channel) {
    console.warn('RabbitMQ not available, skipping event');
    return;
  }

  const message = Buffer.from(JSON.stringify({
    event: 'score.updated',
    gameId,
    userId,
    score,
    questionId,
    timestamp: new Date().toISOString()
  }));

  try {
    channel.publish(EXCHANGE, SCORE_QUEUE, message, {
      persistent: true,
      contentType: 'application/json'
    });
  } catch (err) {
    console.error('RabbitMQ publish error:', err.message);
  }
}

/**
 * Consume score events (for audit/logging).
 */
async function consumeScoreEvents(handler) {
  if (!channel) return;

  const q = await channel.assertQueue('score-events-audit', { durable: true });
  await channel.bindQueue(q.queue, EXCHANGE, SCORE_QUEUE);

  channel.consume(q.queue, (msg) => {
    if (msg) {
      try {
        const data = JSON.parse(msg.content.toString());
        handler(data);
        channel.ack(msg);
      } catch (err) {
        console.error('Error processing score event:', err.message);
        channel.nack(msg, false, false);
      }
    }
  });
}

/**
 * Health check.
 */
async function healthCheck() {
  try {
    return !!channel;
  } catch {
    return false;
  }
}

/**
 * Close connection.
 */
async function closeMQ() {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
}

module.exports = {
  initMQ,
  publishScoreUpdated,
  consumeScoreEvents,
  healthCheck,
  closeMQ,
  EXCHANGE,
  SCORE_QUEUE
};