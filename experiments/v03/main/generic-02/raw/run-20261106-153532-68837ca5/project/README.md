# Temperature converter

A small browser-based temperature converter. A single, stateless Node.js 22 application with no database, identity service, message queue, Docker, OpenAPI specification or cloud deployment.

## Architecture

- `public/index.html` — browser page with the conversion controls.
- `src/convert.js` — pure conversion and validation logic (no HTTP or I/O).
- `src/app.js` — HTTP request handler (`/`, `/api/convert`, `/health`).
- `src/server.js` — HTTP server bootstrap.

The conversion logic is kept separate from HTTP handling so it can be tested without a running server (NFR1).

## Install

Requires Node.js 22 or later.

```sh
npm install
```

There are no runtime dependencies; `npm install` is only needed to make npm scripts work consistently.

## Start

```sh
npm start
```

The server listens on `PORT` (default `3000`). Open <http://localhost:3000> to use the converter.

## Test

```sh
npm test
```

Runs meaningful unit tests with `node:test`. The HTTP handler tests inject the handler into an in-process server on an ephemeral port, so no external service or running server is required.

## Build

```sh
npm run build
```

Checks source syntax with `node --check` without running the server.

## API

`POST /api/convert` accepts a JSON body:

```json
{ "value": 100, "from": "F", "to": "C" }
```

and returns:

```json
{ "value": 37.77777777777778, "unit": "C" }
```

Supported units are `C` (Celsius), `F` (Fahrenheit) and `K` (Kelvin). Values below absolute zero (`-273.15 C`, `-459.67 F`, `0 K`) are rejected with HTTP 400 and a JSON `error` message. `GET /health` returns `{ "status": "ok" }`.

## Limitations

- Stateless single-process application; no persistence, identity service or external services.
- Absolutely-zero bounds use a small floating-point tolerance to handle insignificant floating-point error.