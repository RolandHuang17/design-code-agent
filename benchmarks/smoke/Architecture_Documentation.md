# Tiny HTTP health service

Origin: operator-authored GUI smoke input, not an original teacher document and not a formal benchmark trial.

FR-1: A Node.js22+ HTTP server exposes GET /health with status200 and JSON {"status":"ok"}.
FR-2: Unknown routes return404. The process uses environment PORT, default3000.
NFR-1: Keep the repository minimal. Use Node built-in http and node:test; no database, authentication, cloud resources or third-party runtime dependencies are needed.

Serve through Compose gateway on container port3000. Supply meaningful tests that start an ephemeral local server and check both routes, a real syntax-check build, README, OpenAPI and source-linked traceability.
