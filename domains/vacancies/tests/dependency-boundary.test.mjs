import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * domains/vacancies may depend on @discovery-platform/core (that is the whole point — a
 * second, genuinely different domain proving the core is not secretly shaped around any single
 * business). It must never depend on React, Firebase, Firestore, or any other domain package —
 * and, since this package was copied out of a larger monorepo (see docs/), it must never
 * accidentally retain a leftover import back into that monorepo's own namespace or folders.
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
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  return specs;
}

test('dependency boundary: domains/vacancies may depend on discovery-core (and cheerio, for its own type-checking), but nothing from the monorepo it was copied out of', async t => {
  const files = await listTsFiles(SRC_DIR);
  assert.ok(files.length >= 1, 'expected this domain package to actually contain source files');
  const sources = new Map();
  for (const file of files) sources.set(file, await readFile(file, 'utf8'));

  await t.test('imports @discovery-platform/core (the point of this package existing)', () => {
    const usesCore = [...sources.values()].some(source => importSpecifiers(source).includes('@discovery-platform/core'));
    assert.ok(usesCore);
  });

  await t.test('imports nothing from React, a .tsx app, or a leftover path/package from the monorepo this was copied out of', () => {
    const offenders = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        if (/^react(-dom)?(\/|$)/.test(spec) || /[\\/]src[\\/]/.test(spec) || /\.tsx$/.test(spec) ||
            /^@maroc2stay\//.test(spec) || /[\\/]discovery[\\/]src[\\/]/.test(spec)) offenders.push(`${file}: ${spec}`);
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

  await t.test('imports nothing from any other domain package', () => {
    const offenders = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        if (/@discovery-platform\/domain-(?!vacancies)/.test(spec) || /domains[\\/](?!vacancies)/.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('imports only @discovery-platform/core, cheerio types, ts-jobspy (this domain\'s own job-board provider dependency — see src/sources/jobspy-source.ts), and Node built-ins besides its own files', () => {
    const offenders = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith('.') || spec.startsWith('node:') || spec === '@discovery-platform/core' || spec === 'cheerio' || spec === 'ts-jobspy') continue;
        offenders.push(`${file}: ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('no accommodation-domain vocabulary (Morocco, accommodation, AddListing) leaked in — this is a job-vacancy domain', () => {
    const forbidden = [/\bmorocco\b/i, /\bmarokk/i, /\baccommodat/i, /\baddlisting\b/i, /\bclaimready\b/i,
      // fase 1.4: the experimental vacancy score must read as page-completeness, never a
      // ranking of the person applying or the candidate behind the vacancy.
      /\bcandidatequality\b/i, /\bbestvacancy\b/i, /\bcandidateranking\b/i];
    const offenders = [];
    for (const [file, source] of sources) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const pattern of forbidden) if (pattern.test(code)) offenders.push(`${file}: matches ${pattern}`);
    }
    assert.deepEqual(offenders, []);
  });

  await t.test('the experimental vacancy score uses @discovery-platform/core\'s generic runScoring engine, not a private reimplementation', () => {
    const scoringFiles = [...sources.keys()].filter(f => /[\\/]scoring[\\/]/.test(f));
    assert.ok(scoringFiles.length > 0, 'expected this package to contain a scoring/ directory (fase 1.4)');
    const usesEngine = scoringFiles.some(f => importSpecifiers(sources.get(f)).includes('@discovery-platform/core') && /\brunScoring\b/.test(sources.get(f)));
    assert.ok(usesEngine, 'expected the vacancy scoring file to import and call runScoring from discovery-core');
  });

  await t.test('the vacancy score is named vacancyCompletenessScore, not candidateQuality/bestVacancy', () => {
    const all = [...sources.values()].join('\n');
    assert.ok(all.includes('vacancyCompletenessScore'));
    assert.ok(!all.includes('candidateQuality'));
    assert.ok(!all.includes('bestVacancy'));
  });

  await t.test('the vacancy dedupe signals use @discovery-platform/core\'s generic findDuplicateCandidates engine, not a private reimplementation (fase 1.5)', () => {
    const dedupeFiles = [...sources.keys()].filter(f => /[\\/]dedupe[\\/]/.test(f));
    assert.ok(dedupeFiles.length > 0, 'expected this package to contain a dedupe/ directory (fase 1.5)');
    const usesEngine = dedupeFiles.some(f => importSpecifiers(sources.get(f)).includes('@discovery-platform/core') && /\bfindDuplicateCandidates\b/.test(sources.get(f)));
    assert.ok(usesEngine, 'expected the vacancy dedupe file to import and call findDuplicateCandidates from discovery-core');
  });

  await t.test('vacancy dedupe never keys on title or location alone — no website_key/phone/email/nameCity/coordinates signal (from the accommodation domain this was copied alongside) either', () => {
    const dedupeFiles = [...sources.keys()].filter(f => /[\\/]dedupe[\\/]/.test(f));
    const code = dedupeFiles.map(f => sources.get(f)).join('\n');
    for (const forbidden of [/\bwebsite_key\b/i, /\bnameCity\b/, /\bcoordinatesThresholdMeters\b/]) {
      assert.ok(!forbidden.test(code), `unexpected accommodation-domain-shaped signal in vacancy dedupe: ${forbidden}`);
    }
  });

  await t.test('the vacancy poster Vision config uses @discovery-platform/core\'s generic createGeminiVisionProvider/analyzeImage engine, not a private HTTP implementation (fase 1.6)', () => {
    const visionFiles = [...sources.keys()].filter(f => /[\\/]vision[\\/]/.test(f));
    assert.ok(visionFiles.length > 0, 'expected this package to contain a vision/ directory (fase 1.6)');
    const usesEngine = visionFiles.some(f => importSpecifiers(sources.get(f)).includes('@discovery-platform/core') &&
      /\bcreateGeminiVisionProvider\b/.test(sources.get(f)) && /\banalyzeImage\b/.test(sources.get(f)));
    assert.ok(usesEngine, 'expected the vacancy vision provider file to import createGeminiVisionProvider and call analyzeImage from discovery-core');
    const offenders = [];
    for (const file of visionFiles) {
      if (/generativelanguage\.googleapis\.com/.test(sources.get(file))) offenders.push(`${file}: hardcodes the Gemini endpoint itself`);
    }
    assert.deepEqual(offenders, [], 'the Gemini HTTP call itself must live in discovery-core, never be reimplemented in this domain package');
  });

  await t.test('the vacancy poster Vision config has no vacation-rental vocabulary (bedrooms, bathrooms, minimumStay, WhatsApp flyer rules) — this is a job-vacancy poster schema', () => {
    const visionFiles = [...sources.keys()].filter(f => /[\\/]vision[\\/]/.test(f));
    const code = visionFiles.map(f => sources.get(f)).join('\n');
    for (const forbidden of [/\bbedrooms\b/i, /\bbathrooms\b/i, /\bminimumstay\b/i, /\bflyerfacts\b/i, /\bvakantieverhuur\b/i]) {
      assert.ok(!forbidden.test(code), `unexpected accommodation-domain-shaped field in vacancy Vision config: ${forbidden}`);
    }
  });
});
