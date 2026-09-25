import { normalizeText } from './text.js';

/**
 * The maintained vocabulary behind interpretation, search expansion and page analysis: concepts with Dutch and English
 * terms, per kind. It is deliberately a plain, reviewable list (no AI, no hidden expansion): a term is only ever expanded
 * to the other terms of the SAME concept. A value a user types that is not listed here is still used, literally.
 *
 * The kinds keep the difference that matters most apart: `industry` is what a company IS (a security company, a care
 * organisation), `customer_sector` is who it SUPPLIES (hospitals, schools). The same word can appear in both (e.g.
 * "zorgorganisaties", "installateurs"); context decides which one is meant (see criteria.ts and page-analysis.ts).
 */
export type ConceptKind = 'industry' | 'product' | 'service' | 'specialisation' | 'customer_sector' | 'role';
export const CONCEPT_KINDS: readonly ConceptKind[] = ['industry', 'product', 'service', 'specialisation', 'customer_sector', 'role'];

export interface Concept {
  id: string;
  kind: ConceptKind;
  /** Dutch label shown to the user. */
  label: string;
  /** Every term that means this concept, Dutch and English; the label is always one of them. */
  terms: string[];
  /** Products, services and specialisations: the industry they usually belong to (used to suggest a branch). */
  industry?: string;
}

export type CompanyRole = 'manufacturer' | 'wholesaler' | 'distributor' | 'supplier' | 'installer' | 'contractor' | 'service_provider' | 'consultancy';
export const COMPANY_ROLES: readonly CompanyRole[] = ['manufacturer', 'wholesaler', 'distributor', 'supplier', 'installer', 'contractor', 'service_provider', 'consultancy'];

const c = (kind: ConceptKind, id: string, label: string, terms: string[], industry?: string): Concept =>
  ({ id, kind, label, terms: [label, ...terms], ...(industry ? { industry } : {}) });

export const CONCEPTS: readonly Concept[] = [
  // ── Industries: what a company is ──────────────────────────────────────────────────────────────────────────────────
  c('industry', 'security', 'beveiliging', ['beveiligingsbedrijf', 'beveiligingsbedrijven', 'beveiligingsbranche', 'beveiligingstechniek', 'security', 'security company', 'safety en security', 'safety & security']),
  c('industry', 'healthcare', 'zorg', ['zorgorganisatie', 'zorgorganisaties', 'zorgaanbieder', 'zorgaanbieders', 'gezondheidszorg', 'zorgverlener', 'zorgverleners', 'healthcare', 'health care']),
  c('industry', 'construction', 'bouw', ['bouwbedrijf', 'bouwbedrijven', 'bouwsector', 'bouwonderneming', 'bouwgroep', 'construction', 'construction company']),
  c('industry', 'ict', 'ICT', ['ict-bedrijf', 'ict-bedrijven', 'it-bedrijf', 'it-bedrijven', 'it-dienstverlener', 'softwarebedrijf', 'softwarebedrijven', 'softwareleverancier', 'information technology', 'it company', 'software company']),
  c('industry', 'logistics', 'logistiek', ['logistieke dienstverlener', 'logistieke dienstverleners', 'transportbedrijf', 'transportbedrijven', 'logistics', 'warehousing']),
  c('industry', 'manufacturing', 'industrie', ['industrieel', 'industriele', 'maakindustrie', 'productiebedrijf', 'productiebedrijven', 'manufacturing', 'industry']),
  c('industry', 'education', 'onderwijs', ['onderwijsinstelling', 'onderwijsinstellingen', 'opleidingsinstituut', 'education']),
  c('industry', 'energy', 'energie', ['energiebedrijf', 'energiebedrijven', 'duurzame energie', 'energietransitie', 'energy', 'renewable energy']),
  c('industry', 'hospitality', 'horeca', ['hospitality', 'horecabedrijf', 'horecabedrijven']),
  c('industry', 'installation_engineering', 'installatietechniek', ['installatiebranche', 'technische installaties', 'elektrotechniek', 'werktuigbouwkunde', 'building services']),
  c('industry', 'facility', 'facilitaire dienstverlening', ['facility management', 'facilitair', 'schoonmaak', 'schoonmaakbedrijf', 'cleaning']),
  c('industry', 'retail', 'retail', ['detailhandel', 'winkelketen']),
  c('industry', 'medical_technology', 'medische technologie', ['medtech', 'medical technology', 'medische techniek']),
  c('industry', 'automation', 'automatisering', ['automatiseringsbedrijf', 'automatiseringsbedrijven', 'automation']),

  // ── Products ───────────────────────────────────────────────────────────────────────────────────────────────────────
  c('product', 'cctv', 'camerasystemen', ['camerasysteem', 'camerabewaking', 'camerabeveiliging', 'camerabeveiligingssystemen', 'beveiligingscamera', "beveiligingscamera's", 'bewakingscamera', "bewakingscamera's", 'videobewaking', 'videobewakingssystemen', 'videosurveillance', 'cctv', "ip-camera's", 'ip-camera', 'security cameras', 'security camera', 'video surveillance'], 'security'),
  c('product', 'access_control', 'toegangscontrolesystemen', ['toegangscontrole', 'toegangscontrolesysteem', 'toegangsbeheer', 'toegangssystemen', 'access control', 'access control systems', 'kaartlezers', 'elektronische sloten', 'elektronische toegangscontrole'], 'security'),
  c('product', 'alarm', 'alarmsystemen', ['alarmsysteem', 'inbraakalarm', 'inbraakbeveiliging', 'inbraakdetectie', 'alarminstallatie', 'alarminstallaties', 'intrusion detection', 'burglar alarm'], 'security'),
  c('product', 'security_products', 'beveiligingsproducten', ['beveiligingsartikelen', 'beveiligingsmaterialen', 'security products', 'security equipment'], 'security'),
  c('product', 'medical_equipment', 'medische apparatuur', ['medische hulpmiddelen', 'medische instrumenten', 'medische producten', 'medische systemen', 'medical devices', 'medical equipment', 'medische technologie'], 'medical_technology'),
  c('product', 'insulation', 'isolatiematerialen', ['isolatiemateriaal', 'isolatieproducten', 'insulation', 'insulation materials']),
  c('product', 'solar', 'zonnepanelen', ['zonnepaneel', 'pv-panelen', 'pv-installaties', 'pv-installatie', 'zonnestroomsystemen', 'zonne-energie', 'solar panels', 'solar pv', 'photovoltaic'], 'energy'),
  c('product', 'heat_pumps', 'warmtepompen', ['warmtepomp', 'heat pumps', 'heat pump'], 'energy'),
  c('product', 'business_software', 'bedrijfssoftware', ['software', 'softwareoplossingen', 'softwarepakket', 'saas', 'erp', 'business software'], 'ict'),
  c('product', 'planning_software', 'planningssoftware', ['roostersoftware', 'roosterplanning', 'personeelsplanning', 'planningssysteem', 'roosterprogramma', 'scheduling software', 'workforce management'], 'ict'),
  c('product', 'robots', 'robots', ['robot', 'cobots', 'cobot', 'robotarmen', 'industriele robots'], 'automation'),
  c('product', 'control_systems', 'besturingssystemen', ['plc', 'plc-besturing', 'scada', 'besturingstechniek', 'control systems'], 'automation'),
  c('product', 'fire_safety_products', 'brandbeveiligingsproducten', ['blusmiddelen', 'brandblussers', 'rookmelders', 'fire safety products'], 'security'),

  // ── Services ───────────────────────────────────────────────────────────────────────────────────────────────────────
  c('service', 'installation', 'installatie', ['installeren', 'installeert', 'installaties', 'montage', 'monteren', 'aanleg', 'plaatsing', 'installation', 'installing']),
  c('service', 'maintenance', 'onderhoud', ['onderhouden', 'service en onderhoud', 'onderhoudscontract', 'onderhoudscontracten', 'storingsdienst', 'maintenance', 'servicing']),
  c('service', 'renovation', 'renovatie', ['renoveren', 'renovaties', 'verbouw', 'verbouwing', 'verbouwingen', 'renovation', 'refurbishment']),
  c('service', 'guarding', 'objectbeveiliging', ['beveiligers', 'beveiligingsdiensten', 'bewaking', 'mobiele surveillance', 'surveillance', 'receptiebeveiliging', 'security guards', 'manned guarding']),
  c('service', 'monitoring', 'alarmopvolging', ['meldkamer', 'particuliere alarmcentrale', 'pac', 'alarmcentrale', 'remote monitoring', 'monitoring']),
  c('service', 'home_care', 'thuiszorg', ['wijkverpleging', 'zorg thuis', 'huishoudelijke hulp', 'home care']),
  c('service', 'security_advice', 'beveiligingsadvies', ['risicoanalyse', 'beveiligingsplan', 'security consultancy', 'security advice'], 'security'),
  c('service', 'advice', 'advies', ['adviseren', 'consultancy', 'advisering', 'advisory']),
  c('service', 'software_development', 'softwareontwikkeling', ['maatwerksoftware', 'software op maat', 'applicatieontwikkeling', 'app-ontwikkeling', 'software development', 'custom software'], 'ict'),
  c('service', 'engineering', 'engineering', ['ontwerp en engineering', 'engineeringsdiensten']),
  c('service', 'distribution', 'distributie', ['groothandelsdistributie', 'logistieke diensten', 'distribution']),

  // ── Specialisations ────────────────────────────────────────────────────────────────────────────────────────────────
  c('specialisation', 'fire_detection', 'branddetectie', ['brandmeldinstallatie', 'brandmeldinstallaties', 'brandmeldsystemen', 'brandbeveiliging', 'bmi', 'fire detection', 'fire alarm systems'], 'security'),
  c('specialisation', 'utility_construction', 'utiliteitsbouw', ['utiliteitsprojecten', 'utiliteit', 'bedrijfsgebouwen', 'non-residential construction', 'commercial construction'], 'construction'),
  c('specialisation', 'school_renovation', 'schoolrenovatie', ['renovatie van scholen', 'renovatie van schoolgebouwen', 'schoolgebouwen renoveren', 'scholenbouw', 'onderwijshuisvesting', 'schoolgebouwen', 'school renovation'], 'construction'),
  c('specialisation', 'robotisation', 'robotisering', ['robotautomatisering', 'robotica', 'robotics', 'robotintegratie'], 'automation'),
  c('specialisation', 'industrial_automation', 'industriele automatisering', ['procesautomatisering', 'machineautomatisering', 'industrial automation', 'process automation'], 'automation'),
  c('specialisation', 'refrigeration', 'koeltechniek', ['koelinstallaties', 'koelsystemen', 'koel- en vriestechniek', 'refrigeration']),
  c('specialisation', 'cybersecurity', 'cybersecurity', ['cyberbeveiliging', 'informatiebeveiliging', 'cyber security'], 'ict'),

  // ── Customer sectors: who a company supplies ───────────────────────────────────────────────────────────────────────
  c('customer_sector', 'hospitals', 'ziekenhuizen', ['ziekenhuis', 'umc', "umc's", 'medische centra', 'medisch centrum', 'hospitals', 'hospital']),
  c('customer_sector', 'care_institutions', 'zorginstellingen', ['zorginstelling', 'zorgorganisaties', 'zorgorganisatie', 'zorgsector', 'verpleeghuizen', 'verpleeghuis', 'gezondheidszorg', 'zorg en welzijn', 'healthcare', 'care homes']),
  c('customer_sector', 'schools', 'scholen', ['school', 'onderwijsinstellingen', 'onderwijsinstelling', 'onderwijs', 'basisscholen', 'universiteiten', 'hogescholen', 'education', 'schools']),
  c('customer_sector', 'municipalities', 'gemeenten', ['gemeente', 'overheid', 'overheden', 'overheidsinstellingen', 'publieke sector', 'public sector', 'municipalities']),
  c('customer_sector', 'data_centers', 'datacenters', ['datacentra', 'datacenter', 'data centers', 'data centres']),
  c('customer_sector', 'hotels', 'hotels', ['hotel', 'hotellerie', 'hotelbranche', 'hospitality']),
  c('customer_sector', 'distribution_centers', 'distributiecentra', ['distributiecentrum', 'logistieke centra', 'magazijnen', 'warehouses', 'distribution centers', 'distribution centres']),
  c('customer_sector', 'installers', 'installateurs', ['installatiebedrijven', 'installers']),
  c('customer_sector', 'industry', 'industrie', ['industriele bedrijven', 'productiebedrijven', 'maakindustrie', 'industrial companies', 'manufacturers']),
  c('customer_sector', 'retail', 'retail', ['winkels', 'detailhandel', 'retailers']),
  c('customer_sector', 'housing_associations', 'woningcorporaties', ['woningcorporatie', 'housing associations']),
  c('customer_sector', 'offices', 'kantoren', ['kantoorgebouwen', 'offices']),
  c('customer_sector', 'hospitality', 'horeca', ['restaurants']),

  // ── Roles: what a company does in the chain ────────────────────────────────────────────────────────────────────────
  c('role', 'manufacturer', 'fabrikant', ['fabrikanten', 'producent', 'producenten', 'eigen productie', 'wij produceren', 'ontwikkelen en produceren', 'manufacturer', 'manufacturers']),
  c('role', 'wholesaler', 'groothandel', ['groothandels', 'groothandelsbedrijf', 'wholesale', 'wholesaler']),
  c('role', 'distributor', 'distributeur', ['distributeurs', 'importeur', 'importeurs', 'distributor', 'distributors', 'importer']),
  c('role', 'supplier', 'leverancier', ['leveranciers', 'supplier', 'suppliers']),
  c('role', 'installer', 'installateur', ['installateurs', 'installatiebedrijf', 'installatiebedrijven', 'installer', 'installers']),
  c('role', 'contractor', 'aannemer', ['aannemers', 'aannemersbedrijf', 'hoofdaannemer', 'bouwbedrijf', 'contractor', 'contractors']),
  c('role', 'service_provider', 'dienstverlener', ['dienstverleners', 'service provider', 'service providers']),
  c('role', 'consultancy', 'adviesbureau', ['adviesbureaus', 'ingenieursbureau', 'consultancybureau', 'consultant', 'consultants', 'consultancy firm']),
];

export const ROLE_LABELS: Record<CompanyRole, string> = {
  manufacturer: 'Fabrikant', wholesaler: 'Groothandel', distributor: 'Distributeur', supplier: 'Leverancier',
  installer: 'Installateur', contractor: 'Aannemer', service_provider: 'Dienstverlener', consultancy: 'Adviesbureau',
};

export const KIND_LABELS: Record<ConceptKind, string> = {
  industry: 'Branche', product: 'Product', service: 'Dienst', specialisation: 'Specialisatie', customer_sector: 'Afnemerssector', role: 'Bedrijfsrol',
};

/** The concept a value names (by label or any term) within one kind, or null for a free value. */
export function findConcept(kind: ConceptKind, value: string): Concept | null {
  const key = normalizeText(value);
  return CONCEPTS.find(concept => concept.kind === kind && (concept.id === key || concept.terms.some(term => normalizeText(term) === key))) ?? null;
}

/** All terms a criterion value stands for: its concept's terms, or the value itself when it is not in the vocabulary. */
export function expandValue(kind: ConceptKind, value: string): string[] {
  const concept = findConcept(kind, value);
  return concept ? concept.terms : [value];
}

/** Concepts per kind, for suggestion lists in the form. */
export const conceptsOf = (kind: ConceptKind) => CONCEPTS.filter(concept => concept.kind === kind);
