# Temperature converter

A small, stateless, browser-based temperature converter built as a single
Node.js 22 application. No database, identity service, message queue, Docker,
OpenAPI specification, or cloud deployment is required or included.

## Install

```bash
npm install
```

There are no runtime dependencies, so installation only sets up the project.
The project uses CommonJS modules throughout.

## Start

```bash
npm start
```

The server listens on `process.env.PORT` (default `3000`), bound to
`0.0.0.0`. Example with a custom port:

```bash
PORT=8080 npm start
```

## Test

```bash
npm test
```

Runs meaningful unit tests with the built-in `node:test` runner:

- `test/convert.test.js` exercises the pure conversion and validation logic
  without a running server (NFR1).
- `test/app.test.js` exercises the HTTP routes using an in-process listener.

No external services are required to run the tests.

## Build (syntax check)

```bash
npm run build
```

Runs `node --check` over the source and entry points to verify syntax.

## API contract

### `GET /`

Returns an HTML page with a numeric input, source and destination unit
selectors (`C`/`F`/`K`), a submit button, a result area, and visible error
feedback. The page submits to `POST /api/convert` via `fetch` and renders the
JSON result or error inline.

### `POST /api/convert`

Accepts JSON of the form:

```json
{ "value": 100, "from": "C", "to": "F" }
```

- `value` must be a number (booleans and non-numeric values are rejected).
- `from` and `to` are each one of `"C"`, `"F"`, `"K"`.

Success (HTTP 200):

```json
{ "value": 212, "unit": "F" }
```

The returned value is a number and is not rounded to an integer.

Failure (HTTP 400):

```json
{ "error": "..." }
```

where `error` is a non-empty string describing the problem.

Conversions use:

- `C = (F - 32) * 5 / 9`
- `K = C + 273.15`

Converting to the same unit preserves the value exactly.

### `GET /health`

Returns HTTP 200:

```json
{ "status": "ok" }
```

## Validation rules

The following are rejected with HTTP 400 and a `{"error": ...}` body:

- missing fields
- non-numeric `value` (including booleans)
- unsupported units
- malformed JSON
- temperatures below absolute zero

Absolute zero is `-273.15 C`, `-459.67 F`, and `0 K`. Values below absolute
zero are rejected even for same-unit conversions. Insignificant floating-point
error at these exact boundaries is tolerated.

## Limitations

- The application is stateless: no persistence of any kind.
- No rounding of the API result value is performed.
- No database, identity service, or message queue is used.
- Negative Celsius and Fahrenheit values are valid only above absolute zero.