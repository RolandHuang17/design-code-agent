'use strict';

/**
 * Core domain types for the Space Fractions system.
 *
 * These are plain (frozen) shape descriptors plus small factories used across
 * the gateway services. The module performs no external I/O and carries no
 * platform-specific dependencies, so it can be imported by every layer.
 */

/**
 * Game lifecycle states from the provided state diagram.
 * Only these three states exist; transitions are valid solely through
 * pause() / resume() / gameOver() (see lib/game-state.js).
 */
const States = Object.freeze({
  Playing: 'Playing',
  Paused: 'Paused',
  GameOver: 'GameOver',
});

/**
 * Game states in which an answer may be submitted. Paused and GameOver both
 * disallow answers (paused answers surface as HTTP 409 in the gateway).
 */
const ANSWERABLE_STATES = Object.freeze([States.Playing]);

/**
 * A normalized fraction value with a strictly positive denominator and a
 * numerator/denominator reduced by greatest common divisor. Produced by the
 * reduce/fromParts helpers in lib/fraction.js.
 *
 * @typedef {Object} Fraction
 * @property {number} numerator   Integer numerator (carries the sign).
 * @property {number} denominator Positive integer denominator.
 */

/**
 * A validated question answer as stored/seeded: a single reduced fraction.
 *
 * @typedef {Object} FractionValue
 * @property {number} numerator   Integer numerator (carries the sign).
 * @property {number} denominator Positive integer denominator.
 */

/**
 * A persisted question (admin view) includes the correct answer.
 *
 * @typedef {Object} QuestionRecord
 * @property {number} id
 * @property {string} prompt
 * @property {string[]} options
 * @property {string} correctAnswer  Single reduced fraction, 'n/d'.
 */

/**
 * A player-facing question: same shape minus the correct answer.
 *
 * @typedef {Object} PlayerQuestion
 * @property {number} id
 * @property {string} prompt
 * @property {string[]} options
 */

/**
 * A verified OIDC principal derived from a validated access token.
 *
 * @typedef {Object} Principal
 * @property {string} sub            OIDC subject identifier.
 * @property {string[]} roles        realm_access.roles (or empty array).
 * @property {number|null} userId    Mapped numeric internal user id (or null).
 */

/**
 * An identity (sub -> numeric id) as persisted by the user mapping layer.
 *
 * @typedef {Object} UserRecord
 * @property {number} id
 * @property {string} sub
 */

/**
 * A game's live state persisted in PostgreSQL (JSONB) plus its ownership.
 *
 * @typedef {Object} GameStateRecord
 * @property {number} id
 * @property {number} ownerUserId
 * @property {'Playing'|'Paused'|'GameOver'} state
 * @property {number} score
 * @property {number[]} answeredQuestionIds
 */

/**
 * Predicates used across services to keep behavior consistent with the
 * state machine in lib/game-state.js.
 */

/**
 * @param {GameStateRecord} game
 * @returns {boolean}
 */
function isAnswerable(game) {
  return Boolean(game) && ANSWERABLE_STATES.includes(game.state);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isKnownState(value) {
  return Object.prototype.hasOwnProperty.call(States, value);
}

module.exports = {
  States,
  ANSWERABLE_STATES,
  isAnswerable,
  isKnownState,
};