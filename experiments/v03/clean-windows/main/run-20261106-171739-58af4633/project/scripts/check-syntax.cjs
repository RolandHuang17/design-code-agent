'use strict';

// Syntax-checks all source and test JavaScript files using node --check.
// This satisfies NFR2 ("npm run build checks all source JavaScript syntax")
// without introducing any third-party dependency.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

const DIRS = ['src', 'test', 'scripts'];

function collectJavaScriptFiles() {
  const files = [];
  for (const dir of DIRS) {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute)) {
      if (entry.endsWith('.cjs') || entry.endsWith('.js')) {
        files.push(path.join(absolute, entry));
      }
    }
  }
  return files;
}

const files = collectJavaScriptFiles();
let failures = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`Syntax error in ${file}\n`);
    process.stderr.write(result.stderr || '');
  } else {
    process.stdout.write(`ok ${file}\n`);
  }
}

if (files.length === 0) {
  process.stderr.write('No JavaScript files found to check.\n');
  process.exit(1);
}

process.exit(failures === 0 ? 0 : 1);