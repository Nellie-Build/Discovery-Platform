/**
 * A real Vision consumer (job-vacancy posters/flyers) — proving @discovery-platform/core's
 * generic `VisionProvider.analyzeImage` carries no domain knowledge of its own. Every field is
 * exactly what the image could actually show; a provider must omit a field it is not confident
 * about, never guess.
 */
export interface VacancyPosterFacts {
  title?: string;
  company?: string;
  location?: string;
  salary?: string;
  hours?: string;
  contractType?: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  applicationUrl?: string;
  /** The raw text actually read off the image, kept separately from every structured field
   * above — source provenance, never a rewritten description. */
  extractedText?: string;
}

export interface VacancyVisionProvider {
  analyzeVacancyPoster(imageBytes: Uint8Array, mimeType: string): Promise<VacancyPosterFacts>;
}
