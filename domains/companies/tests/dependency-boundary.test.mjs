import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** domains/companies may use @discovery-platform/core and relative files only; its './criteria' entry must stay browser-safe. */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('domains/companies imports only @discovery-platform/core and relative files', async () => {
  const offenders = [];
  for (const name of await readdir(SRC)) {
    if (!name.endsWith('.ts')) continue;
    const source = await readFile(path.join(SRC, name), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('.') || spec === '@discovery-platform/core') continue;
      offenders.push(`${name}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the browser entry (criteria) and what it imports use no Node built-ins and no runtime import of the core', async () => {
  const seen = new Set();
  const offenders = [];
  const visit = async file => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(path.join(SRC, file), 'utf8');
    for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      const [, typeOnly, spec] = match;
      if (spec.startsWith('.')) await visit(spec.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
      else if (!typeOnly) offenders.push(`${file}: ${spec}`);
    }
  };
  await visit('criteria.ts');
  assert.deepEqual(offenders, []);
});
