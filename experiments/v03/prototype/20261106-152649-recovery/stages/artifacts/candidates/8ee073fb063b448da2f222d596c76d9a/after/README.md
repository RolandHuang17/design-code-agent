# Temperature Converter

A small, stateless browser-based temperature converter. It is a single
Node.js 22 application (ESM) with no database, no message queue, no Docker,
and no external runtime services.

- Conversion formulas: `C = (F - 32) * 5 / 9` and `K = C + 273.15`
- Units supported: Celsius (`C`), Fahrenheit (`F`), Kelvin (`K`)
- Same-unit conversion preserves the value
- Values below absolute zero (`-273.15` C, `-459.67` F, `0` K) are rejected
  (with a small floating-point tolerance of `1e-9`)

## Prerequisites

- Node.js >= 22 (see the `engines` field in `package.json`)

## Install

```sh
npm install
```

The application has **no runtime or development dependencies**, so this step
only materializes Node's own tooling; no packages need to be fetched or
pinned.

## Start

```sh
npm start
```

This runs `node src/server.js` and binds to `0.0.0.0` on the port given by
the `PORT` environment variable, defaulting to **3000**.

```sh
PORT=8080 npm start   # example: listen on port 8080
```

Open <http://localhost:3000> in a browser to use the converter.

## Test

```sh
npm test
```

This runs Node's built-in test runner (`node --test`) over the real unit
tests in `test/`. The conversion logic is tested without starting a server,
and the HTTP routes are tested by invoking the exported handler directly
(no listening socket required).

## Build

```sh
npm run build
```

This performs source syntax validation only (no bundling or transpilation):

```sh
node --check src/convert.js && node --check src/app.js && node --check src/server.js
```

## API contract

### `GET /`

Serves the browser page (`public/index.html`) with a numeric input, source
and destination unit selectors, a submit button, a result area, and a visible
error feedback element.

- `200` — HTML page

### `POST /api/convert`

Request body must be valid JSON:

```json
{ "value": 100, "from": "C", "to": "F" }
```

- `value`: a finite JSON number (booleans are rejected)
- `from`, `to`: one of `"C"`, `"F"`, `"K"`

Responses:

- `200` — JSON `{ "value": <number>, "unit": "<C|F|K>" }`. The value is **not
  rounded to an integer**.
- `400` — JSON `{ "error": "<nonempty string>" }`, returned for:
  - missing `value`, `from`, or `to`
  - nonnumeric or boolean `value`
  - unsupported units
  - malformed JSON
  - temperatures below absolute zero (also for same-unit conversions)

Example:

```sh
curl -s http://localhost:3000/api/convert \
  -H 'Content-Type: application/json' \
  -d '{"value":100,"from":"C","to":"F"}'
# {"value":212,"unit":"F"}
```

### `GET /health`

- `200` — JSON `{ "status": "ok" }`

## Limitations

- **No external services**: the application uses only Node.js built-in
  modules (`node:http`, `node:fs`, `node:path`, `node:url`, `node:test`,
  `node:assert`) and requires no external database, cache, message queue,
  identity provider, or API key.
- **Single process**: the server runs in a single Node.js process and is
  in-memory and stateless. It does not persist any data and is not designed
  for horizontal scaling or a microservice topology.
- No Docker, OpenAPI specification, or cloud deployment is included.

## Source-to-code/test traceability

| Requirement | Description | Implementing files (code) | Tests |
| --- | --- | --- | --- |
| FR1 | `GET /` serves an HTML page (numeric input, unit selectors, submit, result, visible error) | `public/index.html`, `src/app.js` | `test/app.test.js` (`GET / returns 200`) |
| FR2 | `POST /api/convert` accepts JSON `{value,from,to}` and returns `200 {value,unit}` without integer rounding | `src/app.js`, `src/convert.js` | `test/app.test.js`, `test/convert.test.js` |
| FR3 | Formulas `C = (F - 32) * 5 / 9`, `K = C + 273.15`; same-unit preserves value; negative C/F valid above absolute zero | `src/convert.js` | `test/convert.test.js` |
| FR4 | Reject missing/nonnumeric/boolean/unsupported units/malformed JSON/below absolute zero with `400 {error}` | `src/convert.js` (`validate`), `src/app.js` (`handleConvert`) | `test/convert.test.js`, `test/app.test.js` |
| FR5 | `GET /health` returns `200 {status:'ok'}` | `src/app.js` | `test/app.test.js` |
| NFR1 | Keep conversion logic separate from HTTP handling; test without a server; `build` checks syntax | `src/convert.js` (pure logic), `src/app.js`, `src/server.js`, `package.json` (`build` script) | `test/convert.test.js`, `test/app.test.js` |
| NFR2 | `npm start` binds `process.env.PORT` (default 3000); no external services | `src/server.js`, `package.json` (`start` script) | — (verified manually / by runtime profile) |

## Project layout

```
package.json        Module metadata and scripts (start, build, test)
src/convert.js      Pure conversion + validation logic (FR3, FR4, NFR1)
src/app.js          HTTP handler/router, createApp (FR1, FR2, FR4, FR5)
src/server.js       Server bootstrap using process.env.PORT (NFR2)
public/index.html   Browser UI (FR1)
test/convert.test.js Unit tests for conversion/validation
test/app.test.js    HTTP route tests without a listening server
```