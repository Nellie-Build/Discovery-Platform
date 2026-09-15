import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVacancyVisionProvider, parseVacancyPosterFacts, vacancyVisionConfig } from '../dist/index.js';

/**
 * All Gemini calls here are mocked via a local fetchImpl fixture — no real Gemini API calls in
 * this suite (per the fase 1.6 brief). A manual, real-Gemini smoke test is not included here;
 * see this domain's README for how to run one deliberately, outside the normal test suite.
 */
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff]);
function fakeFetch(jsonText) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: jsonText }] } }] }) };
  };
  return { fetchImpl, calls };
}

test('a complete vacature poster yields every explicit field', async () => {
  const response = JSON.stringify({
    title: 'Receptionist', company: 'Riad Zaytoun', location: 'Marrakech',
    salary: '€1.800 - €2.200 per maand', hours: '32-40 uur', contractType: 'vast dienstverband',
    contactPerson: 'Fatima Idrissi', phone: '+212612345678', email: 'jobs@riad-zaytoun.example',
    applicationUrl: 'https://riad-zaytoun.example/vacatures/receptionist',
    extractedText: 'Receptionist gezocht bij Riad Zaytoun, Marrakech...',
  });
  const vision = createVacancyVisionProvider('test-key', { fetchImpl: fakeFetch(response).fetchImpl });
  const facts = await vision.analyzeVacancyPoster(IMAGE_BYTES, 'image/jpeg');
  assert.deepEqual(facts, {
    title: 'Receptionist', company: 'Riad Zaytoun', location: 'Marrakech',
    salary: '€1.800 - €2.200 per maand', hours: '32-40 uur', contractType: 'vast dienstverband',
    contactPerson: 'Fatima Idrissi', phone: '+212612345678', email: 'jobs@riad-zaytoun.example',
    applicationUrl: 'https://riad-zaytoun.example/vacatures/receptionist',
    extractedText: 'Receptionist gezocht bij Riad Zaytoun, Marrakech...',
  });
});

test('a poster without a visible salary leaves that field null/absent, never a guessed figure', async () => {
  const response = JSON.stringify({ title: 'Tuinman', company: 'Villa Amira', location: 'Agadir', salary: null });
  const vision = createVacancyVisionProvider('test-key', { fetchImpl: fakeFetch(response).fetchImpl });
  const facts = await vision.analyzeVacancyPoster(IMAGE_BYTES, 'image/jpeg');
  assert.deepEqual(facts, { title: 'Tuinman', company: 'Villa Amira', location: 'Agadir' });
  assert.ok(!('salary' in facts));
});

test('a poster with only phone/e-mail contact yields exactly those fields', async () => {
  const response = JSON.stringify({ title: 'Kok', phone: '0612345678', email: 'chef@restaurant.example' });
  const vision = createVacancyVisionProvider('test-key', { fetchImpl: fakeFetch(response).fetchImpl });
  const facts = await vision.analyzeVacancyPoster(IMAGE_BYTES, 'image/jpeg');
  assert.deepEqual(facts, { title: 'Kok', phone: '0612345678', email: 'chef@restaurant.example' });
});

test('unknown/unreadable fields stay absent, never a fabricated default', async () => {
  const facts = await createVacancyVisionProvider('test-key', { fetchImpl: fakeFetch('{}').fetchImpl }).analyzeVacancyPoster(IMAGE_BYTES, 'image/jpeg');
  assert.deepEqual(facts, {});
});

test('structured output is independently re-validated, never trusted as-is — an unknown field is dropped', async () => {
  const response = JSON.stringify({ title: 'Kok', seniorityLevel: 'senior', notAKnownField: 'must be dropped' });
  const vision = createVacancyVisionProvider('test-key', { fetchImpl: fakeFetch(response).fetchImpl });
  const facts = await vision.analyzeVacancyPoster(IMAGE_BYTES, 'image/jpeg');
  assert.deepEqual(facts, { title: 'Kok' });
});

test('parseVacancyPosterFacts never invents data: a vague "competitive salary" string is a plain string, not upgraded into a number, and non-object input yields nothing', () => {
  assert.deepEqual(parseVacancyPosterFacts(null), {});
  assert.deepEqual(parseVacancyPosterFacts('a string'), {});
  assert.deepEqual(parseVacancyPosterFacts([1, 2]), {});
  assert.deepEqual(parseVacancyPosterFacts({ salary: 'marktconform' }), { salary: 'marktconform' });
});

test('uses the exact same generic Vision engine any other domain module would (analyzeImage), with its own unrelated prompt/schema', async () => {
  const { fetchImpl, calls } = fakeFetch('{}');
  await createVacancyVisionProvider('test-key', { fetchImpl }).analyzeVacancyPoster(IMAGE_BYTES, 'image/jpeg');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contents[0].parts[0].text, vacancyVisionConfig.prompt);
  assert.doesNotMatch(vacancyVisionConfig.prompt, /vakantieverhuur|bedrooms|bathrooms/i);
});
