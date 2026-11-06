import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { convert, validate } from './convert.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'public', 'index.html');

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/') {
    return serveIndex(res);
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'POST' && pathname === '/api/convert') {
    return handleConvert(req, res);
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function serveIndex(res) {
  try {
    const html = await readFile(INDEX_PATH, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html)
    });
    res.end(html);
  } catch {
    sendJson(res, 500, { error: 'Unable to serve index' });
  }
}

async function handleConvert(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Malformed JSON' });
    return;
  }

  try {
    const { value, from, to } = validate(payload);
    const result = convert(value, from, to);
    sendJson(res, 200, result);
  } catch (err) {
    const message = err && err.message ? err.message : 'Invalid request';
    sendJson(res, 400, { error: message });
  }
}

/**
 * Create the HTTP server request handler.
 */
export function createApp() {
  return (req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      } else {
        res.end();
      }
    });
  };
}