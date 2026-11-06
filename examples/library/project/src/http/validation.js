'use strict';

/**
 * HTTP-layer validation helpers.
 *
 * Business modules (src/catalog/catalog.js, src/loans/loans.js) own the
 * authoritative validation rules and throw typed errors with a stable code
 * ('VALIDATION', 'NOT_FOUND', 'CONFLICT'). This module centralizes the
 * request-shape concerns specific to Express — reading JSON bodies, coercing
 * raw path/query inputs, and mapping a thrown domain error to its HTTP status
 * — so route handlers and the error middleware stay thin and consistent.
 *
 * It adds no policy of its own: every rule lines up with the fixed REST
 * contract (positive integer ids/copies, non-empty title/userId, 400/404/409).
 */

const { CatalogError } = require('../catalog/catalog');
const { LoansError } = require('../loans/loans');

/**
 * Parse a value as a positive integer id. Returns null for anything invalid.
 * Kept local (rather than importing from the business modules) so this HTTP
 * helper has no hidden coupling to either module's internal exports.
 * @param {unknown} value
 * @returns {number|null}
 */
function parsePositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/**
 * Map a known domain error to an HTTP status. Handles the typed error classes
 * directly and falls back to a code-based lookup for any structurally similar
 * error. Unknown errors map to 500.
 * @param {Error & {code?: string}} err
 * @returns {number}
 */
function statusFor(err) {
  const code = err && err.code;
  if (err instanceof CatalogError) {
    if (code === 'VALIDATION') return 400;
    return 404;
  }
  if (err instanceof LoansError) {
    if (code === 'VALIDATION') return 400;
    if (code === 'NOT_FOUND') return 404;
    return 409;
  }
  if (code === 'VALIDATION') return 400;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'CONFLICT') return 409;
  return 500;
}

/**
 * Serialize an error into the plain `{error}` body sent to the browser.
 * @param {Error & {code?: string}} err
 * @returns {{error: string}}
 */
function errorBody(err) {
  return { error: (err && err.message) || 'internal server error' };
}

/**
 * Guard for malformed JSON bodies surfaced by the express.json parser
 * (type === 'entity.parse.failed'); treated as a 400 validation failure.
 * @param {Error & {type?: string}} err
 * @returns {boolean}
 */
function isMalformedJson(err) {
  return Boolean(err && err.type === 'entity.parse.failed');
}

module.exports = {
  parsePositiveInt,
  statusFor,
  errorBody,
  isMalformedJson,
};