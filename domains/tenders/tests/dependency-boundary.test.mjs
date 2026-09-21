import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** domains/tenders may use @discovery-platform/core and Node built-ins only: no other domain module, no application, no database, no UI. */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('domains/tenders imports only @discovery-platform/core, relative files and node: built-ins', async () => {
  const offenders = [];
  for (const name of await readdir(SRC)) {
    if (!name.endsWith('.ts')) continue;
    const source = await readFile(path.join(SRC, name), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('.') || spec.startsWith('node:') || spec === '@discovery-platform/core') continue;
      offenders.push(`${name}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the core stays neutral: no tender vocabulary in packages/discovery-core/src', async () => {
  const core = path.join(SRC, '..', '..', '..', 'packages', 'discovery-core', 'src');
  const offenders = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const code = (await readFile(full, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/tenderned|aanbested|\bkenmerk\b|\bcpv\b|\bnuts\b/i.test(code)) offenders.push(full);
    }
  };
  await walk(core);
  assert.deepEqual(offenders, []);
});
