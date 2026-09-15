/**
 * A domain-neutral "call the Gemini Vision API, get back JSON, hand it to the domain's own
 * validator" primitive — the exact counterpart to ../scoring/engine.ts and ../dedupe/engine.ts,
 * but for image analysis instead of scoring or duplicate detection. This package has no idea
 * whether an image is a rental flyer, a job-vacancy poster, or anything else: a domain module
 * supplies its own prompt, response schema and parser via `VisionAnalysisConfig<T>`; this file
 * only performs the model call and hands the raw JSON to that parser — it never trusts the
 * model's output itself, and never invents a fact the model did not already claim to see. See
 * domains/vacancies/src/vision/provider.ts for a real config (a job-vacancy poster schema/
 * prompt/parser) built on this exact `createGeminiVisionProvider()`.
 */

/**
 * Everything one domain-specific image analysis needs: what to ask the model for (`prompt`,
 * `responseSchema`) and how to turn its raw JSON into a trustworthy, typed result (`parse`).
 * `parse` must never trust the model's JSON directly — every field the model returns has to be
 * independently re-validated (type, range, allow-list), exactly like any other untrusted
 * upstream response; a field outside that shape is dropped, never thrown or passed through.
 */
export interface VisionAnalysisConfig<T> {
  id: string;
  prompt: string;
  responseSchema: unknown;
  parse: (raw: unknown) => T;
}

export interface VisionProvider {
  analyzeImage<T>(imageBytes: Uint8Array, mimeType: string, config: VisionAnalysisConfig<T>): Promise<T>;
}

export interface GeminiVisionProviderOptions {
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// gemini-2.0-flash was shut down 2026-06-01 — gemini-3.6-flash is the current default. Override
// via the `model` option (callers typically source this from an environment variable of their
// own, e.g. GEMINI_VISION_MODEL) without a code change.
const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Generic safety instructions every domain's Vision prompt should embody, worded here only as a
 * shared reference — not concatenated into any domain's actual prompt automatically, since that
 * would change existing prompt text. A new domain prompt may include/paraphrase this; an
 * existing one keeps its own already-equivalent wording untouched.
 */
export const VISION_SAFETY_INSTRUCTIONS =
  'Use only information that is actually visible or explicitly legible in the image. Never invent, guess, or fill in a missing detail; leave a field you are not sure about as null/unknown. Never make assumptions from how something or someone looks. Respond only with JSON that matches the given schema — the caller will independently re-validate every field regardless.';

/**
 * Gemini implementation of VisionProvider — the only file in this package that knows about
 * Gemini's REST API shape. This function itself has no domain knowledge at all (no field names,
 * no prompt content beyond what a caller's `config.prompt` supplies) so it can be copied,
 * unchanged, into a standalone Discovery Platform repository.
 */
export function createGeminiVisionProvider(apiKey: string, options: GeminiVisionProviderOptions = {}): VisionProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async analyzeImage<T>(imageBytes: Uint8Array, mimeType: string, config: VisionAnalysisConfig<T>): Promise<T> {
      if (!apiKey) throw new Error('GEMINI_API_KEY is niet geconfigureerd.');
      const signal = AbortSignal.timeout(timeoutMs);
      const body = JSON.stringify({
        contents: [{ parts: [{ text: config.prompt }, { inlineData: { mimeType, data: Buffer.from(imageBytes).toString('base64') } }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: config.responseSchema },
      });
      const response = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body, signal,
      });
      if (!response.ok) throw new Error(`Gemini Vision-aanroep mislukt (status ${response.status}).`);
      const payload = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const jsonText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof jsonText !== 'string') throw new Error('Gemini Vision gaf geen bruikbaar antwoord.');
      let raw: unknown;
      try { raw = JSON.parse(jsonText); } catch { throw new Error('Gemini Vision-antwoord was geen geldige JSON.'); }
      return config.parse(raw);
    },
  };
}
