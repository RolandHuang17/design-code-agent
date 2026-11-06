# Temperature converter

A small, stateless, browser-based temperature converter written as a single
Node.js 22 application. It converts between Celsius (`C`), Fahrenheit (`F`) and
Kelvin (`K`).

## Requirements

- Node.js 22 or newer (the `engines` field declares `>=22`).

## Install

There are no external runtime or development dependencies; the application uses
Node's built-in `node:test` runner. Install is therefore a no-op, but you can
still run:

```sh
npm install
```

## Start

```sh
npm start
```

The server listens on `process.env.PORT`, defaulting to `3000`. Open
http://localhost:3000 in a browser to use the form.

### Endpoints

- `GET /` — serves the HTML page with a numeric input, unit selectors, submit
  button, result and visible error feedback.
- `POST /api/convert` — accepts JSON `{"value": number, "from": "C"|"F"|"K",
  "to": "C"|"F"|"K"}` and returns `HTTP 200` with `{"value": number, "unit":
  destination unit}`. Invalid input (missing/nonnumeric values, booleans,
  unsupported units, malformed JSON, or temperatures below absolute zero)
  returns `HTTP 400` with `{"error": "..."}`.
- `GET /health` — returns `HTTP 200` with `{"status":"ok"}`.

## Test

```sh
npm test
```

Runs the unit tests (`test/convert.test.js`) and integration tests
(`test/api.test.js`) using Node's built-in test runner. The conversion logic is
kept separate from HTTP handling and is tested without a running server.

## Build

```sh
npm run build
```

Performs syntax checking of the source files via `node --check` (there is no
compilation step).

## Conversion rules

- `C = (F - 32) * 5 / 9`
- `K = C + 273.15`
- Same-unit conversion preserves the value.
- Absolute zero is rejected: `-273.15 C`, `-459.67 F` and `0 K`.

## Limitations

- Single Node.js process; no database, identity service, message queue, Docker,
  OpenAPI specification, or cloud deployment is required or provided.
- The application is stateless and stores no conversion history.
- No API key or authentication is needed or implemented.
- Rejects any value below absolute zero, including same-unit conversions.
- No external runtime services; everything runs inside Node.js.