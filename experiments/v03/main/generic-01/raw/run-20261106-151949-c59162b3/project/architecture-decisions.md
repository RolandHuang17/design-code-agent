# Architecture Decisions

## AD-1: Module convention — CommonJS
The design (Architecture_Documentation.md, "Design decisions") requires a
consistent Convention. We choose CommonJS because this is a small single-node
application with no ESM-specific tooling need and CommonJS keeps the test/build
scripts simple and portable.

## AD-2: Conversion logic isolated from HTTP
NFR1 requires the conversion logic to be testable without a running server. We
separate three modules:

- `lib/convert.js` — pure temperature conversion and validation (no HTTP).
- `lib/app.js` — HTTP application wiring (routes, request parsing) that
  delegates to `lib/convert.js`.
- `server.js` — entry point that starts the server on `process.env.PORT`
  (default 3000).

This mirrors the component split in Architecture_View.md: Browser page (UI),
HTTP application (HTTP), Pure temperature conversion (Convert).

## AD-3: Zero runtime dependencies
The scope explicitly forbids database, identity, message queue, Docker and
OpenAPI. The conversion and validation are implementable with the Node standard
library. We therefore declare no runtime dependencies, which also eliminates
the need to pin dependency versions. The only external tool is the Node
built-in test runner for `npm test`.

## AD-4: Build = syntax check
`npm run build` must "check source syntax" (NFR1). We use
`node --check` against every source module rather than adding a bundler or
transpiler, keeping the project dependency-free.

## AD-5: Validation boundary
FR4 requires HTTP 400 with a nonempty `error` string for malformed input. All
validation (missing fields, non-numeric, booleans, unsupported units, malformed
JSON, absolute-zero violation) lives in the conversion/validation layer so the
HTTP handler simply maps a validation failure to a 400 with the message, and a
successful conversion to a 200 with `{ value, unit }`.

## AD-6: Absolute-zero tolerance
The exact boundary values are -273.15 C, -459.67 F and 0 K. FR4 permits
insignificant floating-point error at these boundaries. We use a small epsilon
(1e-9) when comparing against absolute zero so values that round to the boundary
are accepted while genuinely-below-zero values are rejected.

## AD-7: Same-unit conversion validates absolute zero
FR4 requires rejecting below-zero values even for a same-unit conversion. The
absolute-zero check therefore runs before the unit-preserving short-circuit, so
a same-unit conversion of an invalid temperature is still rejected.