// Build/verification script: performs real source checks rather than a no-op.
// Validates the syntax of every JavaScript source file (src/, packages/*/src,
// packages/gateway/public) using `node --check`, and confirms that the root
// contract artifacts (openapi.yaml, internal.proto) exist and are non-empty.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const failures = [];

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectJsFiles(full, out);
    else if (extname(entry) === '.js' || extname(entry) === '.mjs') out.push(full);
  }
  return out;
}

const jsFiles = collectJsFiles(root);
for (const file of jsFiles) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failures.push(`${relative(root, file)}: ${(res.stderr || res.stdout || 'syntax error').trim()}`);
  }
}

const contractFiles = ['openapi.yaml', 'internal.proto', 'compose.yaml'];
for (const file of contractFiles) {
  let content = '';
  try {
    content = readFileSync(join(root, file), 'utf8');
  } catch {
    failures.push(`${file}: missing required contract artifact`);
    continue;
  }
  if (content.trim().length === 0) failures.push(`${file}: empty contract artifact`);
}

if (failures.length > 0) {
  console.error('Build checks failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`Build checks passed: ${jsFiles.length} JS files valid, contract artifacts present.`);