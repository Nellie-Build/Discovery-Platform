/**
 * A small, deliberately experimental dedupe config for job vacancies — proof that
 * @discovery-platform/core's `findDuplicateCandidates()` works with a signal set that has no
 * website domain, phone/e-mail, or coordinates signal at all. Deliberately does NOT use
 * title-alone or location-alone as a signal — two unrelated vacancies for "Receptionist" in the
 * same city would otherwise be wrongly flagged as duplicates.
 */
export const VACANCY_DEDUPLICATION_CONFIG = {
  points: {
    /** The exact same crawled page — near-certain the same vacancy listing. */
    sourceUrl: 100,
    /** The same explicit job identifier on the same site ("jobID:123" under another language or
     * alias address): the same vacancy, even when company and title were not extracted. */
    stableJobIdentity: 100,
    /** Same company, same normalized title, same location — strong on its own. */
    companyTitleLocation: 95,
    /** Same company and title but no (or a differing) location — weaker; still worth a
     * "possible duplicate" flag, never a duplicate outright on its own. */
    companyTitle: 50,
  },
  thresholds: {
    /** score >= duplicate: safe to treat as the same vacancy. */
    duplicate: 90,
    /** duplicate > score >= possibleDuplicate: worth a human look. Below: unrelated. */
    possibleDuplicate: 40,
  },
  minScore: 0,
  maxScore: 100,
} as const;
