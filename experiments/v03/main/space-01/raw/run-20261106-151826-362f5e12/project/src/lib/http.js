'use strict';

/**
 * Shared HTTP client utilities for Space Fractions services.
 *
 * Every downstream HTTP call MUST carry a bounded timeout so that a slow or
 * wedged dependency cannot stall a request indefinitely (Architecture
 * requirement G / operator acceptance contract line 12). When the budget is
 * exhausted we translate the failure to a typed {@link TimeoutError}; HTTP
 * status failures become typed {@link UpstreamError}; everything else is
 * normalized through {@link toAppError}.
 */

const { TimeoutError, UpstreamError, toAppError } = require('./errors');

/** @typedef {{ status: number, headers: Record<string,string>, text: string, json?: any }} HttpResponse */

/**
 * Build a timeout controller bound to `ms`. When the timer fires, the
 * associated request is aborted and the reason propagates to the caller.
 * @param {number} ms
 * @param {{ setTimeout?: Function, clearTimeout?: Function }} [timers]
 * @returns {{ signal: AbortSignal, done: () => void }}
 */
function withTimeout(ms, timers = {}) {
  const setTimeoutFn = timers.setTimeout || setTimeout;
  const clearTimeoutFn = timers.clearTimeout || clearTimeout;
  const controller = new AbortController();
  const timer = setTimeoutFn(() => controller.abort(), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    done: () => clearTimeoutFn(timer),
  };
}

/**
 * Perform a downstream GET. The response body is read as text; a JSON body is
 * parsed when the content type indicates JSON. HTTP error statuses are mapped
 * to {@link UpstreamError} with the upstream status attached.
 *
 * @param {string} url
 * @param {{ fetch?: Function, timeoutMs?: number, headers?: Record<string,string> }} [options]
 * @returns {Promise<HttpResponse>}
 */
async function get(url, options = {}) {
  const fetchFn = options.fetch || fetch;
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : 5000;
  const guard = withTimeout(timeoutMs);

  let res;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: options.headers || {},
      signal: guard.signal,
    });
  } catch (err) {
    throw toTimeoutOrAppError(err);
  } finally {
    guard.done();
  }

  return readResponse(res);
}

/**
 * Perform a downstream request with a JSON body. Timeout handling matches
 * {@link get} and non-2xx responses raise typed {@link UpstreamError}.
 *
 * @param {string} url
 * @param {'POST'|'PUT'} method
 * @param {unknown} body
 * @param {{ fetch?: Function, timeoutMs?: number, headers?: Record<string,string> }} [options]
 * @returns {Promise<HttpResponse>}
 */
async function sendJson(url, method, body, options = {}) {
  const fetchFn = options.fetch || fetch;
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : 5000;
  const guard = withTimeout(timeoutMs);

  let res;
  try {
    res = await fetchFn(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
  } catch (err) {
    throw toTimeoutOrAppError(err);
  } finally {
    guard.done();
  }

  return readResponse(res);
}

/**
 * Read and normalize a downstream {@link Response}. A non-2xx status becomes a
 * typed {@link UpstreamError} carrying the upstream status code; otherwise the
 * body text (and, when applicable, parsed JSON) is returned.
 * @param {Response} res
 * @returns {Promise<HttpResponse>}
 */
async function readResponse(res) {
  const text = await res.text();
  const headers = {};
  if (res.headers && typeof res.headers.forEach === 'function') {
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
  }
  const result = { status: res.status, headers, text };

  if (!res.ok) {
    throw new UpstreamError(
      `Downstream request failed with status ${res.status}.`,
      { status: res.status, code: 'UPSTREAM_ERROR' },
    );
  }

  const contentType = headers['content-type'] || '';
  if (text && (contentType.includes('application/json') || /^\s*[{[]/.test(text))) {
    try {
      result.json = JSON.parse(text);
    } catch {
      // Leave `json` undefined; callers fall back to `text`.
    }
  }
  return result;
}

/**
 * Translate a fetch error into a timeout error when the request was aborted by
 * our deadline guard, or a normalized {@link AppError} otherwise.
 * @param {unknown} err
 * @returns {Error}
 */
function toTimeoutOrAppError(err) {
  if (err && err.name === 'AbortError') {
    return new TimeoutError('Downstream service timed out.');
  }
  const app = toAppError(err);
  // Network-level failures (e.g. fetch failed) are upstream availability
  // problems, not internal bugs.
  if (app.code === 'INTERNAL_ERROR') {
    return new UpstreamError('Downstream request failed.', { cause: err });
  }
  return app;
}

module.exports = {
  get,
  sendJson,
  readResponse,
  withTimeout,
};