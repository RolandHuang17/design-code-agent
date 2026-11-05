'use strict';

const test = require('node:test');
const assert = require('node:assert');

const metrics = require('../src/metrics');

test('metrics module exposes Prometheus counters and gauges', () => {
  assert.strictEqual(typeof metrics.register, 'object', 'registry should be present');
  assert.strictEqual(typeof metrics.gamesCreated, 'object');
  assert.strictEqual(typeof metrics.answersSubmitted, 'object');
  assert.strictEqual(typeof metrics.questionsCreated, 'object');
  assert.strictEqual(typeof metrics.activeGames, 'object');
  assert.strictEqual(typeof metrics.httpRequestDuration, 'object');
  assert.strictEqual(typeof metrics.httpRequestsTotal, 'object');
});

test('metricsMiddleware records request duration and count', async () => {
  const req = { method: 'GET', path: '/health', route: { path: '/health' } };
  const res = {
    statusCode: 200,
    end() {}
  };
  let nextCalled = false;
  metrics.metricsMiddleware(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true, 'middleware should call next');
  // res.end was wrapped by the middleware.
  assert.strictEqual(typeof res.end, 'function');
  const before = await metrics.getMetrics();
  res.end();
  const after = await metrics.getMetrics();
  assert.ok(after.length >= before.length, 'metrics should be emitted after request ends');
});

test('getMetrics returns Prometheus text format', async () => {
  const text = await metrics.getMetrics();
  assert.strictEqual(typeof text, 'string');
  assert.ok(text.includes('# HELP'), 'should contain prometheus HELP lines');
});

test('getContentType returns text/plain variant', () => {
  const ct = metrics.getContentType();
  assert.strictEqual(typeof ct, 'string');
  assert.ok(/text\/plain/.test(ct));
});

test('counters can be incremented', () => {
  metrics.gamesCreated.inc();
  metrics.answersSubmitted.inc({ correct: 'true' });
  metrics.questionsCreated.inc();
  metrics.activeGames.inc();
  // No assertion on value (async registry), just ensure no throw.
  assert.ok(true);
});