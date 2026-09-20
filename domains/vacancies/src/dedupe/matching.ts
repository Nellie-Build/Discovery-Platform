/**
 * Proof that @discovery-platform/core's `findDuplicateCandidates()`/`scoreMatch()` engine
 * carries no domain knowledge of its own — this file has no website domain, phone, e-mail,
 * name+city or coordinate signal at all, only vacancy page-identity signals, and still produces
 * sensible duplicate/possible-duplicate/none decisions through the exact same engine.
 *
 * No vacancy database, CV/candidate matching, or merge action exists yet (see this domain's
 * README) — this only *detects* likely-duplicate vacancy pages; nothing here merges anything.
 */
import { findDuplicateCandidates as findDuplicateCandidatesGeneric, type DedupeThresholds } from '@discovery-platform/core';
import type { VacancyFacts } from '../extract-vacancy.js';
import { VACANCY_DEDUPLICATION_CONFIG as CONFIG } from './config.js';
import { extractVacancyUrlIdentity } from '../job-identity.js';

export type VacancyDuplicateDecision = 'duplicate' | 'possible_duplicate' | 'none';

export interface VacancyDuplicateCandidate {
  vacancyA: VacancyFacts;
  vacancyB: VacancyFacts;
  matchedSignals: string[];
  score: number;
  decision: VacancyDuplicateDecision;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** `company|title[|location]` — null (never matches) unless company AND title are both present;
 * `requireLocation` additionally requires location to be present. Deliberately never keyed on
 * title or location alone. */
function companyTitleKey(vacancy: VacancyFacts, requireLocation: boolean): string | null {
  if (!vacancy.company || !vacancy.title) return null;
  if (requireLocation && !vacancy.location) return null;
  const parts = [normalize(vacancy.company), normalize(vacancy.title)];
  if (requireLocation) parts.push(normalize(vacancy.location as string));
  return parts.join('|');
}

const THRESHOLDS: DedupeThresholds = { strongMatch: CONFIG.thresholds.duplicate, possibleDuplicate: CONFIG.thresholds.possibleDuplicate };

/**
 * Finds likely-duplicate vacancy pages among a batch of extracted `VacancyFacts` (e.g. from one
 * crawl run). `VacancyFacts` has no stable id of its own yet (no vacancy database exists — see
 * "Niet doen" in the fase 1.5 brief), so records are identified by their position in the input
 * array for the duration of one call.
 */
export function findVacancyDuplicates(vacancies: VacancyFacts[]): VacancyDuplicateCandidate[] {
  const indexed = vacancies.map((vacancy, index) => ({ id: String(index), vacancy }));
  const generic = findDuplicateCandidatesGeneric(indexed, {
    idOf: item => item.id,
    exactSignals: [
      { id: 'sourceUrl', points: CONFIG.points.sourceUrl, keyOf: item => item.vacancy.sourceUrl || null },
      { id: 'stableJobIdentity', points: CONFIG.points.stableJobIdentity, keyOf: item => (item.vacancy.sourceUrl ? extractVacancyUrlIdentity(item.vacancy.sourceUrl)?.key ?? null : null) },
      { id: 'companyTitleLocation', points: CONFIG.points.companyTitleLocation, keyOf: item => companyTitleKey(item.vacancy, true) },
      { id: 'companyTitle', points: CONFIG.points.companyTitle, keyOf: item => companyTitleKey(item.vacancy, false) },
    ],
    thresholds: THRESHOLDS,
    min: CONFIG.minScore, max: CONFIG.maxScore,
  });
  return generic.map(c => ({
    vacancyA: c.recordA.vacancy, vacancyB: c.recordB.vacancy,
    matchedSignals: c.matchedSignals, score: c.score,
    decision: c.decision === 'strong_match' ? 'duplicate' : c.decision,
  }));
}
