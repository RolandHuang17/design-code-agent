'use strict';

/**
 * Typed error hierarchy for the Space Fractions system.
 *
 * The architecture requires that all errors surface as typed HTTP errors so
 * that gateways and services can map failures to stable status codes without
 * leaking stack traces or internal state. Every error carries a stable
 * `code` (a machine-readable token) alongside a human-readable `message`.
 */

/** Base application error. Never thrown directly. */
class AppError extends Error {
  constructor(message, code = 'INTERNAL_ERROR', status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.expose = status < 500; // Do not leak internals for server errors.
  }

  /**
   * A safe, serializable payload for HTTP responses. Server-error messages
   * are masked by default so that internal details never escape.
   * @returns {{ code: string, message: string }}
   */
  toJSON() {
    return {
      code: this.code,
      message: this.expose ? this.message : 'Internal server error.',
    };
  }
}

/** 400 — malformed request or invalid input. */
class ValidationError extends AppError {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(message, code, 400);
  }
}

/** 401 — missing or invalid credentials. */
class AuthenticationError extends AppError {
  constructor(message = 'Authentication required.', code = 'UNAUTHORIZED') {
    super(message, code, 401);
  }
}

/** 403 — authenticated but not permitted. */
class AuthorizationError extends AppError {
  constructor(message = 'The current user is not allowed to perform this action.', code = 'FORBIDDEN') {
    super(message, code, 403);
  }
}

/** 404 — resource not found or hidden from the caller. */
class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', code = 'NOT_FOUND') {
    super(message, code, 404);
  }
}

/** 409 — state conflict (e.g. double submit, duplicate). */
class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(message, code, 409);
  }
}

/**
 * 504 — a downstream (or bounded-timeout) call exceeded its deadline.
 * The architecture mandates bounded downstream timeouts; when that budget is
 * exhausted we surface a typed gateway-timeout rather than hanging.
 */
class TimeoutError extends AppError {
  constructor(message = 'Downstream service timed out.', code = 'UPSTREAM_TIMEOUT') {
    super(message, code, 504);
  }
}

/**
 * 502/503 — an upstream dependency failed or was unavailable.
 * @param {string} message
 * @param {{ status?: number, code?: string, cause?: Error }} [options]
 */
class UpstreamError extends AppError {
  constructor(message, options = {}) {
    const status = options.status || 502;
    super(message, options.code || 'UPSTREAM_ERROR', status);
    if (options.cause) this.cause = options.cause;
  }
}

/**
 * Convert any thrown value into a known {@link AppError}. Unknown errors
 * become a masked 500 AppError; known errors pass through unchanged. This is
 * the single choke point for translating internal failures to HTTP responses.
 * @param {unknown} err
 * @returns {AppError}
 */
function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err && typeof err === 'object' && typeof err.code === 'string' && typeof err.status === 'number') {
    // A structurally-compatible error from another module (e.g. a wrapped
    // downstream client error) — coerce it conservatively as an upstream error.
    return new UpstreamError(String(err.message || 'Upstream error.'), {
      status: err.status,
      code: err.code,
      cause: err.cause,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new AppError(message, 'INTERNAL_ERROR', 500);
  return wrapped;
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  TimeoutError,
  UpstreamError,
  toAppError,
};