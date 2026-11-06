'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  // Fetch JSON while surfacing a friendly, bounded error message.
  async function api(path, options) {
    const res = await fetch(path, options);
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok) {
      const msg =
        (body && body.error) || ('Request failed with status ' + res.status);
      throw new Error(msg);
    }
    return body;
  }

  function show(el, message, kind) {
    el.textContent = message;
    el.className = 'feedback ' + kind;
  }

  function clear(el) {
    el.textContent = '';
    el.className = 'feedback';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapedClass(value) {
    return String(value).replace(/[^a-z0-9_-]/gi, '');
  }

  function renderBooks(books) {
    const tbody = $('#books-table tbody');
    tbody.innerHTML = '';
    if (!books || books.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="muted">No titles yet. Add one above.</td></tr>';
      return;
    }
    for (const book of books) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(book.title) + '</td>' +
        '<td>' + book.availableCopies + '</td>' +
        '<td class="row-actions"></td>';
      const actions = tr.querySelector('td.row-actions');
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Reader id';
      input.setAttribute('aria-label', 'Reader id');
      const btn = document.createElement('button');
      btn.textContent = 'Borrow';
      btn.disabled = book.availableCopies <= 0;
      btn.addEventListener('click', () => borrow(book.id, input.value));
      actions.appendChild(input);
      actions.appendChild(btn);
      tbody.appendChild(tr);
    }
  }

  function renderLoans(loans, books) {
    const tbody = $('#loans-table tbody');
    tbody.innerHTML = '';
    const byId = {};
    for (const b of books || []) byId[b.id] = b;
    for (const loan of loans || []) {
      const title = byId[loan.bookId] ? byId[loan.bookId].title : loan.bookId;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(loan.id) + '</td>' +
        '<td>' + escapeHtml(title) + '</td>' +
        '<td>' + escapeHtml(loan.userId) + '</td>' +
        '<td><span class="badge ' + escapedClass(loan.status) + '">' +
          escapeHtml(loan.status) + '</span></td>' +
        '<td class="row-actions"></td>';
      const actions = tr.querySelector('td.row-actions');
      if (loan.status === 'active') {
        const btn = document.createElement('button');
        btn.textContent = 'Return';
        btn.addEventListener('click', () => returnLoan(loan.id));
        actions.appendChild(btn);
      } else {
        actions.innerHTML = '<span class="muted">&mdash;</span>';
      }
      tbody.appendChild(tr);
    }
  }

  function refresh() {
    return Promise.all([
      api('/api/books').catch((err) => ({ books: [], __err: err })),
      api('/api/loans').catch((err) => ({ loans: [], __err: err })),
    ]).then(([booksResult, loansResult]) => {
      const books = booksResult.books || [];
      const loans = loansResult.loans || [];
      if (booksResult.__err)
        show($('#catalog-feedback'), booksResult.__err.message, 'err');
      if (loansResult.__err)
        show($('#loans-feedback'), loansResult.__err.message, 'err');
      renderBooks(books);
      renderLoans(loans, books);
    });
  }

  async function borrow(bookId, userId) {
    const feedback = $('#catalog-feedback');
    clear(feedback);
    if (!userId || !userId.trim()) {
      show(feedback, 'Reader id is required to borrow.', 'err');
      return;
    }
    try {
      await api('/api/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: bookId, userId: userId.trim() }),
      });
      show(feedback, 'Book borrowed successfully.', 'ok');
    } catch (err) {
      show(feedback, err.message, 'err');
    }
    refresh();
  }

  async function returnLoan(loanId) {
    const feedback = $('#loans-feedback');
    clear(feedback);
    try {
      await api('/api/loans/' + encodeURIComponent(loanId) + '/return', {
        method: 'POST',
      });
      show(feedback, 'Loan returned.', 'ok');
    } catch (err) {
      show(feedback, err.message, 'err');
    }
    refresh();
  }

  // Wire up once DOM is ready (script is loaded with defer in index.html).
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = $('#catalog-feedback');
    clear(feedback);
    const title = $('#title').value.trim();
    const copies = Number($('#copies').value);
    try {
      await api('/api/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, copies: copies }),
      });
      show(feedback, 'Title created.', 'ok');
      e.target.reset();
    } catch (err) {
      show(feedback, err.message, 'err');
    }
    refresh();
  });

  refresh();
})();