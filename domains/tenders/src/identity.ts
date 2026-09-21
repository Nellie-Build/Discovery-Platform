import type { TenderFacts } from './tender-facts.js';

/**
 * The identity of a tender across publications and across runs: the source system plus the publisher's
 * tender identity (TenderNed: "kenmerk"). An identity is only unique within one publisher, so the source
 * system is always part of the key. Titles, authorities and dates never take part in it.
 */
export function tenderIdentityKey(facts: Pick<TenderFacts, 'sourceSystem' | 'tenderIdentity'>): string {
  return `${facts.sourceSystem}|${facts.tenderIdentity}`;
}

/** The identity of an already stored record's `domain_data`, or null when it is not a tender with one. */
export function storedTenderIdentityKey(domainData: Record<string, unknown>): string | null {
  const { sourceSystem, tenderIdentity } = domainData;
  return typeof sourceSystem === 'string' && sourceSystem && typeof tenderIdentity === 'string' && tenderIdentity
    ? `${sourceSystem}|${tenderIdentity}` : null;
}

/** Field weights of the (small) completeness score, summing to 100. */
const WEIGHTS: Array<[string, number, (facts: TenderFacts) => boolean]> = [
  ['title', 15, f => Boolean(f.title)],
  ['contractingAuthority', 15, f => Boolean(f.contractingAuthority)],
  ['submissionDeadline', 20, f => Boolean(f.submissionDeadline)],
  ['cpvCodes', 15, f => f.cpvCodes.length > 0],
  ['referenceNumber', 10, f => Boolean(f.referenceNumber)],
  ['location', 10, f => Boolean(f.location)],
  ['description', 10, f => Boolean(f.description)],
  ['estimatedValue', 5, f => f.estimatedValue !== null],
];

export function tenderCompletenessScore(facts: TenderFacts): { score: number; presentSignals: string[]; missingSignals: string[] } {
  const present = WEIGHTS.filter(([, , has]) => has(facts));
  return {
    score: present.reduce((sum, [, weight]) => sum + weight, 0),
    presentSignals: present.map(([name]) => name),
    missingSignals: WEIGHTS.filter(([, , has]) => !has(facts)).map(([name]) => name),
  };
}
