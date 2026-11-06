import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convert, validateInput } from './convert.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, '..', 'public', 'index.html');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendIndex(res) {
  readFile(INDEX_PATH, 'utf8')
    .then((html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    })
    .catch(() => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function handleConvert(req, res) {
  readBody(req)
    .then((raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        json(res, 400, { error: 'Malformed JSON' });
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        json(res, 400, { error: 'Request body must be a JSON object' });
        return;
      }
      const { value, from, to } = parsed;
      const validation = validateInput(value, from, to);
      if (!validation.ok) {
        json(res, 400, { error: validation.error });
        return;
      }
      json(res, 200, { value: convert(value, from, to), unit: to });
    })
    .catch(() => {
      json(res, 400, { error: 'Malformed JSON' });
    });
}

export function handler(req, res) {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health' && method === 'GET') {
    json(res, 200, { status: 'ok' });
    return;
  }

  if (url.pathname === '/api/convert' && method === 'POST') {
    handleConvert(req, res);
    return;
  }

  if (url.pathname === '/' && method === 'GET') {
    sendIndex(res);
    return;
  }

  json(res, 404, { error: 'Not found' });
}

export default handler;