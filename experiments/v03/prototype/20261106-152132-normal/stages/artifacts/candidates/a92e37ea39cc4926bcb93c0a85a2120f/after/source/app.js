// HTTP application layer (FR1, FR2, FR4, FR5).
//
// Exposes:
//   - createApp(): an http server whose request handler routes:
//       GET  /            -> static HTML page (public/index.html)
//       POST /api/convert -> JSON conversion endpoint (FR2, FR4)
//       GET  /health      -> { status: "ok" } (FR5)
//   - handler(req, res):  the underlying request handler (separated from the
//     server for easier testing).
//
// The pure conversion/validation logic lives in convert.js and is kept free of
// any HTTP dependency (NFR1).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convert, validate } from './convert.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = join(__dirname, '..', 'public', 'index.html');

// A small HTTP error type used internally to carry status and JSON body.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Read and validate the "value", "from" and "to" fields from a parsed JSON
 * body. Throws HttpError(400) for every invalid case described in FR4.
 */
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  const { value, from, to } = body;
  if (value === undefined || from === undefined || to === undefined) {
    throw new HttpError(400, 'value, from and to are required');
  }
  const error = validate(value, from, to);
  if (error !== null) {
    throw new HttpError(400, error);
  }
  return { value, from, to };
}

/**
 * Parse the raw request body. Rejects non-JSON bodies with a 400 error, and
 * enforces a maximum size to avoid unbounded allocation.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const MAX_BODY_BYTES = 64 * 1024;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(400, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        reject(new HttpError(400, 'request body is empty JSON'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new HttpError(400, 'malformed JSON'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', (err) => {
      reject(new HttpError(400, 'error reading request body: ' + err.message));
    });
  });
}

/**
 * The HTTP request handler. Routes GET /, POST /api/convert and GET /health.
 */
export async function handler(req, res) {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    if (method === 'GET' && url.pathname === '/') {
      const html = await readFile(INDEX_HTML_PATH, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/convert') {
      const body = await readJsonBody(req);
      const { value, from, to } = validateBody(body);
      const result = convert(value, from, to);
      sendJson(res, 200, { value: result, unit: to });
      return;
    }

    // Unknown route/method combination.
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    sendJson(res, 500, { error: 'internal server error' });
  }
}

/**
 * Create and return an http.Server wired to {handler}.
 */
export function createApp() {
  return createServer(handler);
}