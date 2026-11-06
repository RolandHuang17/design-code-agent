'use strict';

/**
 * Game lifecycle state machine for Space Fractions.
 *
 * Mirrors the state diagram in Architecture_View.md:
 *   [*] --> Playing
 *   Playing --> Paused : pause()
 *   Paused --> Playing : resume()
 *   Playing --> GameOver : gameOver()
 *
 * Only these transitions are permitted; attempting an invalid transition throws
 * a typed GameStateError so callers can translate it into an HTTP status
 * (e.g. answering while paused -> 409, acting on a finished game -> 409).
 */

/**
 * Canonical state values. Allowed transitions:
 *   Playing -> Paused  (pause)
 *   Paused  -> Playing (resume)
 *   Playing -> GameOver (gameOver)
 */
const States = Object.freeze({
  PLAYING: 'Playing',
  PAUSED: 'Paused',
  GAME_OVER: 'GameOver',
});

class GameStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GameStateError';
    this.code = code || 'INVALID_TRANSITION';
  }
}

/**
 * Create a fresh game in the Playing state.
 */
function initialState() {
  return { state: States.PLAYING };
}

/**
 * Validate that a raw value represents a known state.
 * Returns the canonical state string or throws GameStateError.
 */
function normalize(state) {
  if (state === undefined || state === null) {
    return States.PLAYING;
  }
  if (!Object.values(States).includes(state)) {
    throw new GameStateError(`Unknown game state: ${String(state)}`, 'INVALID_STATE');
  }
  return state;
}

/**
 * Attempt the pause transition.
 * Allowed only from Playing.
 */
function pause(current) {
  const s = normalize(typeof current === 'string' ? current : current && current.state);
  if (s !== States.PLAYING) {
    throw new GameStateError(
      `Cannot pause from state "${s}"`,
      s === States.GAME_OVER ? 'GAME_OVER' : 'INVALID_TRANSITION'
    );
  }
  return { state: States.PAUSED };
}

/**
 * Attempt the resume transition.
 * Allowed only from Paused.
 */
function resume(current) {
  const s = normalize(typeof current === 'string' ? current : current && current.state);
  if (s !== States.PAUSED) {
    throw new GameStateError(
      `Cannot resume from state "${s}"`,
      s === States.GAME_OVER ? 'GAME_OVER' : 'INVALID_TRANSITION'
    );
  }
  return { state: States.PLAYING };
}

/**
 * Attempt the gameOver transition.
 * Allowed only from Playing.
 */
function gameOver(current) {
  const s = normalize(typeof current === 'string' ? current : current && current.state);
  if (s !== States.PLAYING) {
    throw new GameStateError(
      `Cannot end game from state "${s}"`,
      s === States.GAME_OVER ? 'GAME_OVER' : 'INVALID_TRANSITION'
    );
  }
  return { state: States.GAME_OVER };
}

/**
 * Whether the game currently accepts answers (must be Playing).
 */
function isPlayable(current) {
  const s = normalize(typeof current === 'string' ? current : current && current.state);
  return s === States.PLAYING;
}

module.exports = {
  States,
  GameStateError,
  initialState,
  normalize,
  pause,
  resume,
  gameOver,
  isPlayable,
};