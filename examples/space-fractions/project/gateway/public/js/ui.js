/**
 * ui.js – DOM rendering and small helper utilities.
 *
 * This layer is responsible for building HTML strings and wiring simple
 * display concerns. State transitions live in app.js, which calls into
 * these render functions. No network or auth logic lives here.
 */

const Fragment = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content;
};

function clearView() {
  const view = document.getElementById('view');
  view.replaceChildren();
  return view;
}

function appendHtml(parent, html) {
  parent.appendChild(Fragment(html));
}

function el(id) {
  return document.getElementById(id);
}

/**
 * Escape user-controlled strings before injecting into HTML to prevent
 * stored-XSS via question prompts/options.
 */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ *
 * View renderers
 * ------------------------------------------------------------------ */

function renderIntroduction() {
  const view = clearView();
  view.innerHTML = `
    <div class="intro-phase">
      <div class="intro-planet" aria-hidden="true">&#127756;</div>
      <h1>Welcome, Fraction Explorer!</h1>
      <p class="muted">
        Journey through the galaxy and master fractions. Solve the puzzles,
        earn points, and become a Space Fractions champion.
      </p>
      <div class="row center" style="justify-content:center; margin-top: 20px;">
        <button class="btn btn-primary" data-action="menu">Let's go &rarr;</button>
      </div>
    </div>`;
  return view;
}

function renderMenu({ isAdmin }) {
  const view = clearView();
  view.innerHTML = `
    <div class="card center">
      <h1>Main Menu</h1>
      <ul class="menu-list">
        <li><button class="btn" data-action="play">Play</button></li>
        <li><button class="btn" data-action="score">View Score</button></li>
        <li><button class="btn" data-action="help">Help</button></li>
        ${isAdmin ? '<li><button class="btn" data-action="admin">Manage Questions</button></li>' : ''}
      </ul>
    </div>`;
  return view;
}

function renderPlayGame(game, currentQuestion, progress) {
  const view = clearView();
  const { question, index, total } = progress;

  if (!question) {
    view.innerHTML = `
      <div class="card center">
        <h2>No questions available</h2>
        <p class="muted">There are no more questions to answer.</p>
        <button class="btn btn-primary" data-action="menu">Back to menu</button>
      </div>`;
    return view;
  }

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content: space-between;">
        <h3>Question ${index + 1} of ${total}</h3>
        <button class="btn btn-ghost" data-action="pause">Pause</button>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${Math.round(((index) / total) * 100)}%;"></div>
      </div>
      <p class="prompt">${esc(question.prompt)}</p>
      <div class="options" id="options-container">
        ${question.options.map((opt, i) => `
          <div class="option" data-option-index="${i}">
            <span class="muted">${String.fromCharCode(65 + i)}</span>
            <span>${esc(opt)}</span>
          </div>
        `).join('')}
      </div>
      <div class="stack" style="margin-top: 16px;">
        <input type="text" class="answer-input" id="answer-input"
               placeholder="Type a fraction, e.g. 1/2" autocomplete="off" />
        <div class="row">
          <button class="btn btn-primary" id="btn-submit" data-action="submit" disabled>Submit</button>
        </div>
      </div>
      <div id="feedback" class="feedback" hidden></div>
    </div>`;
  return view;
}

function renderPaused(game) {
  const view = clearView();
  view.innerHTML = `
    <div class="card center">
      <h2>Game paused</h2>
      <p class="muted">Take a breather, explorer. Your progress is safe.</p>
      <div class="row center" style="justify-content:center;">
        <button class="btn btn-primary" data-action="resume">Resume</button>
        <button class="btn btn-ghost" data-action="menu">Back to menu</button>
      </div>
    </div>`;
  return view;
}

function renderScoreView(score, total) {
  const view = clearView();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const stars = total > 0 ? Math.max(1, Math.round((score / total) * 5)) : 0;
  view.innerHTML = `
    <div class="card center">
      <h1>Your Score</h1>
      <div class="score-stars">${'&#9733;'.repeat(stars)}</div>
      <div class="score-big">${score}</div>
      <p class="muted">out of ${total} question${total === 1 ? '' : 's'} (${pct}%)</p>
      <div class="row center" style="justify-content:center;">
        <button class="btn btn-primary" data-action="menu">Back to menu</button>
      </div>
    </div>`;
  return view;
}

function renderEndingFeedback(score, total) {
  const view = clearView();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  let message = 'You made it through the galaxy!';
  if (pct === 100) message = 'Perfect! You are a true Fraction Master!';
  else if (pct >= 75) message = 'Excellent work, explorer!';
  else if (pct >= 50) message = 'Good effort! Keep practicing.';
  else message = 'Keep exploring — fractions take practice!';

  view.innerHTML = `
    <div class="card center">
      <div class="intro-planet" aria-hidden="true">&#127756;</div>
      <h1>Mission Complete</h1>
      <p class="muted">${esc(message)}</p>
      <div class="score-big">${score}</div>
      <p class="muted">correct out of ${total}</p>
      <div class="row center" style="justify-content:center;">
        <button class="btn btn-primary" data-action="play">Play again</button>
        <button class="btn btn-ghost" data-action="menu">Main menu</button>
      </div>
    </div>`;
  return view;
}

function renderHelp() {
  const view = clearView();
  view.innerHTML = `
    <div class="card">
      <h1>Help</h1>
      <ul class="help-list">
        <li><strong>Play</strong>: start a new game and answer fraction questions.</li>
        <li><strong>Answer format</strong>: write fractions like <code>1/2</code>. Whole numbers <code>1</code> are allowed too.</li>
        <li><strong>Pause / Resume</strong>: pause any time and resume without losing progress.</li>
        <li><strong>Score</strong>: each correct answer earns 1 point. Re-answering won't re-award points.</li>
        <li><strong>Ending feedback</strong>: after the last question you'll see your final result.</li>
      </ul>
      <div class="row">
        <button class="btn btn-primary" data-action="menu">Back to menu</button>
      </div>
    </div>`;
  return view;
}

function renderAdmin(questions) {
  const view = clearView();
  const rows = questions.map((q) => `
    <tr>
      <td>${q.id}</td>
      <td>${esc(q.prompt)}</td>
      <td>${esc((q.options || []).join(', '))}</td>
      <td><code>${esc(q.correctAnswer || '')}</code></td>
      <td><button class="btn btn-danger-outline" data-delete-id="${q.id}">Delete</button></td>
    </tr>`).join('');

  view.innerHTML = `
    <div class="card">
      <h1>Manage Questions</h1>
      <form class="admin-form" id="admin-create-form">
        <label for="admin-prompt">Prompt</label>
        <input type="text" id="admin-prompt" placeholder="e.g. What is 1/2 + 1/4?" required />

        <label for="admin-options">Options (comma-separated)</label>
        <input type="text" id="admin-options" placeholder="e.g. 3/4, 1/4, 1/2, 2/3" required />

        <label for="admin-correct">Correct answer (must be one of the options)</label>
        <input type="text" id="admin-correct" placeholder="e.g. 3/4" required />

        <div class="row">
          <button type="submit" class="btn btn-primary">Create question</button>
        </div>
      </form>
      <div id="admin-feedback"></div>
    </div>
    <div class="card" style="margin-top: 16px;">
      <h2>Existing questions</h2>
      <table class="admin-table">
        <thead>
          <tr><th>ID</th><th>Prompt</th><th>Options</th><th>Correct</th><th></th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No questions yet</td></tr>'}</tbody>
      </table>
    </div>`;
  return view;
}

/* ------------------------------------------------------------------ *
 * Feedback helpers
 * ------------------------------------------------------------------ */

function showFeedback(correct, message, score) {
  const fb = el('feedback');
  if (!fb) return;
  fb.hidden = false;
  fb.className = `feedback ${correct ? 'correct' : 'incorrect'}`;
  fb.textContent = `${message} (score: ${score})`;
}

function showErrorBanner(message) {
  const view = el('view');
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = message;
  view.prepend(banner);
}

function setSessionStatus(authed, username) {
  const status = el('session-status');
  if (!status) return;
  if (authed) {
    status.className = 'session-status on';
    status.textContent = username ? `Signed in as ${username}` : 'Signed in';
  } else {
    status.className = 'session-status off';
    status.textContent = 'Signed out';
  }
}

/* ------------------------------------------------------------------ *
 * Modal helpers
 * ------------------------------------------------------------------ */

function openModal(id) {
  el(id).hidden = false;
}

function closeModal(id) {
  el(id).hidden = true;
}

window.SpaceFracUi = {
  Fragment,
  clearView,
  appendHtml,
  el,
  esc,
  renderIntroduction,
  renderMenu,
  renderPlayGame,
  renderPaused,
  renderScoreView,
  renderEndingFeedback,
  renderHelp,
  renderAdmin,
  showFeedback,
  showErrorBanner,
  setSessionStatus,
  openModal,
  closeModal
};