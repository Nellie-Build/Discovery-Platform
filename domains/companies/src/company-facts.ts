import type { BusinessType, CompanyRole, ConceptKind } from './vocabulary.js';

/**
 * A company profile as stored in `discovery_records.domain_data` (domain 'companies'). Everything is what a source
 * showed, with where it was shown; nothing is filled in to make a profile look complete: an unknown value stays null or
 * an empty list. The profile describes the company; the `search` part says how well it matched the search of the run
 * that last saw it.
 */
export type SourceType = 'official_website' | 'directory' | 'search_result';
export type MatchStatus = 'confirmed' | 'possible' | 'insufficient';
export type EvidenceStrength = 'strong' | 'weak';

export interface EvidenceQuote { url: string; pageType: PageType; quote: string }

/**
 * One activity found for the company: an industry it is IN, a product, service or specialisation it offers, a customer
 * sector it SUPPLIES, or a role it has. `strong` evidence is specific (a heading, the page about it, a sentence that
 * says it supplies that sector, or repeated mentions); `weak` evidence is a passing mention.
 */
export interface Activity {
  kind: ConceptKind;
  /** The vocabulary concept id, or null for a free term the user searched for. */
  conceptId: string | null;
  label: string;
  strength: EvidenceStrength;
  evidence: EvidenceQuote[];
  /**
   * Found only through broader terms of the concept (e.g. "onderwijshuisvesting" for school renovation): shown, never
   * proof of the concept itself; always weak.
   */
  related?: boolean;
  /** The terms as they appear on the site. */
  matchedTerms?: string[];
  /** Customer sectors: offering (products/services for the sector), reference (a project/case in it) or mention (only named). */
  basis?: 'offering' | 'reference' | 'mention';
  /** What the company does with it, each with the sentence that says so (supplies, installs, maintains, produces, ...). */
  actions?: Array<{ action: 'supplies' | 'produces' | 'installs' | 'maintains' | 'advises' | 'develops'; url: string; quote: string }>;
}

/** One way the company does business, with the signals that show it (see profile.ts's businessTypesOf). */
export interface BusinessTypeEvidence { type: BusinessType; strength: EvidenceStrength; signals: string[]; sourceUrl: string | null; quote: string | null }

export type PageType = 'home' | 'about' | 'products' | 'services' | 'sectors' | 'projects' | 'contact' | 'locations' | 'other';

/** A place of establishment: an address the company publishes itself (never a customer project location). */
export interface CompanyLocation {
  address: string | null;
  postcode: string | null;
  /** The place as the company writes it ("Vierpolders"). */
  city: string | null;
  /** The municipality of a known place ("Voorne aan Zee"), else null. */
  municipality?: string | null;
  /** Province id (e.g. NL-ZH) when the city is a known place, else null. */
  province: string | null;
  /** A visiting address (street and number), a postal address (Postbus) or not known. */
  addressType?: 'visiting' | 'postal' | 'unknown';
  country: string | null;
  sourceUrl: string;
}

/** An area the company says it serves. `national` = the whole country. */
export interface ServiceArea {
  scope: 'national' | 'province' | 'place';
  /** Province id for 'province', place name for 'place', country code for 'national'. */
  value: string;
  quote: string;
  sourceUrl: string;
}

export interface CompanySource { url: string; type: SourceType; pageType: PageType | null; title: string | null; checkedAt: string }

/** One search criterion and how this company met it. */
export interface CriterionMatch {
  kind: ConceptKind | 'business_type' | 'excluded_business_type' | 'query' | 'country' | 'province' | 'place';
  criterion: string;
  status: MatchStatus;
  /** What was found for it (the product, service, sector, location...), or null. */
  found: string | null;
  sourceUrl: string | null;
  sourceType: SourceType | null;
  quote: string | null;
  /** A short Dutch explanation, e.g. "vestiging in Rotterdam; geen werkgebied Zuid-Holland gevonden". */
  note: string | null;
  checkedAt: string;
  /** Customer sectors: what the evidence is (an offering for the sector, a reference project in it, or only a mention). */
  basis?: 'offering' | 'reference' | 'mention';
}

export interface CompanySearchResult {
  /** A short summary of the criteria of the run that last evaluated this company. */
  criteria: string;
  status: MatchStatus;
  matches: CriterionMatch[];
  checkedAt: string;
}

export interface FieldChange { field: string; previous: unknown; current: unknown; at: string }

export interface CompanyFacts {
  /** The identity: the company's registrable web domain (see identity.ts). Never the name. */
  identity: string;
  /** The official (legal) name when the company states it, else its trade name as shown on its site. */
  name: string | null;
  /** Other names the company uses, as shown on its own site. */
  tradeNames: string[];
  website: string;
  domain: string;
  /** The company's own description of itself (meta description / structured data of its site). */
  description: string | null;
  industries: Activity[];
  products: Activity[];
  services: Activity[];
  specialisations: Activity[];
  customerSectors: Activity[];
  roles: Array<Activity & { role: CompanyRole }>;
  /** How the company does business: selling to businesses, a consumer web shop, manufacturer, distributor, service provider. */
  businessTypes: BusinessTypeEvidence[];
  locations: CompanyLocation[];
  serviceAreas: ServiceArea[];
  /** General business contact channels only (no personal addresses or mobile numbers of people). */
  phone: string | null;
  email: string | null;
  contactUrl: string | null;
  registration: {
    /** Only a number verified against the registry itself; always null in this version (no registry source). */
    kvkNumber: string | null;
    /** A Chamber of Commerce number the company states on its own site: shown as stated, never used as identity. */
    statedKvkNumber: string | null;
    statedOn: string | null;
  };
  sources: CompanySource[];
  lastCheckedAt: string;
  /** Changes of single-valued fields found by later runs; the previous value is kept, never silently lost. */
  changes: FieldChange[];
  discovery: { via: 'website' | 'web_search'; query: string | null; searchProvider: string | null; searchSnippet: string | null; mode: 'search' | 'website' };
  search: CompanySearchResult | null;
}
