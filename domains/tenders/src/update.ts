import type { CpvCode, NutsCode, TenderFacts, TenderPublication } from './tender-facts.js';
import { mergeTenderPublications } from './tenderned-map.js';

/**
 * Updating a STORED tender with a newer publication of the same tender (same source system + tender identity).
 * The rule is the one mergeTenderPublications already applies inside a run: every field takes the value of the
 * latest publication that has one, earlier information is kept when a later publication lacks a field, and each
 * publication id is listed once. For the same publication id the freshly fetched values win over the stored ones.
 */
export interface TenderUpdate {
  facts: TenderFacts;
  /** False when the merged facts are identical to the stored ones (nothing to write). */
  changed: boolean;
  /** Publications the stored record did not have yet. */
  newPublications: TenderPublication[];
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);
const nullable = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * A stored record's `domain_data` read back as TenderFacts, or null when it is not a tender with an identity.
 * Tolerant of older shapes: missing lists become empty and missing scalars null, so a sparse stored record is
 * completed by the update instead of rejected.
 */
export function storedTenderFacts(domainData: Record<string, unknown>): TenderFacts | null {
  const sourceSystem = nullable(domainData.sourceSystem);
  const tenderIdentity = nullable(domainData.tenderIdentity);
  if (!sourceSystem || !tenderIdentity) return null;
  const publications = list<TenderPublication>(domainData.publications).filter(p => p && typeof p.publicationId === 'string');
  const publicationId = nullable(domainData.publicationId) ?? publications.at(-1)?.publicationId ?? `stored-${tenderIdentity}`;
  const value = domainData.estimatedValue as TenderFacts['estimatedValue'] | undefined;
  return {
    sourceSystem, tenderIdentity, publicationId,
    title: nullable(domainData.title), contractingAuthority: nullable(domainData.contractingAuthority), referenceNumber: nullable(domainData.referenceNumber),
    noticeType: nullable(domainData.noticeType), noticeTypeLabel: nullable(domainData.noticeTypeLabel), procedureType: nullable(domainData.procedureType),
    contractType: nullable(domainData.contractType), cpvCodes: list<CpvCode>(domainData.cpvCodes), nutsCodes: list<NutsCode>(domainData.nutsCodes),
    location: nullable(domainData.location), publicationDate: nullable(domainData.publicationDate), submissionDeadline: nullable(domainData.submissionDeadline),
    estimatedValue: value && typeof value.amount === 'number' ? value : null, description: nullable(domainData.description),
    sourceUrl: nullable(domainData.sourceUrl) ?? '', publications,
  };
}

/** Structural equality independent of object key order. */
export function tenderFactsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((item, index) => tenderFactsEqual(item, (b as unknown[])[index]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!tenderFactsEqual(left[key], right[key])) return false;
  return true;
}

/**
 * Merges what this run found about a tender (`incoming`, already merged over the run's own publications) into
 * the stored facts. Publications are the unit that is added; a run that brings nothing new (the same
 * publication ids with the same values) yields `changed: false`.
 */
export function updateStoredTender(stored: TenderFacts, incoming: TenderFacts): TenderUpdate {
  // Incoming first: on the same publication id (a tie) the freshly fetched values win.
  const [facts] = mergeTenderPublications([incoming, stored]);
  const known = new Set(stored.publications.map(p => p.publicationId));
  return {
    facts,
    changed: !tenderFactsEqual(facts, stored),
    newPublications: facts.publications.filter(p => !known.has(p.publicationId)),
  };
}
