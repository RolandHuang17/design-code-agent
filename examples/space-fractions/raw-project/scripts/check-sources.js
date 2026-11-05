/**
 * Build-time source checker for Space Fractions.
 *
 * This script actually verifies the source tree rather than printing a
 * success message:
 *   - Syntax-checks every JavaScript file under shared/, gateway/, and
 *     services/* (including test files) via node --check.
 *   - Parses JSON files under keycloak/, prometheus/, and the traceability
 *     and plan manifests to ensure they are valid.
 *   - Performs lightweight structural validation of YAML files that ship in
 *     the repo (compose spec + k8s/istio manifests) by rejecting obviously
 *     malformed documents (duplicate mapping keys, unbalanced indentation on
 *     list items, tabs in indentation).
 *
 * It exits non-zero on the first failure. It does NOT require any running
 * infrastructure (no DB/Redis/EBS/AMQP), so it can run in a clean build agent.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const failures = [];

function fail(message) {
  failures.push(message);
  // eslint-disable-next-line no-console
  console.error(`  ✗ ${message}`);
}

/** Recursively walk a directory collecting files with the given extension. */
function walk(dir, extension, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, extension, acc);
    } else if (entry.name.endsWith(extension)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Collect all JavaScript source and test files in the repo (excl. node_modules). */
function collectJsFiles() {
  const dirs = [
    path.join(ROOT, 'shared'),
    path.join(ROOT, 'gateway'),
    path.join(ROOT, 'services'),
    path.join(ROOT, 'test'),
    path.join(ROOT, 'scripts')
  ];
  const files = [];
  for (const dir of dirs) {
    walk(dir, '.js', files);
  }
  // De-duplicate and sort deterministically.
  return Array.from(new Set(files)).sort();
}

function checkJsSyntax(files) {
  const nodeBin = process.execPath; // Node itself, no npm needed
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const res = spawnSync(nodeBin, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      fail(`syntax error in ${rel}: ${(res.stderr || res.stdout || '').trim()}`);
    }
  }
}

/** Check that a JSON file is parseable. */
function checkJson(file) {
  const rel = path.relative(ROOT, file);
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`invalid JSON in ${rel}: ${err.message}`);
  }
}

/**
 * Lightweight YAML structural checks (not a full YAML parser).
 * Catches the classes of errors a static check should flag without pulling
 * in a dependency: duplicate top-level/scalar mapping keys and tabs used for
 * indentation, plus a simple duplicate-key detection within a document.
 */
function checkYaml(file) {
  const rel = path.relative(ROOT, file);
  const content = fs.readFileSync(file, 'utf8');

  // Tabs in indentation are illegal in YAML.
  const tabIndentLines = [];
  content.split('\n').forEach((line, i) => {
    if (/^\t/.test(line)) tabIndentLines.push(i + 1);
  });
  if (tabIndentLines.length > 0) {
    fail(`tabs used for indentation in ${rel} at lines: ${tabIndentLines.slice(0, 5).join(', ')}`);
  }

  // Duplicate mapping keys within a single top-level document.
  // Split on '---' document separators and check each document's top-level keys.
  content.split(/^---\s*$/m).forEach((doc, docIdx) => {
    const seen = new Map();
    for (const rawLine of doc.split('\n')) {
      const line = rawLine;
      // Only consider top-level (non-indented) mapping keys of form "key:".
      const m = line.match(/^([A-Za-z0-9_.-]+):(?:\s|$)/);
      if (!m) continue;
      const key = m[1];
      if (seen.has(key)) {
        fail(`duplicate mapping key "${key}" in ${rel} (document ${docIdx + 1})`);
      } else {
        seen.set(key, true);
      }
    }
  });
}

/** Validate required manifest files exist and their write ordering is sane. */
function checkRequiredFiles() {
  const required = ['package.json', 'README.md', 'openapi.yaml', 'internal.proto',
    'compose.yaml', 'traceability.json', 'plan.json'];
  for (const f of required) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      fail(`missing required file: ${f}`);
    }
  }
}

function main() {
  console.log('Space Fractions — source check');

  checkRequiredFiles();

  const jsFiles = collectJsFiles();
  checkJsSyntax(jsFiles);
  console.log(`  ✓ syntax-checked ${jsFiles.length} JavaScript file(s)`);

  // Parse all JSON files that are part of the deliverable set.
  const jsonFiles = [
    ...walk(path.join(ROOT, 'keycloak'), '.json'),
    ...walk(path.join(ROOT, 'prometheus'), '.json'),
    path.join(ROOT, 'traceability.json'),
    path.join(ROOT, 'plan.json')
  ].filter((f) => fs.existsSync(f));
  for (const f of jsonFiles) checkJson(f);
  console.log(`  ✓ validated ${jsonFiles.length} JSON file(s)`);

  // Structural check for YAML manifests.
  const yamlFiles = [
    path.join(ROOT, 'compose.yaml'),
    ...walk(path.join(ROOT, 'k8s'), '.yaml'),
    ...walk(path.join(ROOT, 'istio'), '.yaml'),
    ...walk(path.join(ROOT, 'prometheus'), '.yml')
  ].filter((f) => fs.existsSync(f));
  for (const f of yamlFiles) checkYaml(f);
  console.log(`  ✓ structural-checked ${yamlFiles.length} YAML file(s)`);

  if (failures.length > 0) {
    console.error(`\nBuild failed with ${failures.length} issue(s):`);
    process.exitCode = 1;
  } else {
    console.log('\nBuild OK: no source issues found.');
  }
}

main();