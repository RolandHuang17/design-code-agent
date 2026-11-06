'use strict';

/**
 * Space Fractions browser UI (plain JS, no bundler).
 *
 * The gateway serves this file as a static asset. All API calls go through the
 * same origin (the gateway) and carry the OIDC access token in a Bearer
 * header. The token is obtained via the authorization-code + PKCE (S256) flow
 * documented below. Player responses never expose `correctAnswer` — the UI
 * only reads `correct` (boolean) and `score` (integer).
 *
 * Views are simple <section> elements toggled by a `show(view)` helper; the
 * game state (id/questions/index/score/paused) is kept in `game`.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // OIDC configuration (derived from gateway env via a small /config.json
  // if present, otherwise sensible local-only defaults). Real deployments
  // set PUBLIC_ORIGIN and OIDC_ISSUER; the gateway exposes these to the
  // browser through a static config file so redirects never hard-code a
  // host:port (test runtimes remap ports).
  // ---------------------------------------------------------------------
  const CONFIG = window.SPACE_FRACTIONS_CONFIG || {};

  const ISSUER = CONFIG.issuer || 'http://localhost:8080/realms/space-fractions';
  const CLIENT_ID = CONFIG.clientId || 'space-fractions-client';
  const REDIRECT_URI =
    CONFIG.redirectUri || `${window.location.origin}/`;
  const SCOPE = CONFIG.scope || 'openid profile';

  // Token storage. `accessToken` is acquired at sign-in via PKCE.
  let accessToken = sessionStorage.getItem('space-fractions.access_token') || null;
  let idToken = sessionStorage.getItem('space-fractions.id_token') || null;
  let profile = null;

  // Active game state (never includes correctAnswer).
  let game = {
    id: null,
    questions: [],
    current: 0,
    score: 0,
    paused: false,
    answered: new Set(), // question ids already answered
  };

  // ---------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);

  function show(viewId) {
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== viewId));
  }

  function setAuthUI() {
    const loggedIn = !!accessToken && !!profile;
    $('#login-btn').hidden = loggedIn;
    $('#logout-btn').hidden = !loggedIn;
    $('#user-name').hidden = !loggedIn;
    if (loggedIn && profile) {
      $('#user-name').textContent = profile.preferred_username || profile.name || profile.sub || 'user';
    }
  }

  function clearFeedback() {
    const fb = $('#answer-feedback');
    fb.hidden = true;
    fb.textContent = '';
  }

  function setFeedback(text, ok) {
    const fb = $('#answer-feedback');
    fb.hidden = false;
    fb.textContent = text;
    fb.className = `feedback ${ok ? 'correct' : 'incorrect'}`;
  }

  // ---------------------------------------------------------------------
  // Auth: authorization-code + PKCE (S256)
  // ---------------------------------------------------------------------
  function base64url(buf) {
    if (typeof buf === 'string') buf = new TextEncoder().encode(buf);
    let str = '';
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomString(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return base64url(arr);
  }

  async function sha256(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  }

  async function buildAuthorizeUrl() {
    const verifier = randomString(64);
    const challenge = base64url(await sha256(verifier));
    sessionStorage.setItem('space-fractions.pkce_verifier', verifier);
    const state = randomString(32);
    sessionStorage.setItem('space-fractions.oauth_state', state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${ISSUER.replace(/\/$/, '')}/protocol/openid-connect/auth?${params.toString()}`;
  }

  function decodeJwtPayload(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  async function exchangeCode(code) {
    const verifier = sessionStorage.getItem('space-fractions.pkce_verifier');
    const tokenUrl = `${ISSUER.replace(/\/$/, '')}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('token exchange failed');
    const data = await res.json();
    accessToken = data.access_token;
    idToken = data.id_token || null;
    sessionStorage.setItem('space-fractions.access_token', accessToken);
    if (idToken) sessionStorage.setItem('space-fractions.id_token', idToken);
    profile = idToken ? decodeJwtPayload(idToken) : (accessToken ? decodeJwtPayload(accessToken) : null);
  }

  async function handleRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const storedState = sessionStorage.getItem('space-fractions.oauth_state');
    if (!code) return false;
    if (!storedState || state !== storedState) {
      console.error('OAuth state mismatch');
      return false;
    }
    await exchangeCode(code);
    sessionStorage.removeItem('space-fractions.pkce_verifier');
    sessionStorage.removeItem('space-fractions.oauth_state');
    window.history.replaceState({}, document.title, REDIRECT_URI);
    setAuthUI();
    return true;
  }

  async function signIn() {
    window.location.assign(await buildAuthorizeUrl());
  }

  function signOut() {
    accessToken = null;
    idToken = null;
    profile = null;
    sessionStorage.removeItem('space-fractions.access_token');
    sessionStorage.removeItem('space-fractions.id_token');
    resetGame();
    show('view-intro');
    setAuthUI();
  }

  // ---------------------------------------------------------------------
  // API helper (adds Bearer token; maps status to typed errors)
  // ---------------------------------------------------------------------
  async function api(method, url, body) {
    const headers = { accept: 'application/json' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const err = new Error(data && data.error ? data.error : `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function handleApiError(err) {
    if (err.status === 401) {
      setFeedback('Please sign in to continue.', false);
      show('view-intro');
      setAuthUI();
      return;
    }
    setFeedback(err.message || 'Something went wrong.', false);
  }

  // ---------------------------------------------------------------------
  // Game flow
  // ---------------------------------------------------------------------
  function resetGame() {
    game = {
      id: null,
      questions: [],
      current: 0,
      score: 0,
      paused: false,
      answered: new Set(),
    };
    clearFeedback();
  }

  async function startGame() {
    if (!accessToken) {
      await signIn();
      return;
    }
    resetGame();
    try {
      const created = await api('POST', '/api/games', {});
      game.id = created.id;
      game.questions = created.questions || [];
      game.score = 0;
      game.current = 0;
      sessionStorage.setItem('space-fractions.game_id', String(created.id));
      if (game.questions.length === 0) {
        setFeedback('No questions available yet.', false);
        show('view-menu');
        return;
      }
      renderQuestion();
      show('view-play');
    } catch (err) {
      handleApiError(err);
    }
  }

  function renderQuestion() {
    const q = game.questions[game.current];
    if (!q) return;
    $('#question-index').textContent = String(game.current + 1);
    $('#question-prompt').textContent = q.prompt;
    const optionsEl = $('#question-options');
    optionsEl.innerHTML = '';
    (q.options || []).forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        $('#answer-input').value = opt;
      });
      optionsEl.appendChild(btn);
    });
    $('#answer-input').value = '';
    clearFeedback();
    updateScoreDisplay();
  }

  function updateScoreDisplay() {
    $('#score-value').textContent = String(game.score);
  }

  async function submitAnswer(answer) {
    if (!game.id) return;
    const q = game.questions[game.current];
    if (!q) return;
    try {
      const result = await api('POST', `/api/games/${game.id}/answers`, {
        questionId: q.id,
        answer,
      });
      if (result.correct) {
        // Only count one point; the server dedupes repeats.
        game.score = result.score;
      } else {
        game.score = result.score;
      }
      game.answered.add(q.id);
      updateScoreDisplay();
      if (result.correct) {
        setFeedback('Correct! +1', true);
      } else {
        setFeedback('Not quite. Try the next question.', false);
      }
      // Move to next question (or finish).
      if (game.current + 1 < game.questions.length) {
        game.current += 1;
        renderQuestion();
      } else {
        await finishGame();
      }
    } catch (err) {
      if (err.status === 409) {
        setFeedback('You already answered that question.', false);
      } else {
        handleApiError(err);
      }
    }
  }

  async function pauseGame() {
    if (!game.id) return;
    try {
      await api('POST', `/api/games/${game.id}/pause`, {});
      game.paused = true;
      show('view-paused');
    } catch (err) {
      handleApiError(err);
    }
  }

  async function resumeGame() {
    if (!game.id) return;
    try {
      await api('POST', `/api/games/${game.id}/resume`, {});
      game.paused = false;
      show('view-play');
    } catch (err) {
      if (err.status === 409) {
        setFeedback('Game is already resumed.', false);
        game.paused = false;
        show('view-play');
      } else {
        handleApiError(err);
      }
    }
  }

  async function finishGame() {
    try {
      const scoreRes = await api('GET', `/api/games/${game.id}/score`);
      game.score = scoreRes.score;
      $('#ending-text').textContent =
        `You answered all ${game.questions.length} question(s). Final score: ${game.score}.`;
      show('view-ending');
    } catch (err) {
      handleApiError(err);
    }
  }

  async function viewScore() {
    // After a full page reload the in-memory `game` is empty; recover the
    // authenticated user's most recent game from the server so the score is
    // the real persisted value, not a client-side guess.
    if (!game.id) {
      const recovered = await recoverGame();
      if (!recovered) return;
    }
    try {
      const scoreRes = await api('GET', `/api/games/${game.id}/score`);
      game.score = scoreRes.score;
      $('#final-score').textContent = String(scoreRes.score);
      show('view-score');
    } catch (err) {
      handleApiError(err);
    }
  }

  /**
   * Rebuild the active game from server-side persisted state after a reload.
   * Prefers the game id remembered in sessionStorage, but falls back to the
   * user's most recent game via GET /api/games so a reload never leaves the
   * user stranded on the Main Menu.
   *
   * @returns {Promise<boolean>} true if a game was recovered
   */
  async function recoverGame() {
    if (!accessToken) return false;
    try {
      const storedId = sessionStorage.getItem('space-fractions.game_id');
      let recovered = null;
      if (storedId) {
        try {
          recovered = await api('GET', `/api/games/${storedId}`);
        } catch (err) {
          // Stale id (e.g. game finished/deleted) -> fall through to list.
          recovered = null;
        }
      }
      if (!recovered) {
        const data = await api('GET', '/api/games');
        const games = (data && data.games) || [];
        if (games.length === 0) {
          show('view-menu');
          return false;
        }
        // Most recent game first (server orders by id DESC).
        recovered = games[0];
      }
      game.id = recovered.id;
      game.questions = recovered.questions || [];
      game.score = typeof recovered.score === 'number' ? recovered.score : 0;
      game.current = 0;
      game.answered = new Set();
      sessionStorage.setItem('space-fractions.game_id', String(recovered.id));
      updateScoreDisplay();
      return true;
    } catch (err) {
      handleApiError(err);
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Admin question CRUD (only shown to admins; server enforces 403)
  // ---------------------------------------------------------------------
  async function isAdmin() {
    if (!accessToken) return false;
    // Roles may be present on the access token payload (resource_access or
    // realm_access) or on the id_token profile. Try each location in turn.
    const sources = [];
    if (profile && profile.realm_access && Array.isArray(profile.realm_access.roles)) {
      sources.push(profile.realm_access.roles);
    }
    if (profile && profile.resource_access) {
      const ra = profile.resource_access[CLIENT_ID];
      if (ra && Array.isArray(ra.roles)) sources.push(ra.roles);
    }
    const accessPayload = accessToken ? decodeJwtPayload(accessToken) : null;
    if (accessPayload && accessPayload.realm_access && Array.isArray(accessPayload.realm_access.roles)) {
      sources.push(accessPayload.realm_access.roles);
    }
    if (accessPayload && accessPayload.resource_access) {
      const ra = accessPayload.resource_access[CLIENT_ID];
      if (ra && Array.isArray(ra.roles)) sources.push(ra.roles);
    }
    return sources.some((roles) => roles.includes('admin'));
  }

  function setAdminFeedback(text, ok) {
    const fb = $('#admin-feedback');
    fb.hidden = false;
    fb.textContent = text;
    fb.className = `feedback ${ok ? 'correct' : 'incorrect'}`;
  }

  async function renderAdmin() {
    const adminBtn = $('#menu-admin-btn');
    const admin = await isAdmin();
    if (adminBtn) adminBtn.hidden = !admin;
    if (admin) await listQuestions();
  }

  async function listQuestions() {
    const listEl = $('#admin-question-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    try {
      const data = await api('GET', '/api/admin/questions');
      const questions = (data && data.questions) || [];
      if (questions.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No questions yet.';
        li.className = 'q-text';
        listEl.appendChild(li);
        return;
      }
      questions.forEach((q) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.className = 'q-text';
        span.textContent = q.prompt;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn';
        del.textContent = 'Delete';
        del.addEventListener('click', () => deleteQuestion(q.id));
        li.appendChild(span);
        li.appendChild(del);
        listEl.appendChild(li);
      });
    } catch (err) {
      setAdminFeedback(err.message || 'Failed to load questions.', false);
    }
  }

  async function createQuestion(prompt, options, correctAnswer) {
    const data = await api('POST', '/api/admin/questions', { prompt, options, correctAnswer });
    setAdminFeedback(`Created question "${data.prompt}".`, true);
    await listQuestions();
  }

  async function deleteQuestion(id) {
    await api('DELETE', `/api/admin/questions/${id}`);
    setAdminFeedback('Question deleted.', true);
    await listQuestions();
  }

  function handleAdminCreateForm(e) {
    e.preventDefault();
    const prompt = $('#admin-prompt').value.trim();
    const optionsRaw = $('#admin-options').value.trim();
    const correctAnswer = $('#admin-correct').value.trim();
    if (!prompt || !correctAnswer) {
      setAdminFeedback('Prompt and correct answer are required.', false);
      return;
    }
    const options = optionsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    createQuestion(prompt, options, correctAnswer).catch((err) => {
      setAdminFeedback(err.message || 'Failed to create question.', false);
    });
    // Reset the form but keep the question list visible.
    $('#admin-prompt').value = '';
    $('#admin-options').value = '';
    $('#admin-correct').value = '';
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------
  function bindEvents() {
    $('#login-btn').addEventListener('click', signIn);
    $('#logout-btn').addEventListener('click', signOut);

    $('#start-btn').addEventListener('click', startGame);
    $('#menu-play-btn').addEventListener('click', startGame);
    $('#menu-score-btn').addEventListener('click', viewScore);
    $('#menu-help-btn').addEventListener('click', () => show('view-help'));
    $('#menu-admin-btn').addEventListener('click', () => show('view-admin'));

    $('#admin-create-form').addEventListener('submit', handleAdminCreateForm);
    $('#admin-list-btn').addEventListener('click', listQuestions);

    $('#answer-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = $('#answer-input').value.trim();
      if (!val) return;
      submitAnswer(val);
    });

    $('#pause-btn').addEventListener('click', pauseGame);
    $('#resume-btn').addEventListener('click', resumeGame);
    $('#paused-resume-btn').addEventListener('click', resumeGame);

    $('#ending-menu-btn').addEventListener('click', () => show('view-menu'));
    $('#score-menu-btn').addEventListener('click', () => show('view-menu'));
    $('#help-menu-btn').addEventListener('click', () => show('view-menu'));
  }

  async function init() {
    bindEvents();
    setAuthUI();
    // Try to load a fresh profile if a token already exists but profile is null.
    if (accessToken && !profile) {
      profile = idToken ? decodeJwtPayload(idToken) : decodeJwtPayload(accessToken);
    }
    const handled = await handleRedirect();
    if (!handled) {
      // Restore session from storage if present (no redirect to process).
      if (accessToken) {
        show('view-menu');
      } else {
        show('view-intro');
      }
    }
    setAuthUI();
    if (accessToken) {
      await renderAdmin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();