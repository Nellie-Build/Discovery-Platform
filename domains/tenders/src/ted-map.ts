import type { SourceItem } from '@discovery-platform/core';
import type { CpvCode, NutsCode, TenderFacts, TenderPublication } from './tender-facts.js';
import { TED_SOURCE_ID, type TedNoticeRaw } from './ted-source.js';

/**
 * TED notice (Search API fields) -> TenderFacts. Everything is optional in the source and read defensively.
 *
 * Identity: the TENDER is the procurement procedure (`procedure-identifier`, shared by the contract notice, later
 * corrections/modifications and the award notice of one procedure); a notice without one (a prior-information or
 * market-consultation notice) falls back to its `notice-identifier`. The PUBLICATION is the `publication-number`
 * ("646357-2026"). Nothing TenderNed-specific is used or assumed.
 *
 * Lots: the fields of a notice are lists with one entry per lot (and sometimes per buyer). CPV codes and
 * places of performance are merged without duplicates, the deadline is the EARLIEST lot deadline (the first date a
 * bidder must act on), and the estimated value is the procedure-level value, else the sum of the lot values when
 * every lot states one in the same currency, else null.
 */
const LANGUAGE_ORDER = ['nld', 'eng'];

const NOTICE_TYPE_LABELS: Record<string, string> = {
  'cn-standard': 'Aankondiging van een opdracht', 'cn-social': 'Aankondiging van een opdracht (sociaal)', 'cn-desg': 'Aankondiging van een prijsvraag',
  'can-standard': 'Aankondiging van een gegunde opdracht', 'can-social': 'Aankondiging van een gegunde opdracht (sociaal)', 'can-desg': 'Resultaat van een prijsvraag',
  'can-modif': 'Wijziging van een gegunde opdracht', 'pin-only': 'Voorinformatie', 'pin-cfc-standard': 'Voorinformatie met oproep tot mededinging',
  'pin-rtl': 'Voorinformatie (beperkte termijn)', pmc: 'Marktconsultatie', veat: 'Vrijwillige transparantie vooraf', 'cn-standard-corr': 'Rectificatie',
};
const PROCEDURE_LABELS: Record<string, string> = {
  open: 'Openbaar', restricted: 'Niet-openbaar', 'neg-w-call': 'Mededingingsprocedure met onderhandeling', 'neg-wo-call': 'Onderhandelingsprocedure zonder mededinging',
  'comp-dial': 'Concurrentiegerichte dialoog', 'innovation': 'Innovatiepartnerschap', 'oth-mult': 'Overig (meervoudig)', 'oth-single': 'Overig (enkelvoudig)',
};
const CONTRACT_LABELS: Record<string, string> = { works: 'Werken', services: 'Diensten', supplies: 'Leveringen' };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const clean = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};
const strings = (value: unknown): string[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(v => clean(v)).filter((v): v is string => v !== null);
const unique = <T,>(values: T[]) => [...new Set(values)];

/**
 * Picks a language from a `{ languageCode: value }` map: Dutch when present, else English, else the first
 * available. The value is a string or a list of strings; the result is the strings of the chosen language.
 */
export function pickLanguage(map: unknown, max = 500): string[] {
  const languages = record(map);
  if (!languages) return [];
  const usable = (code: string) => { const values = (Array.isArray(languages[code]) ? languages[code] as unknown[] : [languages[code]]).map(v => clean(v, max)).filter((v): v is string => v !== null); return values.length > 0 ? values : null; };
  for (const code of [...LANGUAGE_ORDER, 'mul', ...Object.keys(languages)]) {
    const values = code in languages ? usable(code) : null;
    if (values) return values;
  }
  return [];
}

const DATE = /^(\d{4}-\d{2}-\d{2})/;
const TIME = /^(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?/;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
const AMSTERDAM = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/**
 * "2026-10-16+02:00" + "10:00:00+02:00" -> "2026-10-16T10:00:00"; "2026-11-09Z" + "22:59:00Z" -> "2026-11-09T23:59:00": the
 * deadline in Dutch local time (Europe/Amsterdam) without offset, the form TenderNed publishes, so the two sources'
 * deadlines compare. A date without a time stays a date; a time without any offset is taken as already local.
 */
function deadlines(dates: unknown, times: unknown): string[] {
  const dateList = strings(dates);
  const timeList = strings(times);
  const out: string[] = [];
  dateList.forEach((entry, index) => {
    const date = DATE.exec(entry)?.[1];
    if (!date) return;
    const time = TIME.exec(timeList[index] ?? timeList[0] ?? '');
    if (!time) { out.push(date); return; }
    const offset = time[2] ?? OFFSET.exec(entry)?.[1];
    if (!offset) { out.push(`${date}T${time[1]}`); return; }
    const instant = new Date(`${date}T${time[1]}${offset}`);
    out.push(Number.isNaN(instant.getTime()) ? `${date}T${time[1]}` : AMSTERDAM.format(instant).replace(' ', 'T'));
  });
  return out;
}

const amount = (value: unknown): number | null => {
  const text = clean(value, 40);
  if (text === null) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

function estimatedValue(notice: Record<string, unknown>): TenderFacts['estimatedValue'] {
  const procedure = amount(notice['estimated-value-proc']);
  const procedureCurrency = strings(notice['estimated-value-cur-proc'])[0];
  if (procedure !== null && procedureCurrency) return { amount: procedure, currency: procedureCurrency };
  const values = (Array.isArray(notice['estimated-value-lot']) ? notice['estimated-value-lot'] as unknown[] : []).map(amount);
  const currencies = strings(notice['estimated-value-cur-lot']);
  if (values.length === 0 || values.some(v => v === null) || currencies.length === 0 || unique(currencies).length !== 1) return null;
  return { amount: (values as number[]).reduce((sum, v) => sum + v, 0), currency: currencies[0] };
}

/** The places of performance that are NUTS codes (three-letter entries are countries). */
function nutsCodes(value: unknown): NutsCode[] {
  return unique(strings(value).filter(code => /^[A-Z]{2}[A-Z0-9]{1,3}$/.test(code) && !/^[A-Z]{3}$/.test(code))).map(code => ({ code, description: null }));
}
function cpvCodes(value: unknown): CpvCode[] {
  return unique(strings(value).filter(code => /^\d{8}$/.test(code))).map((code, index) => ({ code, description: null, main: index === 0 }));
}

export function mapTedNotice(item: SourceItem<TedNoticeRaw>): TenderFacts | null {
  const notice = item.raw;
  const publicationNumber = clean(notice['publication-number'], 20);
  if (!publicationNumber) return null;
  const type = clean(notice['notice-type'], 40);
  const publicationDate = DATE.exec(clean(notice['publication-date'], 40) ?? '')?.[1] ?? null;
  const deadline = deadlines(notice['deadline-receipt-tender-date-lot'], notice['deadline-receipt-tender-time-lot']).sort()[0] ?? null;
  const nuts = nutsCodes(notice['place-of-performance']);
  const procedureCode = clean(notice['procedure-type'], 40);
  const contract = unique(strings(notice['contract-nature'])).map(code => CONTRACT_LABELS[code] ?? code);
  const publication: TenderPublication = {
    publicationId: publicationNumber, noticeType: type, noticeTypeLabel: type ? NOTICE_TYPE_LABELS[type] ?? type : null,
    publicationDate, submissionDeadline: deadline, sourceUrl: item.sourceUrl,
  };
  const title = pickLanguage(notice['title-proc'])[0] ?? pickLanguage(notice['title-lot'])[0] ?? pickLanguage(notice['notice-title'])[0] ?? null;
  return {
    sourceSystem: TED_SOURCE_ID,
    tenderIdentity: clean(notice['procedure-identifier'], 60) ?? clean(notice['notice-identifier'], 60) ?? `publicatie-${publicationNumber}`,
    publicationId: publicationNumber,
    title,
    contractingAuthority: unique(pickLanguage(notice['buyer-name'])).join('; ') || null,
    referenceNumber: null,
    noticeType: type,
    noticeTypeLabel: publication.noticeTypeLabel,
    procedureType: procedureCode ? PROCEDURE_LABELS[procedureCode] ?? procedureCode : null,
    contractType: contract.join(' / ') || null,
    cpvCodes: cpvCodes(notice['classification-cpv']),
    nutsCodes: nuts,
    // TED gives codes, not place names, so there is no readable location; the NUTS codes carry the place.
    location: null,
    publicationDate,
    submissionDeadline: deadline,
    estimatedValue: estimatedValue(notice),
    description: pickLanguage(notice['description-proc'], 10_000)[0] ?? null,
    sourceUrl: item.sourceUrl,
    publications: [publication],
  };
}
