"use strict";

// Browser UI for the library borrowing application.
// Lists books and available copies, borrows with an explicit reader ID,
// and returns loans. No authentication — reader IDs are demonstration inputs.

function $(id) {
  return document.getElementById(id);
}

function showFeedback(message, kind) {
  const el = $("feedback");
  el.textContent = message;
  el.className = "feedback " + (kind || "info");
  window.clearTimeout(showFeedback._timer);
  showFeedback._timer = window.setTimeout(function () {
    el.className = "feedback hidden";
  }, 6000);
}

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    // non-JSON response (e.g. empty body)
  }
  if (!res.ok) {
    const message = body && body.error ? body.error : "Request failed (" + res.status + ")";
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function renderBook(book) {
  const card = document.createElement("article");
  card.className = "book";

  const title = document.createElement("h3");
  title.textContent = book.title;

  const id = document.createElement("p");
  id.className = "muted";
  id.textContent = "ID: " + book.id;

  const copies = document.createElement("p");
  const available = typeof book.availableCopies === "number" ? book.availableCopies : "?";
  copies.textContent = "Available copies: " + available;
  if (available > 0) {
    copies.className = "available";
  } else {
    copies.className = "unavailable";
  }

  card.appendChild(title);
  card.appendChild(id);
  card.appendChild(copies);
  return card;
}

async function loadBooks() {
  const container = $("books");
  try {
    const data = await api("/api/books");
    const books = Array.isArray(data) ? data : data.books || [];
    container.innerHTML = "";
    if (books.length === 0) {
      container.innerHTML = '<p class="muted">No books yet.</p>';
      return;
    }
    books.forEach(function (book) {
      container.appendChild(renderBook(book));
    });
  } catch (e) {
    container.innerHTML = '<p class="error">Could not load books.</p>';
    showFeedback("Could not load books: " + esc(e.message), "error");
  }
}

function renderLoan(loan) {
  const row = document.createElement("div");
  row.className = "loan";

  const label = document.createElement("span");
  label.textContent = "Loan " + loan.id + " — book " + loan.bookId + " — reader " + loan.userId;

  const status = document.createElement("span");
  status.className = "status " + (loan.status === "active" ? "active" : "returned");
  status.textContent = loan.status;

  row.appendChild(label);
  row.appendChild(status);
  return row;
}

async function loadLoans() {
  const container = $("loans");
  try {
    const data = await api("/api/loans");
    const loans = Array.isArray(data) ? data : data.loans || [];
    container.innerHTML = "";
    if (loans.length === 0) {
      container.innerHTML = '<p class="muted">No loans yet.</p>';
      return;
    }
    loans.forEach(function (loan) {
      container.appendChild(renderLoan(loan));
    });
  } catch (e) {
    container.innerHTML = '<p class="error">Could not load loans.</p>';
    showFeedback("Could not load loans: " + esc(e.message), "error");
  }
}

async function refresh() {
  await Promise.all([loadBooks(), loadLoans()]);
}

$("add-book-form").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  const title = $("add-title").value.trim();
  const copies = $("add-copies").value;
  if (!title || !copies) {
    showFeedback("Please provide a title and a positive number of copies.", "error");
    return;
  }
  try {
    const book = await api("/api/books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title, copies: Number(copies) }),
    });
    showFeedback("Book added: " + esc(book.title), "success");
    $("add-title").value = "";
    $("add-copies").value = "";
    await loadBooks();
  } catch (e) {
    showFeedback("Could not add book: " + esc(e.message), "error");
  }
});

$("borrow-form").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  const reader = $("borrow-reader").value.trim();
  const book = $("borrow-book").value.trim();
  if (!reader || !book) {
    showFeedback("Please provide a reader ID and a book ID.", "error");
    return;
  }
  try {
    const loan = await api("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: book, userId: reader }),
    });
    showFeedback("Borrowed: loan " + loan.id, "success");
    $("borrow-reader").value = "";
    $("borrow-book").value = "";
    await refresh();
  } catch (e) {
    showFeedback("Could not borrow: " + esc(e.message), "error");
  }
});

$("return-form").addEventListener("submit", async function (ev) {
  ev.preventDefault();
  const loan = $("return-loan").value.trim();
  if (!loan) {
    showFeedback("Please provide a loan ID.", "error");
    return;
  }
  try {
    await api("/api/loans/" + encodeURIComponent(loan) + "/return", {
      method: "POST",
    });
    showFeedback("Loan " + loan + " returned.", "success");
    $("return-loan").value = "";
    await refresh();
  } catch (e) {
    showFeedback("Could not return loan: " + esc(e.message), "error");
  }
});

refresh();