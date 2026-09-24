import { CPV_VOCABULARY } from './cpv-data.js';

export const CPV_SOURCE_URL = 'https://ted.europa.eu/en/simap/cpv';
export const cpvLabel = (code: string): string | undefined => CPV_VOCABULARY.find(row => row[0] === code)?.[1];
const normalize = (s: string) => s.toLocaleLowerCase('nl').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function suggestCpv(text: string, limit = 12): Array<{ code: string; label: string; english: string }> {
  const query = normalize(text.trim());
  if (query.length < 2) return [];
  const explicit = query === 'video' ? ['92111000', '32321200'] : [];
  return CPV_VOCABULARY.filter(([code, nl, en]) => explicit.includes(code) || code.startsWith(query) || normalize(`${nl} ${en}`).includes(query))
    .sort((a, b) => (explicit.includes(a[0]) ? explicit.indexOf(a[0]) : 100) - (explicit.includes(b[0]) ? explicit.indexOf(b[0]) : 100))
    .slice(0, Math.max(0, Math.min(30, limit))).map(([code, label, english]) => ({ code, label, english }));
}

export type TenderOpportunityStatus = 'open' | 'expired' | 'unknown';
/** Deadlines are normalized by the source mappers to Amsterdam local time. A date-only deadline
 * on the current day is unknown; awards/cancellations never become open because of an old deadline. */
export function tenderOpportunityStatus(facts: { submissionDeadline?: string | null; noticeType?: string | null; noticeTypeLabel?: string | null }, now = new Date()): TenderOpportunityStatus {
  const type = `${facts.noticeType ?? ''} ${facts.noticeTypeLabel ?? ''}`;
  if (/\bcan-|\b(?:gunning|gegund|award|cancelled|ingetrokken|rectificatie.*intrekking)\b|^\s*(?:AGO|AOG|VVA)\b/i.test(type)) return 'expired';
  const deadline = facts.submissionDeadline;
  if (!deadline || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(deadline) || Number.isNaN(Date.parse(deadline))) return 'unknown';
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now).replace(' ', 'T');
  if (deadline.length === 10 && deadline === local.slice(0, 10)) return 'unknown';
  return deadline > local ? 'open' : 'expired';
}
