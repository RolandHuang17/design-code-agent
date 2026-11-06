'use strict';

/**
 * Build-time verification script (npm run build).
 *
 * Performs real checks against the repository:
 *   - `node --check` (syntax validation) over every JavaScript source file
 *   - JSON.parse validation of JSON configuration files
 *   - YAML structure validation (openapi.yaml, compose.yaml, k8s manifest) via js-yaml
 *   - Presence/structure checks for OpenAPI and protobuf contracts
 *
 * This script never prints a success message in place of an actual check: every
 * assertion below either passes or throws, causing a non-zero exit code.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');

const JS_FILES = [
  'gateway/app.js',
  'gateway/index.js',
  'lib/auth.js',
  'lib/cache.js',
  'lib/db.js',
  'lib/events.js',
  'lib/fraction.js',
  'lib/game-state.js',
  'lib/search.js',
  'lib/types.js',
  'lib/user-map.js',
  'public/app.js',
  'services/admin-service.js',
  'services/game-service.js',
  'services/question-service.js',
  'services/user-service.js',
  'test/auth.test.js',
  'test/fraction.test.js',
  'test/game-service.test.js',
  'test/integration.test.js',
];

const JSON_FILES = ['package.json', 'plan.json', 'traceability.json', 'keycloak/realm.json'];
const YAML_FILES = ['openapi.yaml', 'compose.yaml', 'k8s/spacefractions-deployment.yaml'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function checkJs(file) {
  const abs = path.join(ROOT, file);
  assert(fs.existsSync(abs), `missing JavaScript source file: ${file}`);
  try {
    // --check only parses; no code is executed.
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`syntax error in ${file}: ${err.message}`);
  }
}

function checkJson(file) {
  const abs = path.join(ROOT, file);
  assert(fs.existsSync(abs), `missing JSON file: ${file}`);
  const raw = fs.readFileSync(abs, 'utf8');
  try {
    JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err.message}`);
  }
}

function checkYaml(file) {
  const abs = path.join(ROOT, file);
  assert(fs.existsSync(abs), `missing YAML file: ${file}`);
  const raw = fs.readFileSync(abs, 'utf8');
  try {
    yaml.load(raw);
  } catch (err) {
    throw new Error(`invalid YAML in ${file}: ${err.message}`);
  }
}

function checkOpenApi() {
  const abs = path.join(ROOT, 'openapi.yaml');
  const doc = yaml.load(fs.readFileSync(abs, 'utf8'));
  assert(doc, 'openapi.yaml parsed to empty document');
  assert(doc.openapi && typeof doc.openapi === 'string', 'openapi.yaml missing openapi version');
  assert(doc.info, 'openapi.yaml missing info');
  assert(doc.paths && typeof doc.paths === 'object', 'openapi.yaml missing paths');
  assert('/health' in doc.paths, 'openapi.yaml missing GET /health contract');
  assert('/play' in doc.paths, 'openapi.yaml missing GET /play backward-compat contract');
}

function checkProto() {
  const abs = path.join(ROOT, 'internal.proto');
  assert(fs.existsSync(abs), 'missing internal.proto');
  const raw = fs.readFileSync(abs, 'utf8');
  assert(raw.includes('service GameService'), 'internal.proto missing GameService');
  assert(raw.includes('rpc Play'), 'internal.proto missing Play rpc');
}

function main() {
  for (const file of JS_FILES) checkJs(file);
  for (const file of JSON_FILES) checkJson(file);
  for (const file of YAML_FILES) checkYaml(file);
  checkOpenApi();
  checkProto();
  process.stdout.write('build check passed: sources, configs and contracts verified\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`build check failed: ${err.message}\n`);
  process.exitCode = 1;
}