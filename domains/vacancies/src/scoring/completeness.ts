/**
 * A small, deliberately experimental proof that @discovery-platform/core's `runScoring()` works
 * for a domain with rules unrelated to any other domain's business — objective *page*
 * completeness signals only, no ranking of the person behind the vacancy, and not a commercial
 * vacancy-ranking product. Named `vacancyCompletenessScore` deliberately — never a name that
 * reads as ranking a candidate or picking the "best" vacancy.
 */
import { runScoring, type ScoringRule } from '@discovery-platform/core';
import type { VacancyFacts } from '../extract-vacancy.js';

export interface VacancyCompletenessResult {
  score: number;
  presentSignals: string[];
  missingSignals: string[];
}

/** Every signal here is "is this field present on the page", nothing about who the employer or
 * applicant is — the same generic engine any other domain module would also build on. */
const COMPLETENESS_RULES: ScoringRule<VacancyFacts>[] = [
  { id: 'title', evaluate: v => v.title ? { points: 20, reason: 'title' } : null },
  { id: 'company', evaluate: v => v.company ? { points: 15, reason: 'company' } : null },
  { id: 'location', evaluate: v => v.location ? { points: 15, reason: 'location' } : null },
  { id: 'description', evaluate: v => v.description ? { points: 20, reason: 'description' } : null },
  { id: 'salary', evaluate: v => v.salary ? { points: 10, reason: 'salary' } : null },
  { id: 'directContact', evaluate: v => (v.phone || v.email || v.contactPerson) ? { points: 15, reason: 'directContact' } : null },
  { id: 'sourceUrl', evaluate: v => v.sourceUrl ? { points: 5, reason: 'sourceUrl' } : null },
];

export function vacancyCompletenessScore(vacancy: VacancyFacts): VacancyCompletenessResult {
  const result = runScoring(vacancy, COMPLETENESS_RULES);
  const present = new Set(result.contributions.map(c => c.reason));
  return {
    score: result.score,
    presentSignals: COMPLETENESS_RULES.filter(r => present.has(r.id)).map(r => r.id),
    missingSignals: COMPLETENESS_RULES.filter(r => !present.has(r.id)).map(r => r.id),
  };
}
