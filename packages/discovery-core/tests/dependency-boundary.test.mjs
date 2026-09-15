import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Automated proof of this package's core architecture rule: it must never depend on React,
 * Firebase/Firestore, any single consumer's database field, Moroccan/city-specific location
 * knowledge, or an accommodation-shaped business rule — it stays product-neutral for any domain
 * module built on top of it. Scans the actual published source, not a hand-maintained list of
 * files someone has to remember to update — a new file under src/ is covered automatically.
 * This package was originally extracted from a larger monorepo (Maroc2Stay); this file also
 * proves no leftover reference to that monorepo survived the copy.
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

/** Strips comments before scanning for forbidden business vocabulary, so a doc comment
 * explaining *why* a rule exists is never mistaken for an actual code dependency or business
 * rule itself. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function importSpecifiers(source) {
  const specs = [];
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  return specs;
}

test('dependency boundary: discovery-core stays product-neutral', async t => {
  const files = await listTsFiles(SRC_DIR);
  assert.ok(files.length >= 5, 'expected the core package to actually contain source files');
  const sources = new Map();
  for (const file of files) sources.set(file, await readFile(file, 'utf8'));

  await t.test('imports nothing from React or a .tsx application', () => {
    const offenders = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        if (/^react(-dom)?(\/|$)/.test(spec) || /[\\/]src[\\/]/.test(spec) || /\.tsx$/.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('imports nothing from Firebase, Firestore, or Firebase Functions', () => {
    const offenders = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        if (/^firebase(-admin|-functions)?(\/|$)/.test(spec) || /[\\/]functions[\\/]/.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('imports nothing from domains/vacancies or any other domain package', () => {
    const offenders = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        if (/domains[\\/]/.test(spec) || /@discovery-platform\/domain-/.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('imports only the exact dependencies declared in package.json (cheerio, fast-xml-parser, ipaddr.js, robots-parser, and Node built-ins)', () => {
    const allowed = new Set(['cheerio', 'fast-xml-parser', 'ipaddr.js', 'robots-parser']);
    const offenders = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith('.') || spec.startsWith('node:')) continue; // relative import or a Node built-in
        if (!allowed.has(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('contains no Morocco/Maroc-specific location knowledge and no accommodation-shaped business rule, anywhere in actual code (comments excluded)', () => {
    // Each pattern names something that belongs to a *domain module*, never to this generic
    // package. "maroc2stay" itself (the monorepo this package was copied out of) is checked
    // separately below — it must never appear anywhere in this package at all any more.
    const forbidden = [
      /\bmorocco\b/i, /\bmarokk/i, /\bmaroc\b/i,
      /\baccommodat/i, /\bwhatsappconfirmed\b/i, /\bprivaterentallikelihood\b/i, /\bdirectcontactlikelihood\b/i,
      /\bclaimready\b/i, /\baddlisting\b/i, /\baccommodationlead\b/i, /\bmoroccolead\b/i, /\bpropertydiscovery\b/i,
      // A vacation-rental domain module's own scoring rules (hotel/apartment/corporate) must
      // never leak into this generic engine — a scoring *rule* mentioning them belongs in a
      // domain module, never in this file.
      /\bhotel\b/i, /\bapartment\b/i, /\bcorporate\b/i, /\bmanyrooms\b/i, /\bhotelservices\b/i, /\bprivaterental\b/i,
      /\bvacancycompleteness\b/i, /\bcandidatequality\b/i,
      // A vacation-rental domain module's own dedupe signals (same website domain, phone,
      // e-mail, name+city, nearby coordinates) must never leak into this generic engine either —
      // a dedupe *signal* naming any of them belongs in a domain module, never in this file.
      /\bwebsite_key\b/i, /\bnamecity\b/i, /\bwebsitekey\b/i, /\bautomerge\b/i, /\bauto_merge\b/i,
      // A vacation-rental domain module's own Vision schema (a flyer, a bedroom, a vacation
      // rental) must never leak into this generic engine's Gemini call mechanism either — a
      // Vision *field name* or *prompt content* mentioning them belongs in a domain module's own
      // vision/ folder, never in this file.
      /\bbedrooms\b/i, /\bbathrooms\b/i, /\bminimumstay\b/i, /\bflyerfacts\b/i, /\banalyzeflyer\b/i,
      /\bvakantieverhuur\b/i, /\bpriceperiod\b/i, /\baream2\b/i,
    ];
    const offenders = [];
    for (const [file, source] of sources) {
      const code = stripComments(source);
      for (const pattern of forbidden) if (pattern.test(code)) offenders.push(`${file}: matches ${pattern}`);
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('no leftover reference to "maroc2stay" (the monorepo this package was copied out of) survives anywhere, including comments', () => {
    const offenders = [];
    for (const [file, source] of sources) {
      if (/maroc2stay/i.test(source)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('every exported type/function name is product-neutral (spot-check against the brief\'s own examples)', () => {
    const all = [...sources.values()].join('\n');
    for (const forbiddenName of ['AccommodationLead', 'MoroccoLead', 'PropertyDiscovery']) {
      assert.ok(!all.includes(forbiddenName), forbiddenName);
    }
  });
});
