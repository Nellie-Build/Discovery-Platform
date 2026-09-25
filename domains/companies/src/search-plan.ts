import type { CompanySearchCriteria } from './criteria.js';
import { provinceLabel } from './geography.js';
import { registrableDomain } from './identity.js';
import { ROLE_LABELS, findConcept, type ConceptKind } from './vocabulary.js';

/**
 * Route A's web searches and which search results are never a company's own site. A handful of targeted queries,
 * each a different angle on the same intent (what + for whom + where, a synonym, the role, the branch); never more than
 * `maxQueries`, so external API use stays small.
 */
export interface PlannedQuery { query: string; angle: string }

const clean = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
/** A term of the value's concept that is really another word (not a plural or singular of the value), or null. */
function synonym(kind: ConceptKind, value: string | undefined): string | null {
  if (!value) return null;
  const stem = value.toLowerCase().slice(0, 7);
  return findConcept(kind, value)?.terms.find(term => !term.toLowerCase().startsWith(stem) && !/[&']/.test(term) && term.length > 3 && !/^[a-z]+ [a-z]+ [a-z]+ /.test(term)) ?? null;
}
/** Singular company nouns: "...bedrijf", "...organisatie", "...aanbieder", "...verlener". */
const NOUN = /(?:bedrijf|organisatie|aanbieder|verlener)$/;
/** The branch as kinds of company ("zorg" -> "zorgorganisatie", "zorgaanbieder"). */
function companyNouns(industry: string | undefined): string[] {
  if (!industry) return [];
  const terms = findConcept('industry', industry)?.terms.filter(term => NOUN.test(term.toLowerCase())) ?? [];
  return terms.length ? terms.slice(0, 2) : [`${industry} bedrijf`];
}

export function buildCompanySearchQueries(c: CompanySearchCriteria, maxQueries = 4): PlannedQuery[] {
  const where = c.places[0] ?? (c.provinces[0] ? provinceLabel(c.provinces[0]) : null);
  const what = c.products[0] ?? c.specialisations[0] ?? null;
  const service = c.services[0] ?? null;
  const customer = c.customerSectors[0] ? `voor ${c.customerSectors[0]}` : null;
  const role = c.roles[0] ? ROLE_LABELS[c.roles[0]].toLowerCase() : null;
  const extra = c.extra && c.extra.split(/\s+/).length <= 4 ? c.extra : null;
  const [noun, otherNoun] = companyNouns(c.industries[0]);
  const whatSynonym = synonym(c.products[0] ? 'product' : 'specialisation', what ?? undefined) ?? synonym('service', service ?? undefined);
  const candidates: PlannedQuery[] = [
    // A lone product or specialisation finds shops and articles; "leverancier ..." or the branch noun asks for companies.
    { query: clean([role ?? (what && !service && !customer ? (c.products[0] ? 'leverancier' : noun) : null), what ?? (service ? null : noun), service, customer, where, extra]), angle: 'criteria' },
    { query: clean([whatSynonym ?? (what || service ? null : otherNoun), what ? service : null, customer, where, whatSynonym && !service && !customer ? (c.products[0] ? 'bedrijf' : noun) : null]), angle: 'synonym' },
    { query: clean([noun, c.specialisations[0] ?? c.services[0], customer, where]), angle: 'branch' },
    // A role angle only when a role or a product is asked for ("leverancier van ..." fits products, not care or construction).
    { query: role || c.products[0] ? clean([role ?? 'leverancier', what ?? service, customer, where]) : '', angle: 'role' },
    { query: clean([c.query, where]), angle: 'query' },
    { query: c.specialisations[1] ?? c.products[1] ?? c.services[1] ? clean([c.specialisations[1] ?? c.products[1] ?? c.services[1], c.products[1] ? null : noun, where]) : '', angle: 'second_value' },
  ];
  const seen = new Set<string>();
  const out: PlannedQuery[] = [];
  for (const candidate of candidates) {
    const key = candidate.query.toLowerCase();
    // A query of only a place says nothing about what to look for.
    if (!candidate.query || seen.has(key) || candidate.query === where) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= Math.max(1, Math.min(8, maxQueries))) break;
  }
  return out;
}

// ─── Hosts that are never a company's own website ──────────────────────────────────────────────────────────────────

export type ExcludedHostKind = 'directory' | 'review_or_comparison' | 'social' | 'jobs' | 'marketplace' | 'media' | 'government' | 'search_or_maps' | 'reference';
const HOSTS: Array<[ExcludedHostKind, string[]]> = [
  ['directory', ['kvk.nl', 'opencorporates.com', 'oozo.nl', 'drimble.nl', 'bedrijvenpagina.nl', 'cylex.nl', 'cylex-nederland.nl', 'telefoonboek.nl', 'detelefoongids.nl', 'goudengids.nl', 'hotfrog.nl', 'opendi.nl', 'infobel.com', 'openingstijden.nl', 'bedrijfsgegevens.nl', 'allebedrijvenin.nl', 'companyinfo.nl', 'bedrijvenregister.nl', 'bedrijfsinformatie.nl', 'kompass.com', 'europages.nl', 'europages.com', 'dnb.com', 'zoominfo.com', 'crunchbase.com', 'bedrijven.nl', 'nlbedrijven.com', 'zorgkaartnederland.nl', 'zorgaanbieders.nl', 'yelp.com', 'yelp.nl', 'waarmoetikzijn.nl', 'ondernemersplein.nl', 'dun-bradstreet.com', 'bedrijvengids.nl', 'vindjebedrijf.nl', 'nederlandsebedrijven.nl', 'aanbieders.nl', 'bedrijfspagina.nl']],
  ['review_or_comparison', ['trustoo.nl', 'werkspot.nl', 'homedeal.nl', 'offertesite.nl', 'solvari.nl', 'offerte.nl', 'klantenvertellen.nl', 'kiyoh.com', 'trustpilot.com', 'independer.nl', 'vergelijk.nl', 'offerteadviseur.nl', 'thuisvergelijker.nl', 'zoofy.nl']],
  ['social', ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'threads.net']],
  ['jobs', ['indeed.com', 'indeed.nl', 'nationalevacaturebank.nl', 'werk.nl', 'monsterboard.nl', 'jobbird.com', 'glassdoor.com', 'glassdoor.nl', 'intermediair.nl', 'werkzoeken.nl', 'jobat.be']],
  ['marketplace', ['marktplaats.nl', 'amazon.com', 'amazon.nl', 'bol.com', 'ebay.com', 'alibaba.com', 'coolblue.nl']],
  ['media', ['nu.nl', 'nos.nl', 'ad.nl', 'telegraaf.nl', 'rtlnieuws.nl', 'omroepwest.nl', 'rijnmond.nl', 'destentor.nl', 'gelderlander.nl', 'bd.nl', 'ed.nl', 'parool.nl', 'volkskrant.nl', 'nrc.nl', 'trouw.nl', 'fd.nl', 'mt.nl', 'emerce.nl', 'computable.nl', 'dutchcowboys.nl']],
  ['government', ['overheid.nl', 'rijksoverheid.nl', 'government.nl', 'cbs.nl', 'tenderned.nl', 'europa.eu', 'belastingdienst.nl']],
  ['search_or_maps', ['google.com', 'google.nl', 'bing.com', 'openstreetmap.org', 'duckduckgo.com', 'waze.com']],
  ['reference', ['wikipedia.org', 'wikidata.org', 'reddit.com', 'quora.com']],
];
const BY_DOMAIN = new Map(HOSTS.flatMap(([kind, domains]) => domains.map(domain => [domain, kind] as const)));

/** Why a result's host is never a company's own site (a directory, a review site, social media, ...), or null. */
export function excludedHostKind(hostname: string): ExcludedHostKind | null {
  const domain = registrableDomain(hostname);
  if (BY_DOMAIN.has(domain)) return BY_DOMAIN.get(domain)!;
  if (/(?:^|\.)google\.[a-z.]+$/.test(hostname) || /^maps\./.test(hostname)) return 'search_or_maps';
  if (/(?:^|\.)(?:gov|gouv)\.[a-z.]+$/.test(hostname)) return 'government';
  return null;
}
