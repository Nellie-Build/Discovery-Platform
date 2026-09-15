import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeminiVisionProvider } from '../dist/vision/provider.js';

const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff]);
function fakeFetch(jsonText) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: jsonText }] } }] }) };
  };
  return { fetchImpl, calls };
}
const genericConfig = {
  id: 'test-config',
  prompt: 'Describe what you see.',
  responseSchema: { type: 'OBJECT', properties: { note: { type: 'STRING', nullable: true } }, required: [] },
  parse: raw => (raw && typeof raw === 'object' && typeof raw.note === 'string' ? { note: raw.note } : {}),
};

test('createGeminiVisionProvider defaults to gemini-3.6-flash when no model is configured', async () => {
  const { fetchImpl, calls } = fakeFetch('{}');
  const vision = createGeminiVisionProvider('test-key', { fetchImpl });
  await vision.analyzeImage(IMAGE_BYTES, 'image/jpeg', genericConfig);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
});

test('createGeminiVisionProvider honors an overridden model', async () => {
  const { fetchImpl, calls } = fakeFetch('{}');
  const vision = createGeminiVisionProvider('test-key', { model: 'gemini-9.9-flash', fetchImpl });
  await vision.analyzeImage(IMAGE_BYTES, 'image/png', genericConfig);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-9.9-flash:generateContent');
});

test('analyzeImage sends the image as inline base64 data with its exact mimeType, the caller\'s own prompt/schema, and requests strict JSON', async () => {
  const { fetchImpl, calls } = fakeFetch('{}');
  const vision = createGeminiVisionProvider('test-key', { fetchImpl });
  await vision.analyzeImage(IMAGE_BYTES, 'image/webp', genericConfig);
  const body = JSON.parse(calls[0].init.body);
  const parts = body.contents[0].parts;
  assert.equal(parts[0].text, genericConfig.prompt);
  assert.equal(parts[1].inlineData.mimeType, 'image/webp');
  assert.equal(parts[1].inlineData.data, Buffer.from(IMAGE_BYTES).toString('base64'));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, genericConfig.responseSchema);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
});

test('analyzeImage hands the model\'s raw JSON to the caller\'s own parse(), never trusting it directly', async () => {
  const { fetchImpl } = fakeFetch(JSON.stringify({ note: 'hello', ignoredField: 'must be dropped by the domain parser' }));
  const vision = createGeminiVisionProvider('test-key', { fetchImpl });
  const result = await vision.analyzeImage(IMAGE_BYTES, 'image/jpeg', genericConfig);
  assert.deepEqual(result, { note: 'hello' });
});

test('two different configs against the same provider get their own prompt/schema and their own parse(), independently', async () => {
  const { fetchImpl } = fakeFetch(JSON.stringify({ note: 'x', other: 'y' }));
  const vision = createGeminiVisionProvider('test-key', { fetchImpl });
  const configA = { id: 'a', prompt: 'A', responseSchema: {}, parse: () => ({ kind: 'a' }) };
  const configB = { id: 'b', prompt: 'B', responseSchema: {}, parse: () => ({ kind: 'b' }) };
  assert.deepEqual(await vision.analyzeImage(IMAGE_BYTES, 'image/jpeg', configA), { kind: 'a' });
  assert.deepEqual(await vision.analyzeImage(IMAGE_BYTES, 'image/jpeg', configB), { kind: 'b' });
});

test('analyzeImage rejects a non-OK response and a malformed JSON answer without ever throwing the raw upstream body', async () => {
  const notOk = createGeminiVisionProvider('test-key', { fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(notOk.analyzeImage(IMAGE_BYTES, 'image/jpeg', genericConfig), /Gemini Vision-aanroep mislukt \(status 503\)/);

  const malformed = createGeminiVisionProvider('test-key', { fetchImpl: fakeFetch('not json').fetchImpl });
  await assert.rejects(malformed.analyzeImage(IMAGE_BYTES, 'image/jpeg', genericConfig), /geen geldige JSON/);
});

test('analyzeImage refuses to call Gemini at all when no API key is configured', async () => {
  const vision = createGeminiVisionProvider('', { fetchImpl: async () => { throw new Error('must never be called'); } });
  await assert.rejects(vision.analyzeImage(IMAGE_BYTES, 'image/jpeg', genericConfig), /GEMINI_API_KEY is niet geconfigureerd/);
});
