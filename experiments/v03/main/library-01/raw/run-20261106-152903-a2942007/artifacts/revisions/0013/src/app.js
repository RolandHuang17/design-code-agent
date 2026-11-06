'use strict';

/**
 * Express application factory.
 *
 * Wires the REST endpoints described in the architecture document to the
 * catalog and loans business modules. The factory takes a repository
 * (dependency injection) so tests can inject the in-memory adapter while the
 * runtime (`src/server.js`) supplies the real PostgreSQL adapter.
 *
 * Endpoint mapping (Architecture_Documentation.md, REST interface):
 *   POST   /api/books          -> 201 {id,title,availableCopies} | 400
 *   GET    /api/books          -> 200 {books:[...]}
 *   GET    /api/books/:id      -> 200 book | 404
 *   POST   /api/loans          -> 201 {id,bookId,userId,status:"active"} | 400 | 404 | 409
 *   GET    /api/loans          -> 200 {loans:[...]}
 *   POST   /api/loans/:id/return -> 200 returned loan (idempotent) | 404
 *   GET    /health             -> 200
 */

const express = require('express');
const { RepositoryError } = require('./repository');
const { createCatalogService } = require('./catalog');
const { createLoansModule } = require('./loans');

/**
 * Build the Express app for a given repository.
 * @param {object} repository - repository instance implementing the contract
 *   in src/repository.js.
 * @returns {import('express').Express}
 */
function createApp(repository) {
  const app = express();
  const catalog = createCatalogService(repository);
  const loans = createLoansModule(repository);

  app.use(express.json());

  // Health endpoint (no dependencies).
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Catalog.
  app.post('/api/books', async (req, res, next) => {
    try {
      const book = await catalog.createBook(req.body);
      res.status(201).json(book);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/books', async (req, res, next) => {
    try {
      const books = await catalog.listBooks();
      res.status(200).json({ books });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/books/:id', async (req, res, next) => {
    try {
      const book = await catalog.getBook(req.params.id);
      if (book == null) {
        return res.status(404).json({ error: 'Book not found' });
      }
      res.status(200).json(book);
    } catch (err) {
      next(err);
    }
  });

  // Loans.
  app.post('/api/loans', async (req, res, next) => {
    try {
      const { bookId, userId } = req.body == null ? {} : req.body;
      const loan = await loans.borrow(bookId, userId);
      res.status(201).json(loan);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/loans', async (req, res, next) => {
    try {
      const loanList = await loans.listLoans();
      res.status(200).json({ loans: loanList });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/loans/:id/return', async (req, res, next) => {
    try {
      const loan = await loans.returnLoan(req.params.id);
      res.status(200).json(loan);
    } catch (err) {
      next(err);
    }
  });

  // Centralised error mapping to HTTP status codes.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof RepositoryError) {
      const status = Number.isInteger(err.httpStatus) ? err.httpStatus : 500;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    // JSON body parse errors and other unexpected failures.
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };