import { SourceError } from '@discovery-platform/core';
import { parseCpvPrefixes, resolvePublicationRange } from './publication-range.js';
import type { TenderFacts } from './tender-facts.js';

/**
 * "Search for tenders": what the user typed (branch, free keywords, country, region, CPV prefixes, publication period)
 * and the web-search queries made from it. All tender vocabulary lives here, never in the core: the core only ever
 * sees the finished query string.
 *
 * Branch and keywords stay separate fields. A query is one tender INTENT word ("aanbesteding", "RFP", ...) combined
 * with the branch, the keywords and the region exactly as typed; nothing is translated or expanded into synonyms.
 */
export interface TenderSearchInput {
  branch: string | null;
  keywords: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2, e.g. "NL". */
  country: string;
  cpvPrefixes: string[];
  publishedFrom: string | null;
  publishedTo: string | null;
}

/** The generic ways an organisation words a procurement, per language, most productive first. */
export const TENDER_INTENTS: Record<'nl' | 'en', readonly string[]> = {
  nl: ['aanbesteding', 'offerteaanvraag', 'opdracht leverancier', 'inkoopkalender', 'marktconsultatie', 'inkoop'],
  en: ['tender', 'request for proposal RFP', 'request for quotation RFQ', 'procurement'],
};

const COUNTRIES: Record<string, { code: string; label: string; alpha3: string; language: 'nl' | 'en' }> = {
  nl: { code: 'NL', label: 'Nederland', alpha3: 'NLD', language: 'nl' }, nederland: { code: 'NL', label: 'Nederland', alpha3: 'NLD', language: 'nl' }, netherlands: { code: 'NL', label: 'Nederland', alpha3: 'NLD', language: 'nl' },
  be: { code: 'BE', label: 'België', alpha3: 'BEL', language: 'nl' }, belgie: { code: 'BE', label: 'België', alpha3: 'BEL', language: 'nl' }, belgium: { code: 'BE', label: 'België', alpha3: 'BEL', language: 'nl' },
  de: { code: 'DE', label: 'Duitsland', alpha3: 'DEU', language: 'en' }, duitsland: { code: 'DE', label: 'Duitsland', alpha3: 'DEU', language: 'en' }, germany: { code: 'DE', label: 'Duitsland', alpha3: 'DEU', language: 'en' },
  fr: { code: 'FR', label: 'Frankrijk', alpha3: 'FRA', language: 'en' }, frankrijk: { code: 'FR', label: 'Frankrijk', alpha3: 'FRA', language: 'en' }, france: { code: 'FR', label: 'Frankrijk', alpha3: 'FRA', language: 'en' },
};

export function resolveCountry(value: unknown): { code: string; label: string; alpha3: string; language: 'nl' | 'en' } {
  if (value === undefined || value === null || value === '') return COUNTRIES.nl;
  const key = String(value).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const country = COUNTRIES[key];
  if (!country) throw new SourceError(`Onbekend land "${String(value).slice(0, 40)}": gebruik Nederland, België, Duitsland of Frankrijk.`, 'invalid_filters');
  return country;
}

const text = (value: unknown, name: string, max = 200): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new SourceError(`${name} moet tekst zijn.`, 'invalid_filters');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/** Validates the filters of a search run. At least a branch or keywords is needed: a search without either has nothing to look for. */
export function parseTenderSearchFilters(filters: Record<string, unknown>): TenderSearchInput {
  const branch = text(filters.branch, 'branch', 80);
  const keywords = text(filters.keywords, 'keywords');
  if (!branch && !keywords) throw new SourceError('Geef een branche of zoektermen op om naar aanbestedingen te zoeken.', 'invalid_filters');
  const country = resolveCountry(filters.country);
  // The period is optional for a web search (a page has no reliable publication date); when given it is validated like the API sources'.
  const hasPeriod = filters.publishedFrom !== undefined || filters.publishedTo !== undefined;
  const range = hasPeriod ? resolvePublicationRange(filters, new Date()) : null;
  return {
    branch, keywords, region: text(filters.region, 'region', 80), country: country.code,
    cpvPrefixes: parseCpvPrefixes(filters.cpvPrefixes),
    publishedFrom: range?.publishedFrom ?? null, publishedTo: range?.publishedTo ?? null,
  };
}

export interface PlannedQuery { query: string; intent: string }

/**
 * The web-search queries for a search: one per tender intent, combined with branch, keywords and region as typed.
 * Intents come in the language of the country first (Dutch for the Netherlands, else English), then the other language,
 * so the first queries are the most natural ones and a small `maxQueries` still covers the main wordings.
 */
export function buildTenderSearchQueries(input: TenderSearchInput, options: { maxQueries?: number } = {}): PlannedQuery[] {
  const maxQueries = Math.max(1, Math.min(options.maxQueries ?? 4, 10));
  const country = resolveCountry(input.country);
  const first = country.language;
  const second = first === 'nl' ? 'en' : 'nl';
  // Interleave so a small budget gets the two main wordings of each language instead of only one language.
  const order: string[] = [];
  const a = TENDER_INTENTS[first], b = TENDER_INTENTS[second];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) order.push(a[i]); if (i < 2 && b[i]) order.push(b[i]); }
  const where = input.region ?? (country.code === 'NL' ? null : country.label);
  const seen = new Set<string>();
  const queries: PlannedQuery[] = [];
  for (const intent of order) {
    const query = [intent, input.branch, input.keywords, where].filter(Boolean).join(' ');
    if (seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    queries.push({ query, intent });
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The words worth matching on: three or more letters/digits, no separators. */
export function searchTerms(...values: (string | null | undefined)[]): string[] {
  return [...new Set(values.flatMap(value => norm(value ?? '').split(/[^a-z0-9]+/)).filter(word => word.length >= 3))];
}

/** A prefix match in either direction, so "schoolgebouwen" finds "schoolgebouw" and "onderhoud" finds "onderhoudswerkzaamheden". */
const termMatches = (word: string, term: string) => word === term || (term.length >= 5 && (word.startsWith(term) || term.startsWith(word)) && word.length >= 4);

/** How many of the search terms appear in `haystack` (whole text, matched per word). */
export function countTermHits(haystack: string, terms: string[]): number {
  const words = norm(haystack).split(/[^a-z0-9]+/).filter(Boolean);
  return terms.filter(term => words.some(word => termMatches(word, term))).length;
}

/**
 * Whether a tender from an API source fits the typed keywords: at least one keyword appears in its title, authority or
 * description. No keywords means everything fits. Only keywords are used (a branch such as "bouw" says little about a
 * title); CPV prefixes are filtered at the source.
 */
export function tenderMatchesKeywords(facts: Pick<TenderFacts, 'title' | 'contractingAuthority' | 'description'>, keywords: string | null): boolean {
  const terms = searchTerms(keywords);
  if (terms.length === 0) return true;
  return countTermHits(`${facts.title ?? ''} ${facts.contractingAuthority ?? ''} ${facts.description ?? ''}`, terms) > 0;
}
