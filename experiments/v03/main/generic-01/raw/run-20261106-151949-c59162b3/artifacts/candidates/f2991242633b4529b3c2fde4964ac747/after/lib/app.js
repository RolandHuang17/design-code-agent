'use strict';

const http = require('http');
const { convert, ConversionError } = require('./convert');

// HTML page for GET / (FR1). It provides a numeric input, source/destination
// unit selectors, a submit button, a result area and a visible error area.
// Submitting performs the conversion by POSTing JSON to /api/convert and
// rendering the returned JSON result or error inline.
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Temperature converter</title>
  <style>
    body { font-family: sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin-top: 1rem; }
    input, select, button { font-size: 1rem; margin-top: 0.25rem; }
    #result, #error { margin-top: 1rem; }
    #error { color: #b00020; display: none; }
  </style>
</head>
<body>
  <h1>Temperature converter</h1>
  <form id="convert-form">
    <label for="value">Temperature</label>
    <input id="value" name="value" type="number" step="any" required>

    <label for="from">From</label>
    <select id="from" name="from">
      <option value="C">Celsius (&deg;C)</option>
      <option value="F">Fahrenheit (&deg;F)</option>
      <option value="K">Kelvin (K)</option>
    </select>

    <label for="to">To</label>
    <select id="to" name="to">
      <option value="F">Fahrenheit (&deg;F)</option>
      <option value="C">Celsius (&deg;C)</option>
      <option value="K">Kelvin (K)</option>
    </select>

    <button type="submit">Convert</button>
  </form>

  <div id="result"></div>
  <div id="error" role="alert"></div>

  <script>
    const form = document.getElementById('convert-form');
    const result = document.getElementById('result');
    const error = document.getElementById('error');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      error.style.display = 'none';
      result.textContent = '';

      const value = Number(document.getElementById('value').value);
      const body = {
        value,
        from: document.getElementById('from').value,
        to: document.getElementById('to').value,
      };

      try {
        const response = await fetch('/api/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (response.ok) {
          result.textContent = payload.value + ' ' + payload.unit;
        } else {
          error.textContent = payload.error || 'Conversion failed';
          error.style.display = 'block';
        }
      } catch (err) {
        error.textContent = 'Request failed: ' + err.message;
        error.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;

// Minimal content-length-aware JSON body reader for Node's raw HTTP server.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        reject(new Error('empty request body'));
        return;
      }
      resolve(data);
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Handle a single POST /api/convert request, delegating validation and
// conversion to lib/convert.js (the pure conversion component).
async function handleConvert(req, res) {
  let body;
  try {
    const raw = await readJsonBody(req);
    body = JSON.parse(raw);
  } catch (err) {
    sendJson(res, 400, { error: 'malformed JSON body' });
    return;
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'invalid request body' });
    return;
  }

  const { value, from, to } = body;
  try {
    const outcome = convert(value, from, to);
    sendJson(res, 200, { value: outcome.value, unit: outcome.unit });
  } catch (err) {
    if (err instanceof ConversionError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

// Create the HTTP application (no listener bound). The server entry point
// attaches this to a port; tests can use it with an in-process listener.
function createApp() {
  return http.createServer((req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(HTML_PAGE),
      });
      res.end(HTML_PAGE);
      return;
    }

    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'POST' && url === '/api/convert') {
      handleConvert(req, res).catch(() => {
        sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

module.exports = { createApp, HTML_PAGE };