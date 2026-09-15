/**
 * `vacancyVisionConfig` is the small, complete `VisionAnalysisConfig<VacancyPosterFacts>` this
 * domain hands to @discovery-platform/core's generic `VisionProvider.analyzeImage`.
 * `createVacancyVisionProvider` is a small convenience wrapper for callers that would rather
 * call a named method than pass the config around themselves.
 */
import { createGeminiVisionProvider as createGenericGeminiVisionProvider, type GeminiVisionProviderOptions, type VisionAnalysisConfig } from '@discovery-platform/core';
import type { VacancyPosterFacts, VacancyVisionProvider } from './poster-facts.js';
import { VACANCY_POSTER_RESPONSE_SCHEMA, VACANCY_POSTER_PROMPT, parseVacancyPosterFacts } from './config.js';

export const vacancyVisionConfig: VisionAnalysisConfig<VacancyPosterFacts> = {
  id: 'vacancy-poster',
  prompt: VACANCY_POSTER_PROMPT,
  responseSchema: VACANCY_POSTER_RESPONSE_SCHEMA,
  parse: parseVacancyPosterFacts,
};

export function createVacancyVisionProvider(apiKey: string, options: GeminiVisionProviderOptions = {}): VacancyVisionProvider {
  const generic = createGenericGeminiVisionProvider(apiKey, options);
  return {
    analyzeVacancyPoster(imageBytes, mimeType) {
      return generic.analyzeImage(imageBytes, mimeType, vacancyVisionConfig);
    },
  };
}
