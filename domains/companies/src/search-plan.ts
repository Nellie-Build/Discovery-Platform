import { logicOf, type CompanySearchCriteria } from './criteria.js';
import { provinceLabel } from './geography.js';
import { registrableDomain } from './identity.js';
import { ROLE_LABELS, findConcept, type BusinessType, type ConceptKind } from './vocabulary.js';

/**
 * Route A's web searches and which search results are never a company's own site. Targeted queries, each a different
 * angle on the same intent: what + for whom + where, Dutch and English synonyms, the role or kind of company, the branch,
 * every alternative value (OR) or all values together (AND). Never more than `maxQueries` (at most
 * MAX_SEARCH_QUERIES), so external API use stays bounded; the most specific angles come first.
 */
export interface PlannedQuery { query: string; angle: string }
export const DEFAULT_SEARCH_QUERIES = 6;
export const MAX_SEARCH_QUERIES = 12;

/** Words that mark a vocabulary term as English, for the English angle. */
const ENGLISH_WORD = /\b(?:systems?|security|cameras?|camera|surveillance|control|equipment|devices?|products?|installation|installer|maintenance|services?|solutions?|company|companies|healthcare|care|hospitals?|schools?|education|construction|logistics|detection|alarm|burglar|intrusion|software|management|cleaning|renewable|energy|industry|manufacturing)\b/;
const englishTerm = (kind: ConceptKind, value: string | undefined): string | null => {
  if (!value) return null;
  const terms = findConcept(kind, value)?.terms ?? [];
  // English terms come last in a concept; the last (usually the fullest, "cctv systems") is preferred.
  return [...terms].reverse().find(term => ENGLISH_WORD.test(term.toLowerCase()) && /^[a-z ]+$/.test(term.toLowerCase()) && term.toLowerCase() !== value.toLowerCase()) ?? null;
};
/** The kind of company as a search word ("installateur"); a service provider or web shop is not a useful search word. */
const TYPE_WORDS: Partial<Record<BusinessType, string>> = {
  installer: 'installateur', wholesaler: 'groothandel', distributor: 'distributeur', manufacturer: 'fabrikant', b2b_supplier: 'zakelijke leverancier', consultancy: 'adviesbureau',
};
const TYPE_WORDS_EN: Partial<Record<BusinessType, string>> = {
  installer: 'installer', wholesaler: 'wholesaler', distributor: 'distributor', manufacturer: 'manufacturer', b2b_supplier: 'supplier', consultancy: 'consultancy',
};

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

export function buildCompanySearchQueries(c: CompanySearchCriteria, maxQueries = DEFAULT_SEARCH_QUERIES): PlannedQuery[] {
  const where = c.places[0] ?? (c.provinces[0] ? provinceLabel(c.provinces[0]) : null);
  // AND: both values in one query ("camerasystemen toegangscontrolesystemen"); OR: each value is its own angle below.
  const allProducts = logicOf(c, 'products') === 'all' && c.products.length > 1;
  const what = allProducts ? c.products.slice(0, 2).join(' ') : c.products[0] ?? c.specialisations[0] ?? null;
  const service = logicOf(c, 'services') === 'all' && c.services.length > 1 ? c.services.slice(0, 2).join(' ') : c.services[0] ?? null;
  const sectors = logicOf(c, 'customerSectors') === 'all' ? c.customerSectors.slice(0, 2).join(' en ') : c.customerSectors[0];
  const customer = sectors ? `voor ${sectors}` : null;
  const role = c.roles[0] ? ROLE_LABELS[c.roles[0]].toLowerCase() : c.businessTypes.map(type => TYPE_WORDS[type]).find(Boolean) ?? null;
  const extra = c.extra && c.extra.split(/\s+/).length <= 4 ? c.extra : null;
  const [noun, otherNoun] = companyNouns(c.industries[0]);
  const firstSynonym = synonym(c.products[0] ? 'product' : 'specialisation', c.products[0] ?? c.specialisations[0]) ?? synonym('service', c.services[0]);
  // With AND, a synonym of the first value still goes with the second one.
  const whatSynonym = firstSynonym && allProducts ? `${firstSynonym} ${c.products[1]}` : firstSynonym;
  const alternatives = [...(allProducts ? [] : c.products.slice(1)), ...c.specialisations.slice(c.products.length ? 0 : 1), ...c.services.slice(1)].slice(0, 3);
  const typeWords = [...new Set(c.businessTypes.map(type => TYPE_WORDS[type]).filter((w): w is string => Boolean(w) && w !== role))].slice(0, 2);
  const candidates: PlannedQuery[] = [
    // A lone product or specialisation finds shops and articles; "leverancier ..." or the branch noun asks for companies.
    { query: clean([role ?? (what && !service && !customer ? (c.products[0] ? 'leverancier' : noun) : null), what ?? (service ? null : noun), service, customer, where, extra]), angle: 'criteria' },
    { query: clean([whatSynonym ?? (what || service ? null : otherNoun), what ? service : null, customer, where, whatSynonym && !service && !customer ? (c.products[0] ? 'bedrijf' : noun) : null]), angle: 'synonym' },
    // Every alternative value (OR) gets its own query, with the same role, sector and place.
    ...alternatives.slice(0, 1).map(value => ({ query: clean([role ?? (c.products.includes(value) ? 'leverancier' : null), value, c.services.includes(value) ? null : service, customer, where]), angle: 'alternative' })),
    { query: clean([noun, c.specialisations[0] ?? c.services[0], customer, where]), angle: 'branch' },
    // A role angle only when a role or a product is asked for ("leverancier van ..." fits products, not care or construction).
    { query: role || c.products[0] ? clean([role ?? 'leverancier', what ?? service, customer, where]) : '', angle: 'role' },
    { query: clean([c.query, where]), angle: 'query' },
    // Each other kind of company asked for ("installateur" besides "zakelijke leverancier").
    ...typeWords.map(word => ({ query: clean([word, what ?? service, customer, where]), angle: 'business_type' })),
    // English terms find the many Dutch companies that describe themselves in English.
    { query: englishQuery(c, where, allProducts), angle: 'english' },
    ...alternatives.slice(1).map(value => ({ query: clean([role ?? (c.products.includes(value) ? 'leverancier' : null), value, c.services.includes(value) ? null : service, customer, where]), angle: 'alternative' })),
    // A synonym of the customer sector ("zorgorganisaties" for "zorginstellingen"), with the product or service.
    { query: sectorSynonymQuery(c, what ?? service, where), angle: 'sector_synonym' },
    { query: whatSynonym ? clean([whatSynonym, role ?? 'bedrijf', where]) : '', angle: 'synonym_role' },
  ];
  const seen = new Set<string>();
  const out: PlannedQuery[] = [];
  for (const candidate of candidates) {
    const key = candidate.query.toLowerCase();
    // A query of only a place says nothing about what to look for.
    if (!candidate.query || seen.has(key) || candidate.query === where) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= Math.max(1, Math.min(MAX_SEARCH_QUERIES, maxQueries))) break;
  }
  return out;
}

function englishQuery(c: CompanySearchCriteria, where: string | null, allProducts: boolean): string {
  const first = c.products[0] ? englishTerm('product', c.products[0]) : c.specialisations[0] ? englishTerm('specialisation', c.specialisations[0]) : null;
  const product = allProducts && first ? clean([first, englishTerm('product', c.products[1])]) : first;
  const service = c.services[0] ? englishTerm('service', c.services[0]) : null;
  const sector = c.customerSectors[0] ? englishTerm('customer_sector', c.customerSectors[0]) : null;
  const type = c.businessTypes.map(t => TYPE_WORDS_EN[t]).find(Boolean) ?? (c.roles.includes('installer') ? 'installer' : null);
  if (!product && !service) return '';
  return clean([product, service, type ?? (product && !service ? 'supplier' : null), sector ? `for ${sector}` : null, where ? `${where} Netherlands` : c.country === 'NL' ? 'Netherlands' : null]);
}
function sectorSynonymQuery(c: CompanySearchCriteria, what: string | null, where: string | null): string {
  const sector = c.customerSectors[0];
  const other = sector ? synonym('customer_sector', sector) : null;
  return other && what ? clean([what, `voor ${other}`, where]) : '';
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
