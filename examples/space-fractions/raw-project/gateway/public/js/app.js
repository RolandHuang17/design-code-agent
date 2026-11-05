/**
 * app.js – application controller.
 *
 * Owns the single-page state machine: introduction -> menu -> play/pause/
 * score/admin views, and wires DOM events to the SpaceFracApi + SpaceFracUi
 * layers. The entire UI runs client-side against the gateway (port 3000).
 */

(function () {
  const Api = window.SpaceFracApi;
  const Ui = window.SpaceFracUi;

  // Current in-memory game context.
  const state = {
    game: null,           // last fetched game (id, state, questions, ...)
    score: 0,
    totalQuestions: 0
  };

  /* ------------------------------------------------------------------ *
   * Navigation
   * ------------------------------------------------------------------ */

  async function showIntroduction() {
    Ui.renderIntroduction();
  }

  async function showMenu() {
    Ui.renderMenu({ isAdmin: Api.isAdmin() });
  }

  async function showHelp() {
    Ui.renderHelp();
  }

  function showPaused() {
    Ui.renderPaused(state.game);
  }

  /* ------------------------------------------------------------------ *
   * Game actions
   * ------------------------------------------------------------------ */

  async function startGame() {
    // Require authentication before creating a game (POST /api/games needs
    // a Bearer token; server returns 401 otherwise).
    if (!Api.hasToken()) {
      Ui.showErrorBanner('Please sign in first to play.');
      await Api.login();
      return;
    }

    try {
      const game = await Api.createGame();
      state.game = game;
      state.totalQuestions = game.questions.length;
      await loadCurrentQuestion();
    } catch (err) {
      handleError(err);
    }
  }

  async function loadCurrentQuestion() {
    const game = state.game;
    if (!game) return showMenu();

    if (game.state === 'completed') {
      return showEnding();
    }
    if (game.state === 'paused') {
      return showPaused();
    }

    const idx = game.currentQuestionIndex ?? 0;
    const total = game.questions.length;
    const question = game.questions[idx] || null;

    if (!question) {
      return showEnding();
    }

    Ui.renderPlayGame(game, question, {
      question,
      index: idx,
      total
    });

    wirePlayControls(question);
  }

  function wirePlayControls(question) {
    const options = document.querySelectorAll('.option');
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        options.forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        const answer = question.options[Number(opt.dataset.optionIndex)];
        document.getElementById('answer-input').value = answer;
        document.getElementById('btn-submit').disabled = false;
      });
    });

    const input = document.getElementById('answer-input');
    if (input) {
      input.addEventListener('input', () => {
        const submitBtn = document.getElementById('btn-submit');
        if (submitBtn) submitBtn.disabled = input.value.trim() === '';
      });
    }

    const submitBtn = document.getElementById('btn-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => submitCurrentAnswer(question));
    }
  }

  async function submitCurrentAnswer(question) {
    const input = document.getElementById('answer-input');
    if (!input) return;
    const answer = input.value.trim();
    if (!answer) return;

    const btn = document.getElementById('btn-submit');
    if (btn) btn.disabled = true;

    try {
      const result = await Api.submitAnswer(state.game.id, question.id, answer);

      // Mark selected option correctness for visual feedback.
      const options = document.querySelectorAll('.option');
      options.forEach((opt) => {
        const text = question.options[Number(opt.dataset.optionIndex)];
        const isChosen = opt.classList.contains('selected');
        if (isChosen) {
          opt.classList.add(result.correct ? 'correct' : 'incorrect');
        }
      });

      Ui.showFeedback(
        result.correct,
        result.correct ? 'Correct!' : 'Not quite — try the next one.',
        result.score
      );

      state.score = result.score;

      if (result.gameState === 'completed') {
        state.game.state = 'completed';
        setTimeout(() => showEnding(), 900);
      } else {
        // Advance to the next question.
        setTimeout(async () => {
          try {
            const refreshed = await Api.getGame(state.game.id);
            state.game = refreshed;
            state.totalQuestions = refreshed.questions.length;
            await loadCurrentQuestion();
          } catch (err) {
            handleError(err);
          }
        }, 1100);
      }
    } catch (err) {
      handleError(err);
      if (btn) btn.disabled = false;
    }
  }

  async function pause() {
    if (!state.game) return;
    try {
      const result = await Api.pauseGame(state.game.id);
      state.game.state = result.state;
      showPaused();
    } catch (err) {
      handleError(err);
    }
  }

  async function resume() {
    if (!state.game) return;
    try {
      const result = await Api.resumeGame(state.game.id);
      state.game.state = result.state;
      await loadCurrentQuestion();
    } catch (err) {
      handleError(err);
    }
  }

  async function showEnding() {
    try {
      let total = state.totalQuestions;
      if (!total && state.game) {
        total = state.game.questions.length;
      }
      Ui.renderEndingFeedback(state.score, total);
    } catch (err) {
      handleError(err);
    }
  }

  async function viewScore() {
    if (!state.game) {
      // No active game: prompt user to play first.
      Ui.renderScoreView(0, 0);
      return;
    }
    try {
      const result = await Api.getScore(state.game.id);
      state.score = result.score;
      Ui.renderScoreView(result.score, state.totalQuestions);
    } catch (err) {
      handleError(err);
    }
  }

  /* ------------------------------------------------------------------ *
   * Admin actions
   * ------------------------------------------------------------------ */

  async function showAdmin() {
    if (!Api.isAdmin()) {
      Ui.showErrorBanner('Administrator access required.');
      return showMenu();
    }
    try {
      const data = await Api.listAdminQuestions();
      Ui.renderAdmin(data.questions || []);
      wireAdminControls();
    } catch (err) {
      handleError(err);
    }
  }

  function wireAdminControls() {
    const form = document.getElementById('admin-create-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const prompt = document.getElementById('admin-prompt').value.trim();
        const options = document.getElementById('admin-options').value
          .split(',').map((s) => s.trim()).filter(Boolean);
        const correctAnswer = document.getElementById('admin-correct').value.trim();

        try {
          await Api.createAdminQuestion({ prompt, options, correctAnswer });
          const fb = document.getElementById('admin-feedback');
          if (fb) {
            fb.textContent = 'Question created.';
            fb.style.color = 'var(--color-success)';
          }
          await showAdmin(); // refresh list
        } catch (err) {
          const fb = document.getElementById('admin-feedback');
          if (fb) {
            fb.textContent = err.message || 'Failed to create question.';
            fb.style.color = 'var(--color-danger)';
          }
        }
      });
    }

    document.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteId;
        try {
          await Api.deleteAdminQuestion(id);
          await showAdmin();
        } catch (err) {
          handleError(err);
        }
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Auth (OIDC Authorization Code + PKCE — no manual token entry)
   * ------------------------------------------------------------------ */

  function signIn() {
    Api.login().catch((err) => handleError(err));
  }

  function signOut() {
    Api.logout().catch((err) => handleError(err));
  }

  function refreshAuth() {
    const authed = Api.hasToken();
    const name = Api.preferredName();
    Ui.setSessionStatus(authed, name);
    document.getElementById('btn-auth').textContent = authed ? 'Sign out' : 'Sign in';
  }

  /* ------------------------------------------------------------------ *
   * Global event delegation & boot
   * ------------------------------------------------------------------ */

  function handleError(err) {
    let message = err && err.message ? err.message : 'Something went wrong.';
    if (err && err.status === 401) {
      message = 'Authentication required. Please sign in.';
    } else if (err && err.status === 403) {
      message = 'You are not allowed to do that.';
    } else if (err && err.status === 409) {
      message = message + ' (the game may be paused or already finished).';
    }
    Ui.showErrorBanner(message);
  }

  function wireGlobalEvents() {
    // Delegate clicks on elements carrying data-action.
    document.getElementById('view').addEventListener('click', async (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      switch (action) {
        case 'menu': return showMenu();
        case 'play': return startGame();
        case 'score': return viewScore();
        case 'help': return showHelp();
        case 'pause': return pause();
        case 'resume': return resume();
        case 'admin': return showAdmin();
        case 'submit': return; // handled by dedicated listener
        default: break;
      }
    });

    document.getElementById('btn-help').addEventListener('click', () => {
      Ui.openModal('help-modal');
    });
    document.getElementById('help-close').addEventListener('click', () => {
      Ui.closeModal('help-modal');
    });

    document.getElementById('btn-auth').addEventListener('click', () => {
      if (Api.hasToken()) {
        signOut();
      } else {
        signIn();
      }
    });
  }

  async function boot() {
    refreshAuth();
    wireGlobalEvents();

    // If we were redirected back from the OIDC provider with a `code`,
    // exchange it for tokens before showing any view.
    try {
      const handled = await Api.handleAuthCallback();
      if (handled) {
        refreshAuth();
        await showMenu();
        return;
      }
    } catch (err) {
      handleError(err);
    }

    // Start at the introduction.
    await showIntroduction();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();