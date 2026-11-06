# Minimal HTTP health service

Origin: operator-authored architecture-prototype demonstration input. This is not an original teacher document or a formal benchmark trial.

Build a small stateless Node.js 22 HTTP service using only built-in http and node:test. No database, Docker, identity provider, third-party packages or cloud infrastructure is required.

FR1: GET /health returns HTTP 200 and JSON {"status":"ok"}.
FR2: Unknown routes return HTTP 404 and a JSON error. After an unknown request the service must still answer /health.
FR3: npm start listens on process.env.PORT, default 3000. Keep the exported application/server factory separate from the executable startup file so tests do not start an uncontrolled fixed-port server.
NFR1: npm test runs real HTTP tests on an ephemeral loopback port, checking health, unknown route and health again; close the server after testing. Do not replace actual HTTP behavior with mocks.
NFR2: npm run build checks all source JavaScript syntax. Deliver package.json, source, tests and README with install/start/test instructions and a small source-to-requirement mapping. Keep consistent CommonJS conventions with .cjs source files.
