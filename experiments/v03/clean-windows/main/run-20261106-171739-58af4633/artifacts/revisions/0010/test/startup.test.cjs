'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const { createServer } = require('../src/app.cjs');

const ROOT = path.resolve(__dirname, '..');

// Get a free ephemeral port to avoid colliding with a fixed port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('FR3: server factory returns a non-listening server (separation from startup)', () => {
  const server = createServer();
  assert.ok(server instanceof http.Server);
  // A freshly created server has no bound address until listen() is called.
  assert.equal(server.listening, false);
  server.close();
});

test('FR3: npm start entry listens on process.env.PORT and answers /health', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.cjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    // Wait until the server responds, polling briefly.
    const base = `http://127.0.0.1:${port}`;
    let body = null;
    for (let i = 0; i < 50; i += 1) {
      if (child.exitCode !== null) break;
      try {
        const res = await new Promise((resolve, reject) => {
          http.get(`${base}/health`, (r) => {
            let data = '';
            r.on('data', (c) => { data += c; });
            r.on('end', () => resolve({ statusCode: r.statusCode, data }));
          }).on('error', reject);
        });
        if (res.statusCode === 200) {
          body = res.data;
          break;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.notEqual(body, null, `server on port ${port} never became ready; stderr=${stderr}`);
    assert.deepEqual(JSON.parse(body), { status: 'ok' });
    assert.match(stdout, new RegExp(`listening on port ${port}`));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('NFR2: npm run build syntax-checks all source JavaScript (exit 0)', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-syntax.cjs')], {
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `check-syntax should exit 0; stdout=${result.stdout} stderr=${result.stderr}`
  );
});