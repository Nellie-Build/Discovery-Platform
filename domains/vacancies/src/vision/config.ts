/**
 * This domain's own Vision response schema, prompt and parser — a job-vacancy-shaped field set,
 * built on @discovery-platform/core's `VISION_SAFETY_INSTRUCTIONS` shared reference text. A
 * different domain module would supply its own, completely unrelated schema/prompt/parser the
 * same way, on top of the exact same `createGeminiVisionProvider()`.
 */
import { VISION_SAFETY_INSTRUCTIONS } from '@discovery-platform/core';
import type { VacancyPosterFacts } from './poster-facts.js';

/** Only what a vacancy poster/advertisement image can plausibly show; every field is nullable —
 * Gemini is instructed (and, independently, parseVacancyPosterFacts below) to never invent a
 * value, never infer a seniority level, and never report a vague "competitive salary" phrase as
 * an actual figure. */
export const VACANCY_POSTER_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', nullable: true },
    company: { type: 'STRING', nullable: true },
    location: { type: 'STRING', nullable: true },
    salary: { type: 'STRING', nullable: true },
    hours: { type: 'STRING', nullable: true },
    contractType: { type: 'STRING', nullable: true },
    contactPerson: { type: 'STRING', nullable: true },
    phone: { type: 'STRING', nullable: true },
    email: { type: 'STRING', nullable: true },
    applicationUrl: { type: 'STRING', nullable: true },
    extractedText: { type: 'STRING', nullable: true },
  },
  required: [],
};

export const VACANCY_POSTER_PROMPT = `You are a strict data extractor for a job vacancy poster, advertisement, screenshot or photo.
${VISION_SAFETY_INSTRUCTIONS}
Do not infer a seniority level (junior/senior/etc.) that is not explicitly written on the image. Do not report a salary unless an actual figure, range or rate is shown — a vague phrase like "competitive salary" or "market conform" is not a salary and that field must stay null. Do not infer an education requirement that is not explicitly visible. Do not report a company name from an unclear or unreadable logo alone — only when the name is also legible as text.
extractedText is the full text you actually read on the image, unchanged and not rewritten.
Respond only with JSON matching the given schema.`;

function text(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}

/** Never trusts the model's raw JSON blindly — every field is independently re-validated here.
 * A field Gemini invents outside this shape, or with the wrong type, is silently dropped. */
export function parseVacancyPosterFacts(raw: unknown): VacancyPosterFacts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const facts: VacancyPosterFacts = {};
  for (const key of ['title', 'company', 'location', 'salary', 'hours', 'contractType', 'contactPerson', 'phone', 'email', 'applicationUrl'] as const) {
    const value = text(r[key], key === 'applicationUrl' ? 2000 : 300);
    if (value) facts[key] = value;
  }
  const extractedText = text(r.extractedText, 12_000);
  if (extractedText) facts.extractedText = extractedText;
  return facts;
}
