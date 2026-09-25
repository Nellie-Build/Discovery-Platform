import { CONCEPTS, COMPANY_ROLES, ROLE_LABELS, KIND_LABELS, CONCEPT_KINDS, conceptsOf, expandValue, findConcept, type CompanyRole, type Concept, type ConceptKind } from './vocabulary.js';
import { NETHERLANDS, findPlace, findProvince, geographyNames, provinceLabel, COUNTRIES } from './geography.js';
import { normalizeText, termPattern, uniqueStrings } from './text.js';

/**
 * Search criteria for companies, and the transparent interpretation of a description in plain language into those
 * criteria. Browser-safe: the Web App shows the interpretation while the user types and lets them edit it; the server
 * validates whatever comes back. No AI and no paid service: vocabulary terms, place names and a few context rules.
 * A later LLM-based interpreter can produce the same `CompanySearchCriteria` shape.
 */
export { CONCEPTS, COMPANY_ROLES, ROLE_LABELS, KIND_LABELS, CONCEPT_KINDS, conceptsOf, expandValue, findConcept, NETHERLANDS, provinceLabel, findProvince, findPlace };
export type { CompanyRole, Concept, ConceptKind };

export interface CompanySearchCriteria {
  /** A company name or general search term. */
  query: string | null;
  industries: string[];
  products: string[];
  services: string[];
  specialisations: string[];
  customerSectors: string[];
  roles: CompanyRole[];
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
  query: null, industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [],
  country: 'NL', provinces: [], places: [], extra: null, exclusions: [], description: null,
};

/** The criteria list for each vocabulary kind (roles are ids, the rest are free values). */
export const LIST_OF: Record<Exclude<ConceptKind, 'role'>, 'industries' | 'products' | 'services' | 'specialisations' | 'customerSectors'> = {
  industry: 'industries', product: 'products', service: 'services', specialisation: 'specialisations', customer_sector: 'customerSectors',
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
  return {
    query: text(input.query, 120, 'Zoekterm'),
    industries: list(input.industries, 'Branche'),
    products: list(input.products, 'Producten'),
    services: list(input.services, 'Diensten'),
    specialisations: list(input.specialisations, 'Specialisaties'),
    customerSectors: list(input.customerSectors, 'Afnemerssector'),
    roles: [...new Set(roles)],
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

/** A one-line Dutch summary, e.g. "Product: camerasystemen · Dienst: installatie · Afnemer: ziekenhuizen · Zuid-Holland". */
export function summarizeCriteria(c: CompanySearchCriteria): string {
  const parts: string[] = [];
  if (c.query) parts.push(`Zoekterm: ${c.query}`);
  const add = (label: string, values: string[]) => { if (values.length) parts.push(`${label}: ${values.join(', ')}`); };
  add('Branche', c.industries); add('Product', c.products); add('Dienst', c.services); add('Specialisatie', c.specialisations);
  add('Afnemer', c.customerSectors); add('Rol', c.roles.map(role => ROLE_LABELS[role]));
  const where = [...c.places, ...c.provinces.map(id => provinceLabel(id) ?? id)];
  parts.push(where.length ? where.join(', ') : 'Nederland');
  if (c.exclusions.length) parts.push(`Niet: ${c.exclusions.join(', ')}`);
  return parts.join(' · ');
}

// ─── Interpretation of a plain-language description ─────────────────────────────────────────────────────────────────

export interface RecognizedPhrase {
  phrase: string;
  kind: ConceptKind | 'country' | 'province' | 'place' | 'exclusion';
  value: string;
  /** Not named by the user but derived (the usual branch of a named product/service). */
  inferred?: boolean;
}
export interface Interpretation { criteria: CompanySearchCriteria; recognized: RecognizedPhrase[]; unrecognized: string[] }

/** Words before a sector that make it a customer sector ("levert AAN ziekenhuizen", "ervaring MET scholen", "VOOR hotels"). */
const SUPPLY_CUE = /(?:^|\s)(?:aan|voor|bij|met|ervaring met|klanten|klanten in|klanten uit|opdrachtgevers|leveren aan|levert aan|werken voor|werkt voor|gericht op|to|for|serving)\s+(?:de\s+|het\s+|onder andere\s+|o\.a\.\s+|the\s+)?(?:[\p{L}'-]+\s+){0,2}$/u;
const EXCLUSION = /(?:^|[\s,;])(?:geen|niet|zonder|behalve|uitgezonderd|exclusief|excluding|except|no)\s+([^,.;]+?)(?=$|[,.;]|\s(?:en|maar|die|met|in)\s)/gu;
const PLACE_CUE = /(?:^|\s)(?:in|uit|rond|rondom|regio|omgeving|nabij|bij|around|near)\s+(?:de\s+|het\s+)?(?:regio\s+|omgeving\s+|gemeente\s+|stad\s+)?$/u;
const STOPWORDS = new Set(('ik we wij zoek zoeken zoekt gezocht welke wat wie bedrijven bedrijf ondernemingen onderneming organisaties organisatie firma firmas partijen partij die dat deze de het een en of in met voor aan van op te zijn is hebben heeft ervaring '
  + 'gespecialiseerd specialiseren gespecialiseerde actief actieve leveren levert leverancier maken maakt inclusief ook alle graag vind vinden '
  + 'binnen onder andere zoals etc liefst bij uit rond regio omgeving zowel als plus hun hen wel veel vooral sector sectoren branche nederland nederlandse '
  + 'find companies company that the and with for which who are provide providing looking some any also').split(' '));

/**
 * Turns "Ik zoek bedrijven in Nederland die camerasystemen installeren en ervaring hebben met ziekenhuizen" into
 * product: camerasystemen, service: installatie, customer sector: ziekenhuizen, country: NL, and (inferred) industry:
 * beveiliging, with every recognized phrase listed so the user sees and can edit what was understood.
 */
export function interpretDescription(description: string): Interpretation {
  const original = description.slice(0, 600);
  let norm = normalizeText(original);
  const recognized: RecognizedPhrase[] = [];
  const criteria: CompanySearchCriteria = { ...EMPTY_CRITERIA, industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [], provinces: [], places: [], exclusions: [], description: original.trim() || null };

  // 1. Exclusions first, so "geen alarmsystemen" never becomes a product to look for.
  for (const match of norm.matchAll(EXCLUSION)) {
    const chunk = match[1].trim();
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

  // 3. Vocabulary: longest terms first; one span can mean several concepts, the context decides which.
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
      if (concept.kind === 'role') { if (!criteria.roles.includes(concept.id as CompanyRole)) criteria.roles.push(concept.id as CompanyRole); }
      else { const values = criteria[LIST_OF[concept.kind]]; if (!values.includes(concept.label)) values.push(concept.label); }
      recognized.push({ phrase: norm.slice(hit.index, hit.index + hit.length), kind: concept.kind, value: concept.kind === 'role' ? ROLE_LABELS[concept.id as CompanyRole] : concept.label });
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

  // 5. What was not understood is listed, never silently turned into a criterion.
  const leftover = norm.split('').map((ch, i) => (consumed[i] ? ' ' : ch)).join('');
  const unrecognized = uniqueStrings(leftover.split(/[^\p{L}\p{N}'-]+/u).filter(word => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word)), 8);
  return { criteria, recognized, unrecognized };
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
