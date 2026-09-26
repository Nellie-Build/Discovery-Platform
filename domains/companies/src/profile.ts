import type {
  Activity, BusinessTypeEvidence, CompanyFacts, CompanyLocation, CompanySource, CriterionMatch, EvidenceQuote, MatchStatus, ServiceArea, SourceType,
} from './company-facts.js';
import { LIST_OF, summarizeCriteria, type CompanySearchCriteria } from './criteria.js';
import { findPlace, provinceLabel } from './geography.js';
import type { PageAnalysis, TermHit } from './page-analysis.js';
import { companyIdentity } from './identity.js';
import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS, COMPANY_ROLES, ROLE_LABELS, expandValue, findConcept, type BusinessType, type CompanyRole, type ConceptKind } from './vocabulary.js';
import { normalizeText, termPattern, uniqueStrings } from './text.js';

/**
 * A company profile from the pages of its own website, and how that profile meets a search. Every activity keeps the
 * pages that show it; a single passing mention stays `weak`. A customer sector only counts when the site says the
 * company supplies or serves it (a sentence like "wij leveren aan ziekenhuizen", or its sector/project pages), never
 * because the word appears somewhere. Geography separates where a company is established from the area it serves.
 */
export interface ProfileContext {
  website: string;
  via: 'website' | 'web_search';
  query: string | null;
  searchProvider: string | null;
  searchSnippet: string | null;
  mode: 'search' | 'website';
  checkedAt: string;
}

const KIND_LIST: Record<ConceptKind, keyof Pick<CompanyFacts, 'industries' | 'products' | 'services' | 'specialisations' | 'customerSectors' | 'roles'>> = {
  industry: 'industries', product: 'products', service: 'services', specialisation: 'specialisations', customer_sector: 'customerSectors', role: 'roles',
};

/** A usable name from a page title: the segment that looks like the brand ("Diensten | Voorbeeld Security" -> "Voorbeeld Security"). */
function brandFromTitle(title: string | null, domainLabel: string): string | null {
  if (!title) return null;
  const segments = title.split(/\s[|\-–—:·•]\s/).map(part => part.trim()).filter(part => part.length >= 2 && part.length <= 80);
  const label = normalizeText(domainLabel).replace(/[^a-z0-9]/g, '');
  return segments.find(segment => normalizeText(segment).replace(/[^a-z0-9]/g, '').includes(label.slice(0, 6))) ?? null;
}

/**
 * Strong evidence is specific: the activity is the subject of a page (its title, a content heading or its address) or the
 * site's own content says it in at least two sentences. A menu item alone, one passing sentence, or a broader related
 * term ("onderwijshuisvesting" for school renovation) is weak. A customer sector needs a sentence saying the company
 * supplies it, or a heading of its sector/project pages.
 */
function strengthOf(hits: TermHit[], kind: ConceptKind): Activity['strength'] {
  if (hits.some(h => h.related)) return 'weak';
  if (kind === 'customer_sector') return hits.some(h => h.supplyContext) ? 'strong' : 'weak';
  const sentenceCount = hits.reduce((sum, h) => sum + h.sentences, 0);
  return hits.some(h => h.structural) || sentenceCount >= 2 ? 'strong' : 'weak';
}

const ROLE_TYPES: Partial<Record<CompanyRole, BusinessType>> = {
  manufacturer: 'manufacturer', wholesaler: 'distributor', distributor: 'distributor',
  service_provider: 'service_provider', installer: 'service_provider', contractor: 'service_provider', consultancy: 'service_provider',
};

/**
 * How the company does business, from its own pages. A consumer web shop shows a shopping cart with prices or product
 * data (or many prices with consumer wording); a business supplier uses business wording (zakelijke klanten, offerte
 * aanvragen, excl. btw, dealers, ...). Manufacturer, distributor and service provider follow from the roles and services
 * found. A company can be several at once (a web shop that also serves businesses).
 */
export function businessTypesOf(pages: PageAnalysis[], lists: Pick<CompanyFacts, 'services' | 'roles'>): BusinessTypeEvidence[] {
  const out = new Map<BusinessType, BusinessTypeEvidence>();
  const add = (evidence: BusinessTypeEvidence) => {
    const existing = out.get(evidence.type);
    if (!existing || (existing.strength === 'weak' && evidence.strength === 'strong')) out.set(evidence.type, evidence);
  };
  const cartPage = pages.find(page => page.commerce?.cart);
  const prices = pages.reduce((sum, page) => sum + (page.commerce?.prices ?? 0), 0);
  const productData = pages.some(page => page.commerce?.productSchema);
  const consumer = [...new Set(pages.flatMap(page => page.commerce?.consumerCues ?? []))];
  const business = [...new Set(pages.flatMap(page => page.commerce?.businessCues ?? []))];
  if ((cartPage && (prices >= 3 || productData)) || (prices >= 5 && consumer.length > 0)) {
    const page = cartPage ?? pages.find(p => (p.commerce?.prices ?? 0) > 0) ?? null;
    add({
      type: 'consumer_webshop', strength: cartPage && (prices >= 3 || productData) ? 'strong' : 'weak',
      signals: [...(cartPage ? ['winkelwagen'] : []), ...(prices ? [`${prices} prijzen`] : []), ...(productData ? ['productgegevens'] : []), ...consumer].slice(0, 8),
      sourceUrl: page?.url ?? null, quote: pages.find(p => p.commerce?.consumerCues.length)?.commerce.quote ?? null,
    });
  }
  if (business.length > 0) {
    const page = pages.find(p => (p.commerce?.businessCues.length ?? 0) > 0) ?? null;
    add({ type: 'b2b_supplier', strength: business.length >= 2 ? 'strong' : 'weak', signals: business.slice(0, 8), sourceUrl: page?.url ?? null, quote: page?.commerce.quote ?? null });
  }
  for (const role of lists.roles) {
    const type = ROLE_TYPES[role.role];
    if (type) add({ type, strength: role.strength, signals: [role.label], sourceUrl: role.evidence[0]?.url ?? null, quote: role.evidence[0]?.quote ?? null });
  }
  const service = lists.services.find(activity => activity.strength === 'strong' && !activity.related);
  if (service) add({ type: 'service_provider', strength: 'strong', signals: [service.label], sourceUrl: service.evidence[0]?.url ?? null, quote: service.evidence[0]?.quote ?? null });
  return BUSINESS_TYPES.map(type => out.get(type)).filter((value): value is BusinessTypeEvidence => Boolean(value));
}

export function buildCompanyProfile(pages: PageAnalysis[], context: ProfileContext): CompanyFacts {
  const { domain, website } = companyIdentity(context.website);
  const home = pages.find(page => page.pageType === 'home') ?? pages[0];
  const org = pages.map(page => page.organization).find(Boolean) ?? null;
  const legal = org?.legalName ?? pages.map(page => page.legalNameInFooter).find(Boolean) ?? null;
  const brand = org?.name ?? pages.map(page => page.siteName).find(Boolean) ?? brandFromTitle(home?.title ?? null, domain.split('.')[0]);
  const name = legal ?? brand ?? null;
  const tradeNames = uniqueStrings([brand, org?.name, ...(org?.alternateNames ?? []), ...pages.map(page => page.siteName)].filter((value): value is string => Boolean(value) && normalizeText(value!) !== normalizeText(name ?? '')), 5);

  // Activities: every page's hits per term spec, with the pages as evidence.
  const byKey = new Map<string, Array<{ hit: TermHit; page: PageAnalysis }>>();
  for (const page of pages) for (const hit of page.hits) byKey.set(hit.key, [...(byKey.get(hit.key) ?? []), { hit, page }]);
  const lists: Pick<CompanyFacts, 'industries' | 'products' | 'services' | 'specialisations' | 'customerSectors' | 'roles'> = { industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [] };
  for (const entries of byKey.values()) {
    const { hit } = entries[0];
    const ordered = [...entries].sort((a, b) => Number(b.hit.supplyContext) - Number(a.hit.supplyContext) || Number(b.hit.structural) - Number(a.hit.structural) || b.hit.count - a.hit.count);
    const evidence: EvidenceQuote[] = ordered.slice(0, 3).map(({ hit: h, page }) => ({ url: page.url, pageType: page.pageType, quote: h.quote.slice(0, 280) }));
    const terms = uniqueStrings(entries.map(e => e.hit.term).filter(Boolean), 5);
    const activity: Activity = {
      kind: hit.kind, conceptId: hit.conceptId, label: hit.label, strength: strengthOf(entries.map(e => e.hit), hit.kind), evidence,
      ...(hit.related ? { related: true } : {}), ...(terms.length ? { matchedTerms: terms } : {}),
    };
    if (hit.kind === 'role') {
      const role = COMPANY_ROLES.find(id => id === hit.conceptId);
      if (role) lists.roles.push({ ...activity, role, label: ROLE_LABELS[role] });
    } else {
      (lists[KIND_LIST[hit.kind]] as Activity[]).push(activity);
    }
  }
  for (const key of Object.keys(lists) as Array<keyof typeof lists>) (lists[key] as Activity[]).sort((a, b) => Number(!b.related) - Number(!a.related) || Number(b.strength === 'strong') - Number(a.strength === 'strong'));

  const locations: CompanyLocation[] = [];
  for (const address of pages.flatMap(page => page.addresses)) {
    if (!locations.some(existing => (existing.postcode ?? existing.city) === (address.postcode ?? address.city)) && locations.length < 10) locations.push(address);
  }
  const serviceAreas: ServiceArea[] = [];
  for (const area of pages.flatMap(page => page.serviceAreas)) {
    if (!serviceAreas.some(existing => existing.scope === area.scope && existing.value === area.value) && serviceAreas.length < 15) serviceAreas.push(area);
  }
  const contactPage = pages.find(page => page.pageType === 'contact');
  const byContactFirst = [...pages].sort((a, b) => Number(b.pageType === 'contact') - Number(a.pageType === 'contact'));
  const kvkPage = pages.find(page => page.statedKvk);
  const sources: CompanySource[] = pages.map(page => ({ url: page.url, type: 'official_website' as SourceType, pageType: page.pageType, title: page.title, checkedAt: context.checkedAt }));

  return {
    identity: domain, name, tradeNames, website, domain,
    description: home?.metaDescription ?? org?.description ?? pages.find(page => page.pageType === 'about')?.metaDescription ?? null,
    ...lists,
    businessTypes: businessTypesOf(pages, lists),
    locations, serviceAreas,
    phone: byContactFirst.map(page => page.phone).find(Boolean) ?? null,
    email: byContactFirst.map(page => page.email).find(Boolean) ?? null,
    contactUrl: contactPage?.url ?? null,
    registration: { kvkNumber: null, statedKvkNumber: kvkPage?.statedKvk ?? null, statedOn: kvkPage?.url ?? null },
    sources,
    lastCheckedAt: context.checkedAt,
    changes: [],
    discovery: { via: context.via, query: context.query, searchProvider: context.searchProvider, searchSnippet: context.searchSnippet, mode: context.mode },
    search: null,
  };
}

/** A public authority (a municipality, province, ministry, water board), which is not a company. */
export function isPublicAuthority(facts: Pick<CompanyFacts, 'name' | 'tradeNames' | 'domain'>): boolean {
  const names = [facts.name, ...facts.tradeNames].filter((value): value is string => Boolean(value));
  return names.some(name => /^(?:gemeente|provincie|ministerie|rijksoverheid|waterschap|hoogheemraadschap|veiligheidsregio|omgevingsdienst)\b/i.test(name.trim()))
    || /(?:^|\.)(?:overheid|rijksoverheid|provincie[a-z-]*)\.nl$/.test(facts.domain);
}

/** Whether the pages look like a company's own site at all (an address, a KvK number, structured organisation data or a contact page). */
export function looksLikeCompanySite(pages: PageAnalysis[]): boolean {
  return pages.some(page => page.addresses.length > 0 || page.statedKvk || page.organization || page.pageType === 'contact' || page.email || page.phone);
}

// ─── Evaluation against a search ────────────────────────────────────────────────────────────────────────────────────

const statusRank: Record<MatchStatus, number> = { confirmed: 2, possible: 1, insufficient: 0 };

function activityMatch(facts: CompanyFacts, kind: ConceptKind, value: string, checkedAt: string, snippet: string | null): CriterionMatch {
  const concept = findConcept(kind, value);
  const list = facts[KIND_LIST[kind]] as Activity[];
  const matchesValue = (activity: Activity) => (concept ? activity.conceptId === concept.id : normalizeText(activity.label) === normalizeText(value))
    // A free value can also be a literal term of an activity found for another concept.
    || expandValue(kind, value).some(term => normalizeText(activity.label) === normalizeText(term));
  const found = list.find(activity => !activity.related && matchesValue(activity));
  const related = found ? undefined : list.find(activity => activity.related && matchesValue(activity));
  const base = { kind, criterion: kind === 'role' ? ROLE_LABELS[value as CompanyRole] ?? value : value, checkedAt };
  if (related) {
    // A broader term is a lead, not proof: "onderwijshuisvesting" does not prove school renovation.
    const evidence = related.evidence[0];
    return {
      ...base, status: 'possible', found: (related.matchedTerms ?? [related.label]).join(', '), sourceUrl: evidence?.url ?? null, sourceType: 'official_website', quote: evidence?.quote ?? null,
      note: `Alleen een verwant begrip gevonden (${(related.matchedTerms ?? []).join(', ') || related.label}); dat bewijst “${base.criterion}” niet.`,
    };
  }
  if (found) {
    const evidence = found.evidence[0];
    const strong = found.strength === 'strong';
    return {
      ...base, status: strong ? 'confirmed' : 'possible', found: found.label, sourceUrl: evidence?.url ?? null, sourceType: 'official_website', quote: evidence?.quote ?? null,
      note: strong ? null : kind === 'customer_sector' ? 'Genoemd op de eigen website, maar niet als sector waaraan het bedrijf levert.' : 'Slechts terloops genoemd op de eigen website.',
    };
  }
  const terms = expandValue(kind, value);
  if (snippet && terms.some(term => termPattern(term).test(normalizeText(snippet)))) {
    return { ...base, status: 'possible', found: value, sourceUrl: null, sourceType: 'search_result', quote: snippet.slice(0, 280), note: 'Alleen in het zoekresultaat gezien, niet op de eigen website bevestigd.' };
  }
  return { ...base, status: 'insufficient', found: null, sourceUrl: null, sourceType: null, quote: null, note: 'Niet gevonden op de onderzochte pagina’s.' };
}

function provinceMatch(facts: CompanyFacts, province: string, checkedAt: string): CriterionMatch {
  const label = provinceLabel(province) ?? province;
  const base = { kind: 'province' as const, criterion: label, checkedAt };
  const located = facts.locations.find(location => location.province === province);
  if (located) return { ...base, status: 'confirmed', found: `Vestiging in ${located.city ?? label}`, sourceUrl: located.sourceUrl, sourceType: 'official_website', quote: [located.address, located.postcode, located.city].filter(Boolean).join(', '), note: null };
  const served = facts.serviceAreas.find(area => (area.scope === 'province' && area.value === province) || (area.scope === 'place' && findPlace(area.value)?.province === province));
  if (served) return { ...base, status: 'confirmed', found: `Werkgebied: ${served.scope === 'province' ? label : served.value}`, sourceUrl: served.sourceUrl, sourceType: 'official_website', quote: served.quote, note: 'Werkgebied volgens de eigen website; geen vestiging in deze provincie bekend.' };
  const national = facts.serviceAreas.find(area => area.scope === 'national');
  if (national) return { ...base, status: 'possible', found: 'Landelijk werkgebied', sourceUrl: national.sourceUrl, sourceType: 'official_website', quote: national.quote, note: `Landelijk actief volgens de eigen website; geen vestiging of expliciet werkgebied in ${label}.` };
  const elsewhere = facts.locations.filter(location => location.city).map(location => location.city).join(', ');
  return { ...base, status: 'insufficient', found: null, sourceUrl: null, sourceType: null, quote: null, note: elsewhere ? `Vestiging(en) in ${elsewhere}; geen werkgebied in ${label} gevonden.` : 'Vestigingsplaats en werkgebied onbekend.' };
}

function placeMatch(facts: CompanyFacts, placeName: string, checkedAt: string): CriterionMatch {
  const place = findPlace(placeName);
  const key = normalizeText(place?.name ?? placeName);
  const base = { kind: 'place' as const, criterion: place?.name ?? placeName, checkedAt };
  const located = facts.locations.find(location => location.city && normalizeText(location.city) === key);
  if (located) return { ...base, status: 'confirmed', found: `Vestiging in ${located.city}`, sourceUrl: located.sourceUrl, sourceType: 'official_website', quote: [located.address, located.postcode, located.city].filter(Boolean).join(', '), note: null };
  const served = facts.serviceAreas.find(area => area.scope === 'place' && normalizeText(area.value) === key);
  if (served) return { ...base, status: 'confirmed', found: `Werkgebied: ${served.value}`, sourceUrl: served.sourceUrl, sourceType: 'official_website', quote: served.quote, note: 'Werkgebied volgens de eigen website; geen vestiging in deze plaats bekend.' };
  const sameProvince = place ? facts.locations.find(location => location.province === place.province) ?? facts.serviceAreas.find(area => area.scope === 'province' && area.value === place.province) : undefined;
  if (sameProvince) return { ...base, status: 'possible', found: 'city' in sameProvince ? `Vestiging in ${sameProvince.city}` : `Werkgebied ${provinceLabel(place!.province)}`, sourceUrl: sameProvince.sourceUrl, sourceType: 'official_website', quote: 'quote' in sameProvince ? sameProvince.quote : [sameProvince.address, sameProvince.postcode, sameProvince.city].filter(Boolean).join(', '), note: `In dezelfde provincie; niet bevestigd voor ${base.criterion}.` };
  const national = facts.serviceAreas.find(area => area.scope === 'national');
  if (national) return { ...base, status: 'possible', found: 'Landelijk werkgebied', sourceUrl: national.sourceUrl, sourceType: 'official_website', quote: national.quote, note: `Landelijk actief; geen vestiging in ${base.criterion} bekend.` };
  return { ...base, status: 'insufficient', found: null, sourceUrl: null, sourceType: null, quote: null, note: 'Vestigingsplaats en werkgebied onbekend of elders.' };
}

function countryMatch(facts: CompanyFacts, country: string, checkedAt: string): CriterionMatch {
  const located = facts.locations.find(location => location.country === country);
  const base = { kind: 'country' as const, criterion: country === 'NL' ? 'Nederland' : country, checkedAt };
  if (located) return { ...base, status: 'confirmed', found: `Adres in ${located.city ?? 'Nederland'}`, sourceUrl: located.sourceUrl, sourceType: 'official_website', quote: [located.address, located.postcode, located.city].filter(Boolean).join(', '), note: null };
  const national = facts.serviceAreas.find(area => area.scope === 'national');
  if (national) return { ...base, status: 'possible', found: 'Landelijk werkgebied', sourceUrl: national.sourceUrl, sourceType: 'official_website', quote: national.quote, note: 'Geen Nederlands adres gevonden; een .nl-domein alleen telt niet als bewijs.' };
  return { ...base, status: 'insufficient', found: null, sourceUrl: null, sourceType: null, quote: null, note: 'Geen adres gevonden; een .nl-domein alleen telt niet als bewijs.' };
}

export interface Evaluation { status: MatchStatus; matches: CriterionMatch[]; excludedBy: string | null }

/**
 * How the company meets each criterion. Several values of one kind are alternatives ("CCTV of toegangscontrole": either
 * product will do), different kinds all apply (product AND customer sector AND region). Overall: `confirmed` when every
 * kind is confirmed by at least one of its values; `insufficient` when no subject kind (what the company does) is at
 * least possible; else `possible`. An exclusion term that
 * the company's own site shows strongly excludes it.
 */
export function evaluateCompany(facts: CompanyFacts, criteria: CompanySearchCriteria, checkedAt: string): Evaluation {
  const snippet = facts.discovery.searchSnippet;
  const matches: CriterionMatch[] = [];
  if (criteria.query) {
    const q = normalizeText(criteria.query);
    const byName = [facts.name, ...facts.tradeNames, facts.domain].some(value => value && normalizeText(value).includes(q));
    matches.push(byName
      ? { kind: 'query', criterion: criteria.query, status: 'confirmed', found: facts.name ?? facts.domain, sourceUrl: facts.website, sourceType: 'official_website', quote: null, note: 'Naam van het bedrijf.', checkedAt }
      : { ...activityMatch(facts, 'product', criteria.query, checkedAt, snippet), kind: 'query' });
  }
  for (const [kind, list] of Object.entries(LIST_OF) as Array<[Exclude<ConceptKind, 'role'>, keyof CompanySearchCriteria]>) {
    for (const value of criteria[list] as string[]) matches.push(activityMatch(facts, kind, value, checkedAt, snippet));
  }
  for (const role of criteria.roles) matches.push(activityMatch(facts, 'role', role, checkedAt, snippet));
  for (const type of criteria.businessTypes ?? []) {
    const evidence = (facts.businessTypes ?? []).find(entry => entry.type === type);
    matches.push(evidence
      ? { kind: 'business_type', criterion: BUSINESS_TYPE_LABELS[type], status: evidence.strength === 'strong' ? 'confirmed' : 'possible', found: evidence.signals.join(', '), sourceUrl: evidence.sourceUrl, sourceType: 'official_website', quote: evidence.quote, note: evidence.strength === 'strong' ? null : 'Enkele aanwijzing op de eigen website.', checkedAt }
      : { kind: 'business_type', criterion: BUSINESS_TYPE_LABELS[type], status: 'insufficient', found: null, sourceUrl: null, sourceType: null, quote: null, note: 'Geen aanwijzingen gevonden op de onderzochte pagina’s.', checkedAt });
  }
  const subject = matches.length;
  if (criteria.places.length === 0 && criteria.provinces.length === 0) matches.push(countryMatch(facts, criteria.country, checkedAt));
  for (const province of criteria.provinces) matches.push(provinceMatch(facts, province, checkedAt));
  for (const place of criteria.places) matches.push(placeMatch(facts, place, checkedAt));

  let excludedBy: string | null = null;
  for (const exclusion of criteria.exclusions) {
    const concept = (['product', 'service', 'specialisation', 'industry', 'customer_sector', 'role'] as ConceptKind[]).map(kind => findConcept(kind, exclusion)).find(Boolean);
    const all = [...facts.industries, ...facts.products, ...facts.services, ...facts.specialisations, ...facts.customerSectors, ...facts.roles];
    const hit = all.find(activity => activity.strength === 'strong' && !activity.related && (concept ? activity.conceptId === concept.id : normalizeText(activity.label) === normalizeText(exclusion)));
    if (hit) { excludedBy = exclusion; break; }
  }

  // The best status per kind: values of one kind are alternatives.
  const best = (list: CriterionMatch[]) => {
    const byKind = new Map<string, MatchStatus>();
    for (const match of list) {
      const current = byKind.get(match.kind);
      if (!current || statusRank[match.status] > statusRank[current]) byKind.set(match.kind, match.status);
    }
    return [...byKind.values()];
  };
  const kinds = best(matches);
  const subjectKinds = best(matches.slice(0, subject));
  const status: MatchStatus = kinds.every(value => value === 'confirmed') ? 'confirmed'
    : subject > 0 && subjectKinds.every(value => value === 'insufficient') ? 'insufficient'
    : kinds.some(value => statusRank[value] > 0) ? 'possible' : 'insufficient';
  return { status, matches, excludedBy };
}

/** The profile with this search's evaluation attached. */
export function withSearch(facts: CompanyFacts, criteria: CompanySearchCriteria, evaluation: Evaluation, checkedAt: string): CompanyFacts {
  return { ...facts, search: { criteria: summarizeCriteria(criteria), status: evaluation.status, matches: evaluation.matches, checkedAt } };
}
