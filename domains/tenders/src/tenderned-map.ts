import type { SourceItem } from '@discovery-platform/core';
import type { CpvCode, NutsCode, TenderFacts, TenderPublication } from './tender-facts.js';
import { TENDERNED_SOURCE_ID, type TenderNedRaw } from './tenderned-source.js';

/**
 * TenderNed JSON (list entry + optional detail) -> TenderFacts. Every field is optional in the source, so
 * every field is read defensively and left null/empty when absent or of an unexpected type.
 */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max = 500): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;
function day(value: unknown): string | null {
  return typeof value === 'string' ? DATE_PREFIX.exec(value)?.[1] ?? null : null;
}
function coded(value: unknown): { code: string | null; label: string | null } {
  const entry = record(value);
  return { code: text(entry?.code, 40), label: text(entry?.omschrijving, 200) };
}

function readCpv(value: unknown): CpvCode[] {
  if (!Array.isArray(value)) return [];
  const out: CpvCode[] = [];
  for (const entry of value) {
    const item = record(entry);
    const code = text(item?.code, 20)?.split('-')[0] ?? null;
    if (!code || !/^\d{8}$/.test(code) || out.some(existing => existing.code === code)) continue;
    out.push({ code, description: text(item?.omschrijving, 300), main: item?.isHoofdOpdracht === true });
  }
  return out;
}
function readNuts(value: unknown): NutsCode[] {
  if (!Array.isArray(value)) return [];
  const out: NutsCode[] = [];
  for (const entry of value) {
    const item = record(entry);
    const code = text(item?.code, 10);
    if (!code || out.some(existing => existing.code === code)) continue;
    out.push({ code, description: text(item?.omschrijving, 200) });
  }
  return out;
}
/** Only a value the source states explicitly; TenderNed's public JSON has none today. */
function readValue(detail: Record<string, unknown> | null): TenderFacts['estimatedValue'] {
  for (const key of ['geraamdeWaarde', 'geschatteWaarde', 'geschatteOpdrachtwaarde']) {
    const value = detail?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return { amount: value, currency: 'EUR' };
    const object = record(value);
    const amount = object && (typeof object.bedrag === 'number' ? object.bedrag : typeof object.waarde === 'number' ? object.waarde : null);
    if (object && amount !== null && Number.isFinite(amount)) return { amount, currency: text(object.valuta, 3) ?? 'EUR' };
  }
  return null;
}

export function mapTenderNedPublication(item: SourceItem<TenderNedRaw>): TenderFacts | null {
  const { list, detail } = item.raw;
  const publicationId = text(list.publicatieId, 20);
  if (!publicationId) return null;
  const notice = coded(list.typePublicatie);
  const procedure = coded(list.procedure);
  const detailProcedure = coded(detail?.procedureCode);
  const contract = coded(list.typeOpdracht);
  const detailContract = coded(detail?.typeOpdrachtCode);
  const nuts = readNuts(detail?.nutsCodes);
  const publicationDate = day(list.publicatieDatum) ?? day(detail?.publicatieDatum);
  const submissionDeadline = text(list.sluitingsDatum, 40) ?? text(detail?.sluitingsDatum, 40);
  const publication: TenderPublication = {
    publicationId, noticeType: notice.code, noticeTypeLabel: notice.label, publicationDate, submissionDeadline, sourceUrl: item.sourceUrl,
  };
  return {
    sourceSystem: TENDERNED_SOURCE_ID,
    // A publication without a `kenmerk` cannot be tied to other publications: it is its own tender.
    tenderIdentity: text(list.kenmerk, 40) ?? text(detail?.kenmerk, 40) ?? `publicatie-${publicationId}`,
    publicationId,
    title: text(list.aanbestedingNaam) ?? text(detail?.aanbestedingNaam),
    contractingAuthority: text(list.opdrachtgeverNaam) ?? text(detail?.opdrachtgeverNaam),
    referenceNumber: text(detail?.referentieNummer, 100),
    noticeType: notice.code,
    noticeTypeLabel: notice.label,
    procedureType: procedure.label ?? detailProcedure.label,
    contractType: contract.label ?? detailContract.label,
    cpvCodes: readCpv(detail?.cpvCodes),
    nutsCodes: nuts,
    location: [...new Set(nuts.map(entry => entry.description).filter((v): v is string => Boolean(v)))].join(', ') || null,
    publicationDate,
    submissionDeadline,
    estimatedValue: readValue(detail),
    description: text(list.opdrachtBeschrijving, 10_000) ?? text(detail?.opdrachtBeschrijving, 10_000),
    sourceUrl: item.sourceUrl,
    publications: [publication],
  };
}

const compare = (a: TenderPublication, b: TenderPublication) =>
  (a.publicationDate ?? '').localeCompare(b.publicationDate ?? '') || (Number(a.publicationId) - Number(b.publicationId)) || a.publicationId.localeCompare(b.publicationId);

/**
 * Several publications of one tender (same source system + tender identity) become ONE TenderFacts:
 * every field takes the value of the latest publication that has one, `publicationId`/`noticeType`/
 * `publicationDate` describe the latest publication, and `publications` lists all of them (oldest first,
 * each publication id once). Tenders keep the order in which they were first seen.
 */
export function mergeTenderPublications(facts: TenderFacts[]): TenderFacts[] {
  const groups = new Map<string, TenderFacts[]>();
  for (const fact of facts) {
    const key = `${fact.sourceSystem}|${fact.tenderIdentity}`;
    const group = groups.get(key);
    if (group) group.push(fact); else groups.set(key, [fact]);
  }
  return [...groups.values()].map(group => {
    const seen = new Set<string>();
    const publications = group.flatMap(fact => fact.publications).filter(p => !seen.has(p.publicationId) && seen.add(p.publicationId)).sort(compare);
    const order = new Map(publications.map((p, index) => [p.publicationId, index]));
    const latestFirst = [...group].sort((a, b) => (order.get(b.publicationId) ?? 0) - (order.get(a.publicationId) ?? 0));
    const latest = latestFirst[0];
    const pick = <K extends keyof TenderFacts>(key: K, empty: (value: TenderFacts[K]) => boolean): TenderFacts[K] =>
      (latestFirst.find(fact => !empty(fact[key])) ?? latest)[key];
    const isNull = (value: unknown) => value === null;
    const isEmpty = (value: unknown[]) => value.length === 0;
    return {
      ...latest,
      title: pick('title', isNull), contractingAuthority: pick('contractingAuthority', isNull), referenceNumber: pick('referenceNumber', isNull),
      procedureType: pick('procedureType', isNull), contractType: pick('contractType', isNull),
      cpvCodes: pick('cpvCodes', isEmpty), nutsCodes: pick('nutsCodes', isEmpty), location: pick('location', isNull),
      submissionDeadline: pick('submissionDeadline', isNull), estimatedValue: pick('estimatedValue', isNull), description: pick('description', isNull),
      publications,
    };
  });
}
