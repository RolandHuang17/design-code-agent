# Minimal HTTP Health Service

A small, stateless Node.js 22 HTTP service built only with the built-in `http`
module and `node:test`. It exposes a single health endpoint and returns JSON
errors for unknown routes. No database, Docker, identity provider, or
third-party packages are used.

## Requirements

- Node.js 22 or newer.

## Install

No third-party dependencies are needed, so there is nothing to install beyond
Node.js itself. Running the following is optional but verifies the toolchain
resolution:

```sh
npm install
```

Since the project has no dependencies, `npm install` only materializes the
package metadata; it does not pull any external packages.

## Start

```sh
npm start
```

By default the server listens on port 3000. Override it with the `PORT`
environment variable:

```sh
PORT=8080 npm start
```

## Test

Run the real HTTP tests on an ephemeral loopback port:

```sh
npm test
```

The tests start the exported server factory on loopback port 0, exercise the
health route, an unknown route, and a follow-up health request, then close the
server. No HTTP behavior is mocked.

## Build

Syntax-check every CommonJS source file:

```sh
npm run build
```

## API

| Method | Path      | Status | Body                     |
| ------ | --------- | ------ | ------------------------ |
| GET    | `/health` | 200    | `{"status":"ok"}`        |
| any    | other     | 404    | `{"error":"not found"}`  |

All responses use `Content-Type: application/json`.

## Source-to-Requirement Mapping

| File                 | Responsibility                                | Requirement   |
| -------------------- | --------------------------------------------- | ------------- |
| `src/app.cjs`        | Exported `createServer()` factory and routing | FR1, FR2      |
| `src/index.cjs`      | Executable startup entry reading `PORT`       | FR3           |
| `test/health.test.cjs` | Real ephemeral-port HTTP tests               | NFR1          |
| `package.json`       | Scripts, engine, CommonJS type                | NFR2          |