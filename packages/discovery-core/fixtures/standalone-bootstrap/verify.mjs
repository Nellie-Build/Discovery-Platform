#!/usr/bin/env node
// Development/verification fixture only — not part of the routine test suite (it does a real
// `npm install` over the network into a scratch directory, which is too slow/flaky for CI).
//
// Proves, mechanically, that packages/discovery-core is fit to be used as a genuinely
// standalone package — copied out of this repository's own root workspace into a fresh temp
// directory completely outside it (so it can resolve nothing via this repository's workspace or
// a `file:` link, the way a real external consumer would), then runs `npm install`, `npm run
// build` and `npm test` there exactly as that external project would. It also statically
// re-checks the *copied* source (not the original) for: no relative import escapes the package,
// no `process.env` usage, and no Firebase/Firestore/product-specific-database dependency.
//
// Run: node fixtures/standalone-bootstrap/verify.mjs
import { mkdtempSync, cpSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];

function step(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`✔ ${name}`); }
  catch (error) { results.push({ name, ok: false, error }); console.log(`✖ ${name}\n  ${error.message}`); }
}

function listTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

// A fresh directory OUTSIDE this repository entirely — proves nothing is reachable via a
// parent monorepo, a workspace, or a `file:` link, the way an actual external project would be.
const tempDir = mkdtempSync(path.join(tmpdir(), 'discovery-core-standalone-'));
console.log(`Standalone copy: ${tempDir}`);

let allOk = true;
try {
  step('copy only package.json, tsconfig.json, src/, tests/ (no monorepo files)', () => {
    for (const item of ['package.json', 'tsconfig.json', 'src', 'tests']) {
      cpSync(path.join(PACKAGE_ROOT, item), path.join(tempDir, item), { recursive: true });
    }
  });

  step('copied source has no process.env usage', () => {
    const offenders = listTsFiles(path.join(tempDir, 'src')).filter(f => readFileSync(f, 'utf8').includes('process.env'));
    if (offenders.length) throw new Error(`found process.env in: ${offenders.join(', ')}`);
  });

  step('copied source has no Firebase/Firestore/product-specific-database reference', () => {
    const forbidden = [/firebase/i, /firestore/i, /discovery_leads/i, /\bpg\b/, /postgres/i];
    const offenders = [];
    for (const file of listTsFiles(path.join(tempDir, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
    }
    if (offenders.length) throw new Error(offenders.join('; '));
  });

  step('copied source has no relative import that escapes the package (no "../" past src/)', () => {
    const offenders = [];
    for (const file of listTsFiles(path.join(tempDir, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
        const resolved = path.resolve(path.dirname(file), match[1]);
        if (!resolved.startsWith(path.join(tempDir, 'src'))) offenders.push(`${file}: ${match[1]}`);
      }
    }
    if (offenders.length) throw new Error(offenders.join('; '));
  });

  step('npm install runs with no parent-repo/workspace/file: dependency involved', () => {
    execFileSync(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: tempDir, stdio: 'pipe', shell: true });
  });

  step('npm run build (tsc) succeeds standalone', () => {
    execFileSync(npmCmd, ['run', 'build'], { cwd: tempDir, stdio: 'pipe', shell: true });
  });

  step('npm test (the package\'s own test suite) succeeds standalone', () => {
    execFileSync(npmCmd, ['test'], { cwd: tempDir, stdio: 'pipe', shell: true });
  });
} finally {
  allOk = results.every(r => r.ok);
  if (allOk) rmSync(tempDir, { recursive: true, force: true });
  else console.log(`\nLeft the failed copy at ${tempDir} for inspection.`);
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed.`);
process.exitCode = allOk ? 0 : 1;
