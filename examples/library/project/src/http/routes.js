'use strict';

/**
 * HTTP route registration for the library borrowing gateway.
 *
 * This module owns the REST surface mandated by the contract and maps each
 * route to a store-bound business function from src/catalog/catalog.js or
 * src/loans/loans.js. It performs no persistence and no domain validation:
 * those concerns live in the business modules and store implementations. Any
 * error thrown here (typed CatalogError/LoansError) bubbles to the error
 * middleware installed by createApp, which translates it to 400/404/409.
 *
 * It receives the Express app and the injected store, so tests can register
 * the exact production routes against an in-memory adapter without importing
 * an app-level concern (avoiding a circular dependency with app.js).
 */

const express = require('express');

const {
  createBook,
  listBooks,
  getBook,
} = require('../catalog/catalog');
const { borrow, returnLoan, listLoans } = require('../loans/loans');

// Wrap an async route handler so rejected promises reach the error middleware.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Register the versioned API routes plus the health probe.
 * @param {import('express').Express} app
 * @param {import('../store/store.js').Store} store
 */
function registerApiRoutes(app, store) {
  const router = express.Router();

  // Health probe required by Compose/gateway contract.
  router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // --- Catalog ---------------------------------------------------------------

  // FR1: create a title with a positive number of copies (201).
  router.post('/books', asyncRoute(async (req, res) => {
    const book = await createBook(store, req.body);
    res.status(201).json(book);
  }));

  // FR2: list books and remaining copies (200).
  router.get('/books', asyncRoute(async (req, res) => {
    const result = await listBooks(store);
    res.status(200).json(result);
  }));

  // GET /books/:id -> 200 or 404.
  router.get('/books/:id', asyncRoute(async (req, res) => {
    const book = await getBook(store, req.params.id);
    res.status(200).json(book);
  }));

  // --- Loans -----------------------------------------------------------------

  // FR2/FR3: borrow an available copy (201) or 404/409.
  router.post('/loans', asyncRoute(async (req, res) => {
    const loan = await borrow(store, req.body);
    res.status(201).json(loan);
  }));

  // GET /loans -> 200.
  router.get('/loans', asyncRoute(async (req, res) => {
    const result = await listLoans(store);
    res.status(200).json(result);
  }));

  // FR4: return a loan (200), idempotent on repetition.
  router.post('/loans/:id/return', asyncRoute(async (req, res) => {
    const loan = await returnLoan(store, req.params.id);
    res.status(200).json(loan);
  }));

  app.use('/api', router);
}

module.exports = {
  registerApiRoutes,
};