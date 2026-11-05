/**
 * api.js – thin API client for the Space Fractions gateway.
 *
 * All requests go to the single gateway entrypoint (port 3000) using
 * relative paths, so the UI works identically behind any reverse proxy.
 * The Bearer access token is read from sessionStorage on every request.
 *
 * Authentication uses the OIDC Authorization Code flow with PKCE (S256) for
 * a *public* browser client. No client secret ever appears in this file;
 * the secret (if any) lives server-side. See login() / handleAuthCallback().
 *
 * No correct answers are ever requested from (or surfaced by) the player
 * API; the UI only ever receives { id, prompt, options } per question.
 */

const TOKEN_KEY = 'spacefractions.token';
const OIDC_PKCE_STATE_KEY = 'spacefractions.oidc.state';
const OIDC_PKCE_VERIFIER_KEY = 'spacefractions.oidc.verifier';

/* ------------------------------------------------------------------ *
 * Low-level helpers (base64url, PKCE)
 * ------------------------------------------------------------------ */

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytesLength = 32) {
  const arr = new Uint8Array(bytesLength);
  crypto.getRandomValues(arr);
  return bytesToBase64Url(arr);
}

async function generatePkcePair() {
  const codeVerifier = randomString(32);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = bytesToBase64Url(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

/* ------------------------------------------------------------------ *
 * OIDC configuration (public, non-secret — served by the gateway)
 * ------------------------------------------------------------------ */

let oidcConfig = null;

/**
 * Fetch the public OIDC configuration (issuer, client id, audience). The
 * gateway only exposes non-secret values; a client secret is never present.
 */
async function loadOidcConfig() {
  if (oidcConfig) return oidcConfig;
  try {
    const resp = await fetch('/api/oidc/config');
    if (!resp.ok) return null;
    const cfg = await resp.json();
    if (cfg && cfg.issuer && cfg.clientId) {
      oidcConfig = cfg;
      return cfg;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Fallback local dev defaults (Non-production; see README). */
function defaultOidcConfig() {
  return {
    issuer: 'http://localhost:8080/realms/space-fractions',
    clientId: 'space-fractions-client',
    audience: 'account'
  };
}

async function getOidcConfig() {
  return (await loadOidcConfig()) || defaultOidcConfig();
}

/* ------------------------------------------------------------------ *
 * Token helpers
 * ------------------------------------------------------------------ */

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || null;
}

function setToken(token) {
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

function hasToken() {
  return Boolean(getToken());
}

/**
 * Decode a JWT payload (unverified) only to surface the subject/roles
 * in the UI. Never used for authorization decisions server-side.
 */
function decodeTokenPayload(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '==='.slice(0, (4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function currentClaims() {
  return decodeTokenPayload(getToken());
}

function isAdmin() {
  const claims = currentClaims();
  const roles = claims?.realm_access?.roles || [];
  return roles.includes('admin');
}

function currentSubject() {
  const claims = currentClaims();
  return claims?.sub || null;
}

function preferredName() {
  const claims = currentClaims();
  return claims?.preferred_username || claims?.email || claims?.name || null;
}

/* ------------------------------------------------------------------ *
 * OIDC login / logout (Authorization Code + PKCE S256)
 * ------------------------------------------------------------------ */

/**
 * Redirect to the OIDC provider's authorization endpoint with a fresh PKCE
 * code_verifier/challenge. Control returns to this page with a `code` query
 * parameter, which handleAuthCallback() exchanges for tokens.
 */
async function login() {
  const cfg = await getOidcConfig();
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = randomString(16);
  const redirectUri = window.location.origin + '/';

  sessionStorage.setItem(OIDC_PKCE_VERIFIER_KEY, codeVerifier);
  sessionStorage.setItem(OIDC_PKCE_STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email roles',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });

  window.location.assign(
    `${cfg.issuer.replace(/\/$/, '')}/protocol/openid-connect/auth?${params.toString()}`
  );
}

/**
 * Exchange an authorization `code` for tokens against the provider's token
 * endpoint, verifying the `state` round-trip. On success stores the access
 * token and cleans the URL. Returns true when a code was consumed.
 */
async function handleAuthCallback() {
  const query = new URLSearchParams(window.location.search);
  const code = query.get('code');
  if (!code) return false;

  const error = query.get('error');
  if (error) {
    throw new Error(`Login failed: ${error}${query.get('error_description') ? ' – ' + query.get('error_description') : ''}`);
  }

  const state = query.get('state');
  const savedState = sessionStorage.getItem(OIDC_PKCE_STATE_KEY);
  if (state !== savedState) {
    throw new Error('Login state mismatch — please try again.');
  }

  const codeVerifier = sessionStorage.getItem(OIDC_PKCE_VERIFIER_KEY);
  if (!codeVerifier) {
    throw new Error('Missing PKCE verifier — please sign in again.');
  }

  const cfg = await getOidcConfig();
  const redirectUri = window.location.origin + '/';

  const tokenResp = await fetch(
    `${cfg.issuer.replace(/\/$/, '')}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: cfg.clientId,
        code_verifier: codeVerifier
      }).toString()
    }
  );

  const data = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Token exchange failed.');
  }

  setToken(data.access_token);
  sessionStorage.removeItem(OIDC_PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OIDC_PKCE_STATE_KEY);
  window.history.replaceState({}, '', '/');
  return true;
}

/**
 * Clear local session and redirect to the provider's end-session endpoint.
 */
async function logout() {
  const cfg = await getOidcConfig();
  setToken(null);
  const postLogout = window.location.origin + '/';
  window.location.assign(
    `${cfg.issuer.replace(/\/$/, '')}/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(postLogout)}`
  );
}

/* ------------------------------------------------------------------ *
 * Request helper
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

/**
 * Core fetch wrapper. Adds JSON + Authorization headers, parses JSON,
 * and throws a typed ApiError with the server's code/message if present.
 */
async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const resp = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  let data = null;
  if (resp.status !== 204) {
    const text = await resp.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
  }

  if (!resp.ok) {
    const err = data && (data.error || data.message)
      ? { code: data.code || data.error, message: data.message || data.error }
      : null;
    throw new ApiError(
      resp.status,
      err ? err.code : undefined,
      err ? err.message : `Request failed with status ${resp.status}`
    );
  }

  return data;
}

/* ------------------------------------------------------------------ *
 * Game endpoints
 * ------------------------------------------------------------------ */

/**
 * Create a new game. Optionally pass { questionIds: [id, ...] } for
 * reproducible practice. Returns the 201 body (id, state, questions).
 */
function createGame(questionIds) {
  const body = {};
  if (Array.isArray(questionIds) && questionIds.length > 0) {
    body.questionIds = questionIds;
  }
  return request('/api/games', { method: 'POST', body });
}

function getGame(id) {
  return request(`/api/games/${id}`);
}

function pauseGame(id) {
  return request(`/api/games/${id}/pause`, { method: 'POST', body: {} });
}

function resumeGame(id) {
  return request(`/api/games/${id}/resume`, { method: 'POST', body: {} });
}

function submitAnswer(gameId, questionId, answer) {
  return request(`/api/games/${gameId}/answers`, {
    method: 'POST',
    body: { questionId, answer }
  });
}

function getScore(id) {
  return request(`/api/games/${id}/score`);
}

/* ------------------------------------------------------------------ *
 * Question endpoints (public) – no correct answers exposed
 * ------------------------------------------------------------------ */

function listQuestions(ids) {
  let qs = '';
  if (Array.isArray(ids) && ids.length > 0) {
    qs = `?ids=${ids.join(',')}`;
  }
  return request(`/api/questions${qs}`);
}

/* ------------------------------------------------------------------ *
 * User endpoints
 * ------------------------------------------------------------------ */

function getMe() {
  return request('/api/users/me');
}

/* ------------------------------------------------------------------ *
 * Admin endpoints (require admin role)
 * ------------------------------------------------------------------ */

function listAdminQuestions() {
  return request('/api/admin/questions');
}

function createAdminQuestion(payload) {
  return request('/api/admin/questions', { method: 'POST', body: payload });
}

function deleteAdminQuestion(id) {
  return request(`/api/admin/questions/${id}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------ *
 * Meta
 * ------------------------------------------------------------------ */

function getHealth() {
  return request('/health');
}

window.SpaceFracApi = {
  TOKEN_KEY,
  getToken,
  setToken,
  hasToken,
  currentClaims,
  isAdmin,
  currentSubject,
  preferredName,
  loadOidcConfig,
  getOidcConfig,
  login,
  logout,
  handleAuthCallback,
  ApiError,
  createGame,
  getGame,
  pauseGame,
  resumeGame,
  submitAnswer,
  getScore,
  listQuestions,
  getMe,
  listAdminQuestions,
  createAdminQuestion,
  deleteAdminQuestion,
  getHealth
};