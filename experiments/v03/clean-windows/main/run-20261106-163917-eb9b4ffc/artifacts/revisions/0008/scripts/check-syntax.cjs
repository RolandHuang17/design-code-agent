'use strict';

// Portability-safe syntax checker: verifies JavaScript syntax of all source
// files without depending on shell globbing or platform-specific command
// composition. Invoked by `npm run build`.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const FILES = [
  path.join(ROOT, 'src', 'app.cjs'),
  path.join(ROOT, 'src', 'server.cjs'),
];

function checkFile(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

for (const file of FILES) {
  checkFile(file);
}

// eslint-disable-next-line no-console
console.log(`Syntax OK for ${FILES.length} source file(s).`);