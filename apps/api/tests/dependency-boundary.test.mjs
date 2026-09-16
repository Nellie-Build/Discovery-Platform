import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * apps/api must never parse a domain-specific field itself (see domain-registry.ts's own
 * docstring) — every route file may depend on @discovery-platform/core and @discovery-platform/db,
 * but only src/domains/*-adapter.ts is allowed to import a domain module
 * (@discovery-platform/domain-*). Scans the actual published source, not a convention someone
 * has to remember.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listTsFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function importSpecifiers(source) {
  const specs = [];
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
  return specs;
}

test('dependency boundary: only src/domains/*-adapter.ts may import a domain module', async () => {
  const files = await listTsFiles(SRC_DIR);
  const sources = new Map();
  for (const file of files) sources.set(file, await readFile(file, 'utf8'));

  const offenders = [];
  for (const [file, source] of sources) {
    const isAdapterFile = /[\\/]domains[\\/].*-adapter\.ts$/.test(file);
    for (const spec of importSpecifiers(source)) {
      if (/^@discovery-platform\/domain-/.test(spec) && !isAdapterFile) offenders.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('routes/*.ts never mention a domain-specific field name (title, company, salary, bedrooms, ...)', () => {
  return (async () => {
    const files = (await listTsFiles(SRC_DIR)).filter(f => /[\\/]routes[\\/]/.test(f));
    assert.ok(files.length > 0, 'expected route files to exist');
    const forbidden = [/\btitle\b/i, /\bcompany\b/i, /\bsalary\b/i, /\bbedrooms\b/i, /\bvacancyfacts\b/i, /\bcontractType\b/i];
    const offenders = [];
    for (const file of files) {
      const source = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const pattern of forbidden) if (pattern.test(source)) offenders.push(`${file}: matches ${pattern}`);
    }
    assert.deepEqual(offenders, []);
  })();
});

test('routes/*.ts never import @discovery-platform/domain-* directly — only through domain-registry.ts', async () => {
  const files = (await listTsFiles(SRC_DIR)).filter(f => /[\\/]routes[\\/]/.test(f));
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      if (/^@discovery-platform\/domain-/.test(spec)) offenders.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('apps/api never imports ts-jobspy (or any job-board-scraper package) directly, anywhere — that dependency lives entirely inside domains/vacancies, behind its own VacancySourceProvider', async () => {
  const files = await listTsFiles(SRC_DIR);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      if (spec === 'ts-jobspy' || spec.startsWith('ts-jobspy/')) offenders.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});
