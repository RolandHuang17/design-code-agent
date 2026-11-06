'use strict';

/**
 * Express application wiring for the library borrowing gateway.
 *
 * This module owns the HTTP surface only: it maps routes to the Catalog and
 * Loans business modules and translates their typed errors (code 'VALIDATION',
 * 'NOT_FOUND', 'CONFLICT') into the HTTP statuses mandated by the REST
 * contract (400 / 404 / 409). Every route calls a store-bound business
 * function from src/catalog/catalog.js or src/loans/loans.js; persistence
 * concerns (Postgres transactions, row locks, idempotency) live in the store
 * implementations, never here.
 *
 * The created app is store-agnostic: tests pass an in-memory adapter, the
 * server passes a Postgres one. No database decision is made inside this file.
 */

const express = require('express');
const path = require('path');

const {
  createBook,
  listBooks,
  getBook,
  CatalogError,
} = require('../catalog/catalog');
const { borrow, returnLoan, listLoans, LoansError } = require('../loans/loans');

/**
 * Map a known business error to an HTTP status; unknown errors map to 500.
 * @param {Error & {code?: string}} err
 * @returns {number}
 */
function statusFor(err) {
  if (err instanceof CatalogError) {
    if (err.code === 'VALIDATION') return 400;
    if (err.code === 'NOT_FOUND') return 404;
    return 404;
  }
  if (err instanceof LoansError) {
    if (err.code === 'VALIDATION') return 400;
    if (err.code === 'NOT_FOUND') return 404;
    if (err.code === 'CONFLICT') return 409;
    return 409;
  }
  if (err && err.code === 'VALIDATION') return 400;
  if (err && err.code === 'NOT_FOUND') return 404;
  if (err && err.code === 'CONFLICT') return 409;
  return 500;
}

/**
 * Serialize an error into the plain `{error}` body sent to the browser.
 * @param {Error & {code?: string}} err
 * @returns {{error: string}}
 */
function errorBody(err) {
  return { error: (err && err.message) || 'internal server error' };
}

// Wrap an async route handler so rejected promises reach the error middleware.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Build the Express app around an injected store.
 * @param {import('../store/store.js').Store} store
 * @returns {import('express').Express}
 */
function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Health probe required by Compose/gateway contract.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // --- Catalog -----------------------------------------------------------------

  // FR1: create a title with a positive number of copies (201).
  app.post('/api/books', asyncRoute(async (req, res) => {
    const book = await createBook(store, req.body);
    res.status(201).json(book);
  }));

  // FR2: list books and remaining copies (200).
  app.get('/api/books', asyncRoute(async (req, res) => {
    const result = await listBooks(store);
    res.status(200).json(result);
  }));

  // GET /api/books/:id -> 200 or 404.
  app.get('/api/books/:id', asyncRoute(async (req, res) => {
    const book = await getBook(store, req.params.id);
    res.status(200).json(book);
  }));

  // --- Loans -------------------------------------------------------------------

  // FR2/FR3: borrow an available copy (201) or 404/409.
  app.post('/api/loans', asyncRoute(async (req, res) => {
    const loan = await borrow(store, req.body);
    res.status(201).json(loan);
  }));

  // GET /api/loans -> 200.
  app.get('/api/loans', asyncRoute(async (req, res) => {
    const result = await listLoans(store);
    res.status(200).json(result);
  }));

  // FR4: return a loan (200), idempotent on repetition.
  app.post('/api/loans/:id/return', asyncRoute(async (req, res) => {
    const loan = await returnLoan(store, req.params.id);
    res.status(200).json(loan);
  }));

  // --- Static browser UI --------------------------------------------------------

  // Serve the plain HTML/CSS/JS page at / (relative to this source file's
  // location: src/http/app.js -> project root/public).
  const publicDir = path.resolve(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));

  // 404 for unknown API routes (JSON, flanking the static handler).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Error middleware: translate typed domain errors to HTTP statuses.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Malformed JSON bodies surface as SyntaxError with status 400 from the
    // json parser; treat them as validation failures rather than 500.
    const status =
      err && err.type === 'entity.parse.failed'
        ? 400
        : statusFor(err);
    if (status >= 500 && process.env.NODE_ENV !== 'test') {
      // Do not leak internals to the browser; keep a bounded message.
      console.error(err);
    }
    res.status(status).json(
      status >= 500 ? { error: 'internal server error' } : errorBody(err),
    );
  });

  return app;
}

module.exports = {
  createApp,
  statusFor,
  errorBody,
};