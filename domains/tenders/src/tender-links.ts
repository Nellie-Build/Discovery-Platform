import { tenderOpportunityStatus, type TenderOpportunityStatus } from './presentation.js';

/**
 * TED <-> TenderNed links: a VIEW over stored records, never a merge. Two records are linked only on an explicitly
 * shared TED publication number: a TED record's own publication numbers, and the number TenderNed states for its
 * publication (`tedPublicationNumber`, from `pbNummerTed`). No title/authority/deadline heuristics. The stored
 * records, their identities and their publication histories stay separate; the combined tender only says, per
 * field, which source a value comes from, so a missing TED deadline is never presented as a TED fact.
 */
export const TED_PUBLICATION_NUMBER = /^\d{1,8}-\d{4}$/;

export interface LinkableTender {
  sourceSystem?: string | null;
  title?: string | null;
  contractingAuthority?: string | null;
  submissionDeadline?: string | null;
  procedureType?: string | null;
  location?: string | null;
  noticeType?: string | null;
  noticeTypeLabel?: string | null;
  sourceUrl?: string | null;
  publications?: Array<{ publicationId: string; tedPublicationNumber?: string | null }>;
}

/** The TED publication numbers a record states explicitly (TED: its own; TenderNed: the stated TED number). */
export function tedPublicationNumbers(tender: LinkableTender): string[] {
  const publications = tender.publications ?? [];
  const numbers = tender.sourceSystem === 'ted' ? publications.map(p => p.publicationId)
    : tender.sourceSystem === 'tenderned' ? publications.map(p => p.tedPublicationNumber)
    : [];
  return [...new Set(numbers.filter((n): n is string => typeof n === 'string' && TED_PUBLICATION_NUMBER.test(n)))];
}

/** Groups of linked tenders, in input order (a group sits where its first member was); an unlinked tender is a group of one. */
export function linkTenders<T extends LinkableTender>(tenders: T[]): T[][] {
  const parent = tenders.map((_, index) => index);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tedRecordOf = new Map<string, number>();
  tenders.forEach((tender, index) => {
    if (tender.sourceSystem === 'ted') for (const number of tedPublicationNumbers(tender)) if (!tedRecordOf.has(number)) tedRecordOf.set(number, index);
  });
  tenders.forEach((tender, index) => {
    if (tender.sourceSystem !== 'tenderned') return;
    for (const number of tedPublicationNumbers(tender)) {
      const other = tedRecordOf.get(number);
      if (other === undefined) continue;
      const [a, b] = [find(index), find(other)];
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const groups = new Map<number, T[]>();
  tenders.forEach((tender, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(tender); else groups.set(root, [tender]);
  });
  return [...groups.values()];
}

export interface SourcedValue { value: string; sourceSystem: string }
export interface CombinedTender<T extends LinkableTender> {
  /** The linked records, TenderNed first (national source, Dutch labels), then TED. */
  members: T[];
  title: SourcedValue | null;
  contractingAuthority: SourcedValue | null;
  submissionDeadline: SourcedValue | null;
  procedureType: SourcedValue | null;
  location: SourcedValue | null;
  status: TenderOpportunityStatus;
}

const RANK: Record<string, number> = { tenderned: 0, ted: 1 };
const rank = (tender: LinkableTender) => RANK[tender.sourceSystem ?? ''] ?? 2;
type TextField = 'title' | 'contractingAuthority' | 'submissionDeadline' | 'procedureType' | 'location';

/** One tender from a linked group: each field is the first source (TenderNed, then TED) that states it, with that source named. */
export function combineLinkedTenders<T extends LinkableTender>(group: T[], now = new Date()): CombinedTender<T> {
  const members = [...group].sort((a, b) => rank(a) - rank(b));
  const pick = (field: TextField): SourcedValue | null => {
    for (const member of members) {
      const value = member[field];
      if (typeof value === 'string' && value) return { value, sourceSystem: member.sourceSystem ?? 'onbekend' };
    }
    return null;
  };
  const deadline = pick('submissionDeadline');
  // An award or cancellation on either source ends the tender; otherwise a known deadline (from any source) decides.
  const statuses = members.map(member => tenderOpportunityStatus({ ...member, submissionDeadline: member.submissionDeadline ?? deadline?.value ?? null }, now));
  const status = statuses.includes('expired') ? 'expired' : statuses.includes('open') ? 'open' : 'unknown';
  return {
    members, title: pick('title'), contractingAuthority: pick('contractingAuthority'), submissionDeadline: deadline,
    procedureType: pick('procedureType'), location: pick('location'), status,
  };
}
