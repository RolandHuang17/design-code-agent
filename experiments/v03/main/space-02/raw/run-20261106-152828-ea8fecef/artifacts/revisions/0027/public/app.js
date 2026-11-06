'use strict';

/**
 * Space Fractions browser client (plain JS, no bundler).
 *
 * Responsibilities:
 *   * OIDC authorization-code flow with PKCE S256 (real browser flow only).
 *     Public client `space-fractions-client`; tokens held in memory/sessionStorage
 *     and sent back to the gateway as `Authorization: Bearer <access token>`.
 *     No password grants are used or exposed here — that path exists only for the
 *     isolated server-side acceptance fixtures.
 *   * Introduction / main menu, play, submit answers (never reveal correct
 *     answers — the server returns only correct/score), scoring, pause/resume,
 *     ending feedback, help, and authenticated administrator question CRUD.
 *
 * All server truths (validation, scoring, dedup, pause guard, owner authorization)
 * live in the gateway; this client only renders what the API returns and surfaces
 * HTTP errors for 400/401/403/404/409.
 */

/* ------------------------------------------------------------------------- */
/* OIDC configuration (derived from the public origin so redirects follow      */
/* PUBLIC_ORIGIN / OIDC_ISSUER rather than a hard-coded host port).            */
/* ------------------------------------------------------------------------- */
const OIDC_CONFIG = (() => {
  // PUBLIC_ORIGIN is the browser-facing base origin (e.g. http://localhost:3000).
  // Detect at runtime so test harnesses remapping ports still work.
  const publicOrigin = window.PUBLIC_ORIGIN ||
    `${window.location.protocol}//${window.location.host}`;
  // OIDC public origin points at the identity provider's public base origin;
  // fall back to same-origin /keycloak-less relative discovery when unset.
  const issuer = window.OIDC_PUBLIC_ORIGIN || publicOrigin;

  return {
    publicOrigin,
    // Keycloak OIDC discovery endpoints. OIDC_ISSUER/OIDC_PUBLIC_ORIGIN are the
    // public issuer; the realm is space-fractions.
    issuer: issuer,
    authorizationEndpoint: `${issuer.replace(/\/+$/, '')}/realms/space-fractions/protocol/openid-connect/auth`,
    tokenEndpoint: `${issuer.replace(/\/+$/, '')}/realms/space-fractions/protocol/openid-connect/token`,
    logoutEndpoint: `${issuer.replace(/\/+$/, '')}/realms/space-fractions/protocol/openid-connect/logout`,
    clientId: 'space-fractions-client',
    redirectUri: `${publicOrigin.replace(/\/+$/, '')}/`,
    scope: 'openid profile',
  };
})();

/* ------------------------------------------------------------------------- */
/* PKCE + state helpers                                                       */
/* ------------------------------------------------------------------------- */
function base64Url(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[c & 63] : '=';
  }
  return out.replace(/=+$/, '');
}

function randomBytes(n) {
  const arr = new Uint8Array(n);
  window.crypto.getRandomValues(arr);
  return arr;
}

function randomString(n) {
  return base64Url(randomBytes(n));
}

/** SHA-256 digest of a string, returned as base64url (PKCE S256 code_challenge). */
async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return base64Url(new Uint8Array(digest));
}

/* ------------------------------------------------------------------------- */
/* Token / session storage                                                    */
/* ------------------------------------------------------------------------- */
const TOKEN_SESSION_KEY = 'space-fractions-session';
let accessToken = null;
let idPayload = null;

function persistSession() {
  if (accessToken) {
    sessionStorage.setItem(TOKEN_SESSION_KEY, accessToken);
  } else {
    sessionStorage.removeItem(TOKEN_SESSION_KEY);
  }
}

function restoreSession() {
  accessToken = sessionStorage.getItem(TOKEN_SESSION_KEY) || null;
  if (accessToken) {
    idPayload = decodeJwtPayload(accessToken);
  }
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padBase64(payload));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function padBase64(s) {
  while (s.length % 4 !== 0) s += '=';
  return s;
}

function isAuthenticated() {
  return Boolean(accessToken);
}

function isAdminUser() {
  const roles = idPayload && idPayload.realm_access && idPayload.realm_access.roles;
  return Array.isArray(roles) && roles.includes('admin');
}

/* ------------------------------------------------------------------------- */
/* OIDC flows                                                                 */
/* ------------------------------------------------------------------------- */
async function login() {
  const state = randomString(32);
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);

  sessionStorage.setItem('space-fractions-oauth-state', state);
  sessionStorage.setItem('space-fractions-oauth-verifier', codeVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OIDC_CONFIG.clientId,
    redirect_uri: OIDC_CONFIG.redirectUri,
    scope: OIDC_CONFIG.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  window.location.assign(`${OIDC_CONFIG.authorizationEndpoint}?${params.toString()}`);
}

/** Handle the authorization-code redirect on page load. */
async function handleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) {
    showGlobalError('Login failed: ' + (params.get('error_description') || error));
    cleanRedirectQuery();
    return;
  }

  if (!code) return; // not an auth redirect

  const expectedState = sessionStorage.getItem('space-fractions-oauth-state');
  const codeVerifier = sessionStorage.getItem('space-fractions-oauth-verifier');
  sessionStorage.removeItem('space-fractions-oauth-state');
  sessionStorage.removeItem('space-fractions-oauth-verifier');

  if (!state || state !== expectedState || !codeVerifier) {
    showGlobalError('Login state mismatch; please try again.');
    cleanRedirectQuery();
    return;
  }

  try {
    await exchangeCode(code, codeVerifier);
    cleanRedirectQuery();
    boot();
  } catch (err) {
    showGlobalError('Could not complete login: ' + friendlyError(err));
    cleanRedirectQuery();
  }
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: OIDC_CONFIG.redirectUri,
    client_id: OIDC_CONFIG.clientId,
    code_verifier: codeVerifier,
  });

  const res = await fetch(OIDC_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error('token endpoint returned ' + res.status);
  }

  const data = await res.json();
  accessToken = data.access_token;
  idPayload = data.id_token ? decodeJwtPayload(data.id_token) : decodeJwtPayload(accessToken);
  persistSession();
}

function logout() {
  accessToken = null;
  idPayload = null;
  persistSession();
  window.location.reload();
}

function cleanRedirectQuery() {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, document.title, url.pathname);
}

/* ------------------------------------------------------------------------- */
/* API helper (sends Bearer token; maps JSON errors to text)                  */
/* ------------------------------------------------------------------------- */
async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});
  if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const message = (data && data.error) || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

function friendlyError(err) {
  return err && err.message ? err.message : String(err);
}

function showGlobalError(message) {
  const intro = document.getElementById('intro-error');
  if (intro) {
    intro.textContent = message;
    intro.hidden = false;
  }
}

/* ------------------------------------------------------------------------- */
/* UI state                                                                   */
/* ------------------------------------------------------------------------- */
let currentGame = null;
let currentQuestions = [];
let currentIndex = 0;
let currentScore = 0;
let paused = false;

function byId(id) {
  return document.getElementById(id);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('is-active', s.id === name);
  });
}

/* ------------------------------------------------------------------------- */
/* Screens / handlers                                                         */
/* ------------------------------------------------------------------------- */
function boot() {
  restoreSession();

  // If we just completed an OIDC redirect, handleRedirect already booted us.
  renderIdentity();

  if (!isAuthenticated()) {
    showLoginGate();
    return;
  }

  showScreen('screen-intro');
  renderAdminAvailability();
}

function renderIdentity() {
  const whoami = byId('whoami');
  if (!whoami) return;
  if (isAuthenticated()) {
    const name = (idPayload && (idPayload.preferred_username || idPayload.name)) || 'Player';
    whoami.textContent = name + (isAdminUser() ? ' (admin)' : '');
  } else {
    whoami.textContent = '';
  }
}

function showLoginGate() {
  showScreen('screen-intro');
  const intro = byId('intro-error');
  if (intro) {
    intro.hidden = false;
    intro.textContent = 'Sign in to play.';
  }
  const menu = document.querySelector('#screen-intro .menu');
  if (menu && !byId('login-btn')) {
    const btn = document.createElement('button');
    btn.id = 'login-btn';
    btn.className = 'btn';
    btn.textContent = 'Sign In';
    btn.type = 'button';
    btn.addEventListener('click', () => login().catch(() => {}));
    menu.prepend(btn);
  }
}

function renderAdminAvailability() {
  // Admin CRUD is only reachable by admins; hide the admin form for non-admins.
  const adminScreen = byId('screen-admin');
  if (!adminScreen) return;
  if (isAdminUser()) {
    adminScreen.hidden = false;
  } else {
    adminScreen.hidden = true;
  }
}

async function startGame() {
  hideError('intro-error');
  try {
    const game = await api('/api/games', { method: 'POST', body: {} });
    beginGame(game);
  } catch (err) {
    showIntroError(friendlyError(err));
  }
}

function beginGame(game) {
  currentGame = game;
  currentQuestions = (game.questions || []);
  currentIndex = 0;
  currentScore = game.score || 0;
  paused = false;

  showScreen('screen-play');
  byId('resume-btn').hidden = true;
  renderPlayScreen();
}

function renderPlayScreen() {
  if (!currentGame) return;

  const statusChip = byId('play-status');
  const scoreChip = byId('play-score');
  const promptEl = byId('prompt');
  const form = byId('answer-form');
  const resumeBtn = byId('resume-btn');

  scoreChip.textContent = 'Score: ' + currentScore;

  if (currentIndex < currentQuestions.length) {
    const q = currentQuestions[currentIndex];
    promptEl.textContent = q.prompt;
    statusChip.textContent = paused ? 'Paused' : 'Playing';
    form.hidden = paused;
    resumeBtn.hidden = !paused;
    byId('answer-input').value = '';
    if (!paused) byId('answer-input').focus();
  } else {
    // All questions answered — move to score screen.
    viewScore();
  }
}

async function submitAnswer(ev) {
  ev.preventDefault();
  hideError('play-error');
  const input = byId('answer-input');
  const answer = input.value.trim();
  if (!answer) return;

  const q = currentQuestions[currentIndex];
  if (!q) return;

  try {
    const result = await api(`/api/games/${currentGame.id}/answers`, {
      method: 'POST',
      body: { questionId: q.id, answer },
    });
    currentIndex += 1;
    currentScore = result.score;
    byId('answer-feedback').textContent = result.correct ? 'Correct!' : 'Incorrect.';
    byId('answer-feedback').className = 'feedback ' + (result.correct ? 'is-correct' : 'is-wrong');
    input.value = '';
    renderPlayScreen();
  } catch (err) {
    byId('answer-feedback').textContent = '';
    showPlayError(friendlyError(err));
  }
}

async function pauseGame() {
  hideError('play-error');
  try {
    await api(`/api/games/${currentGame.id}/pause`, { method: 'POST' });
    paused = true;
    renderPlayScreen();
  } catch (err) {
    showPlayError(friendlyError(err));
  }
}

async function resumeGame() {
  hideError('play-error');
  try {
    await api(`/api/games/${currentGame.id}/resume`, { method: 'POST' });
    paused = false;
    renderPlayScreen();
  } catch (err) {
    showPlayError(friendlyError(err));
  }
}

async function viewScore() {
  if (!currentGame) return;
  hideError('play-error');
  try {
    const result = await api(`/api/games/${currentGame.id}/score`, { method: 'GET' });
    showScreen('screen-score');
    byId('final-score').textContent = result.score;
    byId('ending-feedback').textContent = endingFeedback(result.score);
  } catch (err) {
    showPlayError(friendlyError(err));
  }
}

function endingFeedback(score) {
  if (score >= 8) return 'Outstanding! You are a fraction ace. 🚀';
  if (score >= 5) return 'Great work, cadet! Keep practicing.';
  return 'Good effort — review reduced fractions and try again.';
}

function playAgain() {
  startGame();
}

function toggleHelp() {
  const panel = document.querySelector('#screen-intro .help-panel');
  if (panel) panel.hidden = !panel.hidden;
}

/* ------------------------------------------------------------------------- */
/* Admin question CRUD                                                        */
/* ------------------------------------------------------------------------- */
async function loadAdminQuestions() {
  hideError('admin-error');
  try {
    const result = await api('/api/admin/questions', { method: 'GET' });
    const list = byId('admin-list');
    list.innerHTML = '';
    (result.questions || []).forEach((q) => {
      const li = document.createElement('li');
      li.textContent = `${q.id}: ${q.prompt} (answer: ${q.correctAnswer})`;
      const del = document.createElement('button');
      del.className = 'btn btn--ghost';
      del.textContent = 'Delete';
      del.type = 'button';
      del.addEventListener('click', () => deleteQuestion(q.id));
      li.appendChild(del);
      list.appendChild(li);
    });
  } catch (err) {
    showAdminError(friendlyError(err));
  }
}

async function createQuestion(ev) {
  ev.preventDefault();
  hideError('admin-error');
  const prompt = byId('admin-prompt').value.trim();
  const correctAnswer = byId('admin-correct').value.trim();
  const options = byId('admin-options').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!prompt || !correctAnswer || options.length === 0) {
    showAdminError('Prompt, options, and correct answer are required.');
    return;
  }

  try {
    await api('/api/admin/questions', {
      method: 'POST',
      body: { prompt, options, correctAnswer },
    });
    byId('admin-feedback').textContent = 'Question created.';
    ev.target.reset();
    loadAdminQuestions();
  } catch (err) {
    showAdminError(friendlyError(err));
  }
}

async function deleteQuestion(id) {
  hideError('admin-error');
  try {
    await api(`/api/admin/questions/${id}`, { method: 'DELETE' });
    loadAdminQuestions();
  } catch (err) {
    showAdminError(friendlyError(err));
  }
}

/* ------------------------------------------------------------------------- */
/* Small error helpers                                                        */
/* ------------------------------------------------------------------------- */
function hideError(id) {
  const el = byId(id);
  if (el) el.hidden = true;
}

function showIntroError(message) {
  const el = byId('intro-error');
  if (el) {
    el.hidden = false;
    el.textContent = message;
  }
}

function showPlayError(message) {
  const el = byId('play-error');
  if (el) {
    el.hidden = false;
    el.textContent = message;
  }
}

function showAdminError(message) {
  const el = byId('admin-error');
  if (el) {
    el.hidden = false;
    el.textContent = message;
  }
}

/* ------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* ------------------------------------------------------------------------- */
function wire() {
  byId('start-game-btn').addEventListener('click', () => startGame().catch(() => {}));
  byId('answer-form').addEventListener('submit', (ev) => submitAnswer(ev).catch(() => {}));
  byId('pause-btn').addEventListener('click', () => pauseGame().catch(() => {}));
  byId('resume-btn').addEventListener('click', () => resumeGame().catch(() => {}));
  byId('view-score-btn').addEventListener('click', () => viewScore().catch(() => {}));
  byId('end-game-btn').addEventListener('click', () => viewScore().catch(() => {}));
  byId('play-again-btn').addEventListener('click', () => playAgain().catch(() => {}));
  byId('help-btn').addEventListener('click', toggleHelp);
  byId('admin-form').addEventListener('submit', (ev) => createQuestion(ev).catch(() => {}));
}

/* Bootstrap: handle a possible OIDC redirect first, then render. */
(async function init() {
  wire();
  await handleRedirect();
  // If handleRedirect already called boot() (after code exchange), avoid double init.
  if (!window.location.search.includes('code=')) {
    boot();
  }
})();