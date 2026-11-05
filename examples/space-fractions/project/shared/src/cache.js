/**
 * Redis cache client.
 */

const redis = require('redis');

let client = null;

/**
 * Initialize Redis client.
 */
async function initCache(config) {
  if (client) return client;

  const url = config.REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379';

  client = redis.createClient({ url });

  client.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  client.on('connect', () => {
    console.log('Redis connected');
  });

  await client.connect();
  return client;
}

/**
 * Get the Redis client.
 */
function getClient() {
  if (!client) {
    throw new Error('Redis client not initialized. Call initCache() first.');
  }
  return client;
}

/**
 * Get a cached value.
 */
async function get(key) {
  try {
    const val = await getClient().get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

/**
 * Set a cached value with optional TTL in seconds.
 */
async function set(key, value, ttlSeconds) {
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      await getClient().setEx(key, ttlSeconds, serialized);
    } else {
      await getClient().set(key, serialized);
    }
  } catch (err) {
    console.error('Redis set error:', err.message);
  }
}

/**
 * Delete a key.
 */
async function del(key) {
  try {
    await getClient().del(key);
  } catch (err) {
    console.error('Redis del error:', err.message);
  }
}

/**
 * Health check.
 */
async function healthCheck() {
  try {
    await getClient().ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the client.
 */
async function closeCache() {
  if (client) {
    await client.quit();
    client = null;
  }
}

module.exports = {
  initCache,
  getClient,
  get,
  set,
  del,
  healthCheck,
  closeCache
};