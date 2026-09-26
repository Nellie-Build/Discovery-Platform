import { CONCEPTS, COMPANY_ROLES, ROLE_LABELS, KIND_LABELS, CONCEPT_KINDS, BUSINESS_TYPES, BUSINESS_TYPE_LABELS, conceptsOf, expandValue, findConcept, type BusinessType, type CompanyRole, type Concept, type ConceptKind } from './vocabulary.js';
import { NETHERLANDS, findPlace, findProvince, geographyNames, provinceLabel, COUNTRIES } from './geography.js';
import { normalizeText, termPattern, uniqueStrings } from './text.js';

/**
 * Search criteria for companies, and the transparent interpretation of a description in plain language into those
 * criteria. Browser-safe: the Web App shows the interpretation while the user types and lets them edit it; the server
 * validates whatever comes back. No AI and no paid service: vocabulary terms, place names and a few context rules.
 * A later LLM-based interpreter can produce the same `CompanySearchCriteria` shape.
 */
export { CONCEPTS, COMPANY_ROLES, ROLE_LABELS, KIND_LABELS, CONCEPT_KINDS, BUSINESS_TYPES, BUSINESS_TYPE_LABELS, conceptsOf, expandValue, findConcept, NETHERLANDS, provinceLabel, findProvince, findPlace };
export type { BusinessType, CompanyRole, Concept, ConceptKind };

/** Lists whose values can be combined as alternatives (`any`, the default) or all be required (`all`). */
export type LogicList = 'industries' | 'products' | 'services' | 'specialisations' | 'customerSectors' | 'roles' | 'businessTypes';
export const LOGIC_LISTS: readonly LogicList[] = ['industries', 'products', 'services', 'specialisations', 'customerSectors', 'roles', 'businessTypes'];
export type Logic = 'any' | 'all';

export interface CompanySearchCriteria {
  /** A company name or general search term. */
  query: string | null;
  industries: string[];
  products: string[];
  services: string[];
  specialisations: string[];
  customerSectors: string[];
  roles: CompanyRole[];
  /** How the company does business (business supplier, consumer web shop, ...); empty = any, web shops included. */
  businessTypes: BusinessType[];
  /** Business types a company must NOT have (e.g. "uitsluitend zakelijk": no consumer web shops). */
  excludedBusinessTypes: BusinessType[];
  /**
   * Per list: are its values alternatives (`any`: at least one, the default and what searches saved before this field
   * existed mean) or all required (`all`)? Different lists are always all required.
   */
  logic: Partial<Record<LogicList, Logic>>;
  /** ISO country code; the first version supports NL. */
  country: string;
  /** Province ids (NL-ZH). */
  provinces: string[];
  /** Place names. */
  places: string[];
  /** Additional wishes in free text (searched literally, never used as a hard criterion). */
  extra: string | null;
  /** Terms that exclude a company when its own site shows them strongly. */
  exclusions: string[];
  /** The original description, kept for provenance. */
  description: string | null;
}

export const EMPTY_CRITERIA: CompanySearchCriteria = {
  query: null, industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [], businessTypes: [], excludedBusinessTypes: [],
  logic: {}, country: 'NL', provinces: [], places: [], extra: null, exclusions: [], description: null,
};

/** The criteria list for each vocabulary kind (roles are ids, the rest are free values). */
export const LIST_OF: Record<Exclude<ConceptKind, 'role'>, 'industries' | 'products' | 'services' | 'specialisations' | 'customerSectors'> = {
  industry: 'industries', product: 'products', service: 'services', specialisation: 'specialisations', customer_sector: 'customerSectors',
};
/** The list a match kind belongs to (for the and/or logic). */
export const LIST_OF_KIND: Record<string, LogicList | undefined> = {
  industry: 'industries', product: 'products', service: 'services', specialisation: 'specialisations', customer_sector: 'customerSectors', role: 'roles', business_type: 'businessTypes',
};

export const MATCH_STATUS_LABELS = { confirmed: 'Bevestigde match', possible: 'Mogelijke match', insufficient: 'Onvoldoende bewijs' } as const;

export class CriteriaError extends Error {}

const MAX_VALUES = 10;
const text = (value: unknown, max: number, name: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) throw new CriteriaError(`${name}: tekst van hoogstens ${max} tekens.`);
  return value.replace(/\s+/g, ' ').trim() || null;
};
const list = (value: unknown, name: string): string[] => {
  if (value === undefined || value === null) return [];
  const items = typeof value === 'string' ? value.split(/[,;\n]/) : value;
  if (!Array.isArray(items) || items.length > 30) throw new CriteriaError(`${name}: een lijst van hoogstens ${MAX_VALUES} waarden.`);
  const clean = items.map(item => text(item, 80, name)).filter((item): item is string => item !== null);
  if (clean.length > MAX_VALUES) throw new CriteriaError(`${name}: hoogstens ${MAX_VALUES} waarden.`);
  return uniqueStrings(clean, MAX_VALUES);
};
const businessTypeList = (value: unknown, name: string): BusinessType[] => [...new Set(list(value, name).map(item => {
  const known = BUSINESS_TYPES.find(id => id === item) ?? (Object.entries(BUSINESS_TYPE_LABELS).find(([, label]) => normalizeText(label) === normalizeText(item))?.[0] as BusinessType | undefined);
  if (!known) throw new CriteriaError(`Onbekend type bedrijf "${item.slice(0, 40)}".`);
  return known;
}))];

/** Validates criteria from a request; throws CriteriaError with a message a user can act on. */
export function parseCriteria(input: Record<string, unknown>): CompanySearchCriteria {
  const country = (text(input.country, 40, 'Land') ?? 'NL');
  const countryCode = /^nl$/i.test(country) || NETHERLANDS.aliases.some(alias => normalizeText(alias) === normalizeText(country)) ? 'NL' : null;
  if (!countryCode || !COUNTRIES[countryCode]) throw new CriteriaError('Deze versie zoekt alleen naar bedrijven in Nederland.');
  const roles = list(input.roles, 'Bedrijfsrol').map(role => {
    const known = COMPANY_ROLES.find(id => id === role) ?? (findConcept('role', role)?.id as CompanyRole | undefined);
    if (!known) throw new CriteriaError(`Onbekende bedrijfsrol "${role.slice(0, 40)}".`);
    return known;
  });
  const provinces = list(input.provinces, 'Provincie').map(value => {
    const province = findProvince(value) ?? findProvince(`provincie ${value}`);
    if (!province) throw new CriteriaError(`Onbekende provincie "${value.slice(0, 40)}".`);
    return province.id;
  });
  const logic: Partial<Record<LogicList, Logic>> = {};
  if (input.logic !== undefined && input.logic !== null) {
    if (typeof input.logic !== 'object' || Array.isArray(input.logic)) throw new CriteriaError('De zoeklogica is ongeldig.');
    for (const [key, value] of Object.entries(input.logic as Record<string, unknown>)) {
      if (!LOGIC_LISTS.includes(key as LogicList) || (value !== 'any' && value !== 'all')) throw new CriteriaError(`Ongeldige zoeklogica voor "${key.slice(0, 30)}": kies "any" (één van) of "all" (alle).`);
      if (value === 'all') logic[key as LogicList] = 'all';
    }
  }
  return {
    query: text(input.query, 120, 'Zoekterm'),
    industries: list(input.industries, 'Branche'),
    products: list(input.products, 'Producten'),
    services: list(input.services, 'Diensten'),
    specialisations: list(input.specialisations, 'Specialisaties'),
    customerSectors: list(input.customerSectors, 'Afnemerssector'),
    roles: [...new Set(roles)],
    businessTypes: businessTypeList(input.businessTypes, 'Type bedrijf'),
    excludedBusinessTypes: businessTypeList(input.excludedBusinessTypes, 'Uitgesloten type bedrijf'),
    logic,
    country: countryCode,
    provinces: [...new Set(provinces)],
    places: list(input.places, 'Plaats').map(place => findPlace(place)?.name ?? place),
    extra: text(input.extra, 300, 'Aanvullende wensen'),
    exclusions: list(input.exclusions, 'Uitsluitingen'),
    description: text(input.description, 600, 'Beschrijving'),
  };
}

/** Whether the criteria say anything about WHAT to look for (a place alone is not a search). */
export const hasSubject = (c: CompanySearchCriteria) =>
  Boolean(c.query) || [c.industries, c.products, c.services, c.specialisations, c.customerSectors, c.roles].some(values => values.length > 0);

/** `any` unless the list says `all` (older criteria have no logic at all: alternatives, as before). */
export const logicOf = (c: Pick<CompanySearchCriteria, 'logic'>, listName: LogicList): Logic => c.logic?.[listName] ?? 'any';

/**
 * Criteria that contradict each other or cannot be met as written, as messages a user can act on. Nothing is changed
 * silently: the search runs with the criteria as given, and these are shown next to the interpretation.
 */
export function criteriaWarnings(c: CompanySearchCriteria): string[] {
  const warnings: string[] = [];
  const included = [...c.industries, ...c.products, ...c.services, ...c.specialisations, ...c.customerSectors];
  for (const exclusion of c.exclusions) {
    const key = normalizeText(exclusion);
    const clash = included.find(value => normalizeText(value) === key
      || CONCEPT_KINDS.some(kind => { const a = findConcept(kind, value); const b = findConcept(kind, exclusion); return Boolean(a && b && a.id === b.id); }));
    if (clash) warnings.push(`"${exclusion}" wordt zowel gezocht als uitgesloten; dan blijft er geen bedrijf over dat eraan voldoet.`);
  }
  for (const type of c.businessTypes ?? []) {
    if ((c.excludedBusinessTypes ?? []).includes(type)) warnings.push(`"${BUSINESS_TYPE_LABELS[type]}" is zowel gevraagd als uitgesloten.`);
  }
  if (c.places.length && c.provinces.length) {
    for (const placeName of c.places) {
      const place = findPlace(placeName);
      if (place && !c.provinces.includes(place.province)) warnings.push(`${place.name} ligt niet in ${c.provinces.map(id => provinceLabel(id) ?? id).join(' of ')}; een bedrijf moet dan aan beide plaatsen voldoen.`);
    }
  }
  if (logicOf(c, 'businessTypes') === 'all' && (c.businessTypes ?? []).includes('consumer_webshop') && (c.businessTypes ?? []).includes('b2b_supplier')) {
    warnings.push('Zowel "consumentenwebwinkel" als "zakelijke leverancier" verplicht: alleen bedrijven die beide zijn komen in aanmerking.');
  }
  return warnings;
}

/** A one-line Dutch summary, e.g. "Product: camerasystemen of toegangscontrole · Dienst: installatie · Zuid-Holland". */
export function summarizeCriteria(c: CompanySearchCriteria): string {
  const parts: string[] = [];
  if (c.query) parts.push(`Zoekterm: ${c.query}`);
  const add = (label: string, values: string[], listName: LogicList) => {
    if (values.length) parts.push(`${label}: ${values.join(logicOf(c, listName) === 'all' ? ' én ' : ' of ')}`);
  };
  add('Branche', c.industries, 'industries'); add('Product', c.products, 'products'); add('Dienst', c.services, 'services');
  add('Specialisatie', c.specialisations, 'specialisations'); add('Afnemer', c.customerSectors, 'customerSectors');
  add('Rol', c.roles.map(role => ROLE_LABELS[role]), 'roles'); add('Type', (c.businessTypes ?? []).map(type => BUSINESS_TYPE_LABELS[type]), 'businessTypes');
  if ((c.excludedBusinessTypes ?? []).length) parts.push(`Geen: ${c.excludedBusinessTypes.map(type => BUSINESS_TYPE_LABELS[type]).join(', ')}`);
  const where = [...c.places, ...c.provinces.map(id => provinceLabel(id) ?? id)];
  parts.push(where.length ? where.join(', ') : 'Nederland');
  if (c.exclusions.length) parts.push(`Niet: ${c.exclusions.join(', ')}`);
  return parts.join(' · ');
}

// ─── Explanation of a result ────────────────────────────────────────────────────────────────────────────────────────

/** The per-criterion outcome as stored with a company (see company-facts.ts CriterionMatch); only what the explanation needs. */
export interface ExplainableMatch { kind: string; criterion: string; status: 'confirmed' | 'possible' | 'insufficient'; found: string | null; basis?: 'offering' | 'reference' | 'mention' }
const STATUS_WORD = { confirmed: 'Bevestigd', possible: 'Mogelijk', insufficient: 'Onbekend' } as const;
const KIND_PHRASE: Record<string, (criterion: string) => string> = {
  industry: c => `actief in ${c}`, product: c => `levert ${c}`, service: c => `voert ${c} uit`, specialisation: c => `gespecialiseerd in ${c}`,
  customer_sector: c => `levert aan ${c}`, role: c => `is ${c.toLowerCase()}`, business_type: c => `is ${c.toLowerCase()}`, query: c => `zoekterm ${c}`,
  country: c => `gevestigd of actief in ${c}`, province: c => `werkgebied ${c}`, place: c => `werkgebied ${c}`,
};

/**
 * A plain explanation of why a company does or does not fit, criterion by criterion ("Bevestigd: levert camerasystemen.
 * Mogelijk: levert aan zorginstellingen. Onbekend: werkgebied Zuid-Holland."). No scores, no percentages.
 */
export function explainMatches(matches: ExplainableMatch[]): string {
  return matches.map(match => {
    // An excluded kind of company that may apply is a warning, not a fit.
    if (match.kind === 'excluded_business_type') return `Let op: mogelijk ${match.criterion.replace(/^geen /, '')}.`;
    if (match.kind === 'customer_sector' && match.status !== 'insufficient' && match.basis === 'reference') return `${STATUS_WORD[match.status]}: referentieproject bij ${match.criterion}.`;
    return `${STATUS_WORD[match.status]}: ${(KIND_PHRASE[match.kind] ?? (c => c))(match.criterion)}.`;
  }).join(' ');
}

// ─── Interpretation of a plain-language description ─────────────────────────────────────────────────────────────────

export interface RecognizedPhrase {
  phrase: string;
  kind: ConceptKind | 'business_type' | 'excluded_business_type' | 'country' | 'province' | 'place' | 'exclusion' | 'logic';
  value: string;
  /** Not named by the user but derived (the usual branch of a named product/service). */
  inferred?: boolean;
}
export interface Interpretation {
  criteria: CompanySearchCriteria;
  recognized: RecognizedPhrase[];
  unrecognized: string[];
  /** Contradictions and choices the user should check (e.g. how "en" was read). */
  warnings: string[];
}

/** Words before a sector that make it a customer sector ("levert AAN ziekenhuizen", "ervaring MET scholen", "VOOR hotels", "VIA distributeurs"). */
const SUPPLY_CUE = /(?:^|\s)(?:aan|voor|bij|met|via|ervaring met|klanten|klanten in|klanten uit|opdrachtgevers|leveren aan|levert aan|werken voor|werkt voor|gericht op|to|for|through|serving)\s+(?:de\s+|het\s+|onder andere\s+|o\.a\.\s+|the\s+|andere\s+)?(?:[\p{L}'-]+\s+){0,2}$/u;
const EXCLUSION = /(?:^|[\s,;])(?:geen|niet|zonder|behalve|uitgezonderd|exclusief|excluding|except|no)\s+([^,.;]+?)(?=$|[,.;]|\s(?:en|maar|die|met|in)\s)/gu;
const WEBSHOP = /\b(?:consumentenwebwinkels?|webwinkels?|webshops?|online (?:winkels?|shops?)|consumenten|particulieren)\b/u;
const BUSINESS_TYPE_PHRASES: Array<[RegExp, BusinessType]> = [
  [/\b(?:zakelijke (?:leveranciers?|markt|klanten|afnemers)|b2b(?:-leveranciers?)?|voor bedrijven|business-to-business)\b/gu, 'b2b_supplier'],
  [/\b(?:consumentenwebwinkels?|webwinkels?|webshops?|online (?:winkels?|shops?))\b/gu, 'consumer_webshop'],
];
/** "uitsluitend/alleen zakelijk(e afnemers)", "alleen aan bedrijven": business suppliers, and no consumer web shops. */
const ONLY_BUSINESS = /\b(?:uitsluitend|alleen|enkel|exclusief)\s+(?:aan\s+)?(?:zakelijke?(?:\s+(?:afnemers|klanten|markt|leveranciers?))?|bedrijven|b2b)\b/gu;
const PLACE_CUE = /(?:^|\s)(?:in|uit|rond|rondom|regio|omgeving|nabij|bij|around|near)\s+(?:de\s+|het\s+)?(?:regio\s+|omgeving\s+|gemeente\s+|stad\s+)?$/u;
const STOPWORDS = new Set(('ik we wij zoek zoeken zoekt gezocht welke wat wie bedrijven bedrijf ondernemingen onderneming organisaties organisatie firma firmas partijen partij die dat deze de het een en of in met voor aan van op te zijn is hebben heeft ervaring '
  + 'gespecialiseerd specialiseren gespecialiseerde actief actieve leveren levert leverancier maken maakt inclusief ook alle graag vind vinden '
  + 'binnen onder andere zoals etc liefst bij uit rond regio omgeving zowel als plus hun hen wel veel vooral sector sectoren branche nederland nederlandse '
  + 'aantoonbare aantoonbaar uitvoeren voeren uitsluitend alleen enkel verkopen verkoopt beide allebei tevens '
  + 'find companies company that the and with for which who are provide providing looking some any also').split(' '));

/** Accented emphasis ("én", "óf") would be lost by normalisation, so it is spelled out first. */
const emphasise = (value: string) => value.normalize('NFC')
  .replace(/(^|[^\p{L}])én(?=[^\p{L}]|$)/giu, '$1en ook')
  .replace(/(^|[^\p{L}])óf(?=[^\p{L}]|$)/giu, '$1of wel');

/**
 * Turns "Ik zoek bedrijven in Nederland die camerasystemen installeren en ervaring hebben met ziekenhuizen" into
 * product: camerasystemen, service: installatie, customer sector: ziekenhuizen, country: NL, and (inferred) industry:
 * beveiliging, with every recognized phrase listed so the user sees and can edit what was understood. Two values of one
 * kind joined by "én", "zowel ... als" or "and" are all required; by "of"/"óf" alternatives; a plain "en" is read as
 * alternatives (the default) and reported, so the user can make it "all".
 */
export function interpretDescription(description: string): Interpretation {
  const original = description.slice(0, 600);
  let norm = normalizeText(emphasise(original));
  const recognized: RecognizedPhrase[] = [];
  const warnings: string[] = [];
  const criteria: CompanySearchCriteria = {
    ...EMPTY_CRITERIA, industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [], businessTypes: [], excludedBusinessTypes: [],
    logic: {}, provinces: [], places: [], exclusions: [], description: original.trim() || null,
  };
  const exclude = (type: BusinessType, phrase: string) => {
    if (!criteria.excludedBusinessTypes.includes(type)) criteria.excludedBusinessTypes.push(type);
    recognized.push({ phrase, kind: 'excluded_business_type', value: BUSINESS_TYPE_LABELS[type] });
  };

  // 0. "uitsluitend zakelijk": business suppliers only, no consumer web shops.
  for (const match of norm.matchAll(ONLY_BUSINESS)) {
    if (!criteria.businessTypes.includes('b2b_supplier')) criteria.businessTypes.push('b2b_supplier');
    recognized.push({ phrase: match[0], kind: 'business_type', value: BUSINESS_TYPE_LABELS.b2b_supplier });
    exclude('consumer_webshop', match[0]);
  }
  norm = norm.replace(ONLY_BUSINESS, match => ' '.repeat(match.length));

  // 1. Exclusions first, so "geen alarmsystemen" never becomes a product to look for; "geen webwinkels" excludes a business type.
  for (const match of norm.matchAll(EXCLUSION)) {
    const chunk = match[1].trim();
    if (WEBSHOP.test(chunk)) { exclude('consumer_webshop', match[0].trim()); continue; }
    const concepts = scanConcepts(chunk).map(hit => hit.concepts[0].label);
    for (const value of concepts.length ? concepts : [chunk.slice(0, 60)]) {
      criteria.exclusions.push(value);
      recognized.push({ phrase: match[0].trim(), kind: 'exclusion', value });
    }
  }
  norm = norm.replace(EXCLUSION, match => ' '.repeat(match.length));
  const consumed = new Array<boolean>(norm.length).fill(false);
  const consume = (index: number, length: number) => { for (let i = index; i < index + length; i++) consumed[i] = true; };
  const free = (index: number, length: number) => consumed.slice(index, index + length).every(value => !value);

  // 2. Geography: provinces anywhere, places only after "in/uit/rond/regio ..." (so "Best" or "Ede" in a sentence is not a place).
  for (const { name, kind, id } of geographyNames()) {
    for (const match of norm.matchAll(termPattern(name))) {
      const index = match.index ?? 0;
      if (!free(index, match[0].length)) continue;
      if (kind === 'place' && !PLACE_CUE.test(norm.slice(0, index))) continue;
      consume(index, match[0].length);
      if (kind === 'province') { if (!criteria.provinces.includes(id)) criteria.provinces.push(id); recognized.push({ phrase: match[0], kind: 'province', value: provinceLabel(id) ?? id }); }
      else { if (!criteria.places.includes(id)) criteria.places.push(id); recognized.push({ phrase: match[0], kind: 'place', value: id }); }
    }
  }
  for (const alias of NETHERLANDS.aliases) {
    for (const match of norm.matchAll(termPattern(alias))) {
      const index = match.index ?? 0;
      if (!free(index, match[0].length) || (alias === 'NL' && match[0] !== 'nl')) continue;
      consume(index, match[0].length);
      if (!recognized.some(r => r.kind === 'country')) recognized.push({ phrase: match[0], kind: 'country', value: 'Nederland' });
    }
  }

  // 2b. How the companies should do business ("zakelijke leveranciers", "webwinkels"): a criterion only when asked for.
  for (const [pattern, type] of BUSINESS_TYPE_PHRASES) {
    for (const match of norm.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (!free(index, match[0].length)) continue;
      consume(index, match[0].length);
      if (!criteria.businessTypes.includes(type)) criteria.businessTypes.push(type);
      recognized.push({ phrase: match[0], kind: 'business_type', value: BUSINESS_TYPE_LABELS[type] });
    }
  }

  // 3. Vocabulary: longest terms first; one span can mean several concepts, the context decides which.
  const placed: Array<{ index: number; end: number; list: LogicList; label: string }> = [];
  for (const hit of scanConcepts(norm, consumed)) {
    const before = norm.slice(Math.max(0, hit.index - 40), hit.index);
    const customer = hit.concepts.find(concept => concept.kind === 'customer_sector');
    const others = hit.concepts.filter(concept => concept.kind !== 'customer_sector');
    let chosen: Concept[];
    if (customer && (SUPPLY_CUE.test(before) || others.length === 0)) chosen = [customer];
    else if (others.some(concept => concept.kind === 'industry')) chosen = others.filter(concept => concept.kind === 'industry').slice(0, 1);
    else chosen = others.slice(0, 1);
    consume(hit.index, hit.length);
    for (const concept of chosen) {
      const listName: LogicList = concept.kind === 'role' ? 'roles' : LIST_OF[concept.kind];
      if (concept.kind === 'role') { if (!criteria.roles.includes(concept.id as CompanyRole)) criteria.roles.push(concept.id as CompanyRole); }
      else { const values = criteria[LIST_OF[concept.kind]]; if (!values.includes(concept.label)) values.push(concept.label); }
      const label = concept.kind === 'role' ? ROLE_LABELS[concept.id as CompanyRole] : concept.label;
      recognized.push({ phrase: norm.slice(hit.index, hit.index + hit.length), kind: concept.kind, value: label });
      placed.push({ index: hit.index, end: hit.index + hit.length, list: listName, label });
    }
  }

  // 3b. How two values of one kind are joined: "én"/"zowel ... als"/"and" = all, "of" = alternatives, plain "en" = reported.
  placed.sort((a, b) => a.index - b.index);
  for (let i = 1; i < placed.length; i++) {
    const [a, b] = [placed[i - 1], placed[i]];
    if (a.list !== b.list || a.label === b.label) continue;
    const between = norm.slice(a.end, b.index).trim();
    const lead = norm.slice(Math.max(0, a.index - 12), a.index);
    if (/^(?:en ook|als ook|alsook|and|en tevens)$/.test(between) || (/zowel\s*$/.test(lead) && /^als$/.test(between)) || /^en\s+(?:beide|allebei)?$/.test(between) && /\b(?:beide|allebei)\b/.test(norm.slice(b.end, b.end + 20))) {
      criteria.logic[a.list] = 'all';
      recognized.push({ phrase: `${a.label} ${between} ${b.label}`, kind: 'logic', value: `${a.label} én ${b.label} (beide vereist)` });
    } else if (/^(?:of|of wel|en\/of|or)$/.test(between)) {
      recognized.push({ phrase: `${a.label} ${between} ${b.label}`, kind: 'logic', value: `${a.label} of ${b.label} (één van beide)` });
    } else if (/^en$/.test(between) && criteria.logic[a.list] !== 'all') {
      warnings.push(`"${a.label} en ${b.label}" is gelezen als: één van beide volstaat. Moeten ze allebei aangeboden worden, kies dan "alle".`);
    }
  }

  // 4. The usual branch of a named product/service, when no branch was named (shown as derived, removable).
  if (criteria.industries.length === 0) {
    const parents = [...new Set([...criteria.products.map(v => findConcept('product', v)), ...criteria.services.map(v => findConcept('service', v)), ...criteria.specialisations.map(v => findConcept('specialisation', v))]
      .map(concept => concept?.industry).filter((id): id is string => Boolean(id)))].slice(0, 2);
    for (const id of parents) {
      const industry = CONCEPTS.find(concept => concept.kind === 'industry' && concept.id === id);
      if (!industry) continue;
      criteria.industries.push(industry.label);
      recognized.push({ phrase: '', kind: 'industry', value: industry.label, inferred: true });
    }
  }

  // 5. What was not understood is listed, never silently turned into a criterion; contradictions are reported.
  const leftover = norm.split('').map((ch, i) => (consumed[i] ? ' ' : ch)).join('');
  const unrecognized = uniqueStrings(leftover.split(/[^\p{L}\p{N}'-]+/u).filter(word => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word)), 8);
  if (unrecognized.length) warnings.push(`Niet herkend en niet gebruikt: ${unrecognized.join(', ')}. Voeg ze zo nodig zelf toe als product, dienst of zoekterm.`);
  warnings.push(...criteriaWarnings(criteria));
  return { criteria, recognized, unrecognized, warnings };
}

interface ConceptHit { index: number; length: number; concepts: Concept[] }

/** Every vocabulary term found in a normalized text, longest first, non-overlapping; one span may name several concepts. */
function scanConcepts(norm: string, consumed?: boolean[]): ConceptHit[] {
  const taken = consumed ? [...consumed] : new Array<boolean>(norm.length).fill(false);
  const byTerm = new Map<string, Concept[]>();
  for (const concept of CONCEPTS) for (const term of concept.terms) {
    const key = normalizeText(term);
    byTerm.set(key, [...(byTerm.get(key) ?? []), concept]);
  }
  const hits: ConceptHit[] = [];
  for (const [term, concepts] of [...byTerm].sort((a, b) => b[0].length - a[0].length)) {
    for (const match of norm.matchAll(termPattern(term))) {
      const index = match.index ?? 0;
      if (taken.slice(index, index + match[0].length).some(Boolean)) continue;
      for (let i = index; i < index + match[0].length; i++) taken[i] = true;
      hits.push({ index, length: match[0].length, concepts });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
