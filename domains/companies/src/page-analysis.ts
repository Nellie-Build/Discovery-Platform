import type { CandidateEvidence, CandidateRank, CrawlPage, PriorityTier } from '@discovery-platform/core';
import type { CompanyLocation, PageType, ServiceArea } from './company-facts.js';
import type { CompanySearchCriteria } from './criteria.js';
import { NL_POSTCODE, findPlace, findProvince, geographyNames } from './geography.js';
import { CONCEPTS, findConcept, type CompanyRole, type ConceptKind } from './vocabulary.js';
import { normalizeText, sentences, termPattern } from './text.js';

/**
 * What one page of a company's own website shows: which activities it names and in what context, the addresses the
 * company publishes, the area it says it serves, general contact channels and a stated Chamber of Commerce number.
 * Only facts the page itself states; the profile (profile.ts) combines pages.
 */
/** A concept's terms, or (`related: true`) only its broader terms, which never prove the concept. */
export interface TermSpec { key: string; kind: ConceptKind; conceptId: string | null; label: string; terms: string[]; related?: boolean }

export interface TermHit {
  key: string; kind: ConceptKind; conceptId: string | null; label: string;
  /** Specific: in this page's own title or a heading of its content, or in its address (URL slug). Never the menu. */
  structural: boolean;
  /** Only in the site navigation/header (the menu shown on every page): weak by itself. */
  inNav: boolean;
  /** Distinct sentences of the page's own content (not menu, header or footer) that name it. */
  sentences: number;
  /** Customer sectors: named in a sentence that says the company supplies/serves it, or in a heading of a sector/project page. */
  supplyContext: boolean;
  /** Found only through a broader, related term of the concept (see Concept.related). */
  related: boolean;
  /** The term as found. */
  term: string;
  count: number;
  quote: string;
}

/** How the page sells: web-shop signals (cart, prices, consumer wording, product data) versus business wording. */
export interface CommerceSignals { cart: boolean; prices: number; productSchema: boolean; consumerCues: string[]; businessCues: string[]; quote: string | null }

export interface OrganizationData {
  name: string | null; legalName: string | null; alternateNames: string[]; description: string | null;
  telephone: string | null; email: string | null; areaServed: string[];
}

export interface PageAnalysis {
  url: string;
  pageType: PageType;
  isHomepage: boolean;
  title: string | null;
  metaDescription: string | null;
  siteName: string | null;
  organization: OrganizationData | null;
  legalNameInFooter: string | null;
  addresses: CompanyLocation[];
  statedKvk: string | null;
  serviceAreas: ServiceArea[];
  hits: TermHit[];
  commerce: CommerceSignals;
  email: string | null;
  phone: string | null;
  textLength: number;
}

/** Every vocabulary concept, plus the criteria's own free values and query as literal terms. */
export function termSpecs(criteria: CompanySearchCriteria | null): TermSpec[] {
  const specs: TermSpec[] = CONCEPTS.flatMap(concept => [
    { key: `${concept.kind}:${concept.id}`, kind: concept.kind, conceptId: concept.id, label: concept.label, terms: concept.terms },
    ...(concept.related?.length ? [{ key: `${concept.kind}:${concept.id}:related`, kind: concept.kind, conceptId: concept.id, label: concept.label, terms: concept.related, related: true }] : []),
  ]);
  if (!criteria) return specs;
  const free = (kind: ConceptKind, values: string[]) => {
    for (const value of values) {
      if (findConcept(kind, value)) continue;
      const key = `${kind}:free:${normalizeText(value)}`;
      if (!specs.some(spec => spec.key === key)) specs.push({ key, kind, conceptId: null, label: value, terms: [value] });
    }
  };
  free('industry', criteria.industries); free('product', criteria.products); free('service', criteria.services);
  free('specialisation', criteria.specialisations); free('customer_sector', criteria.customerSectors);
  if (criteria.query) free('product', [criteria.query]);
  return specs;
}

// ─── Page type and crawl ranking ────────────────────────────────────────────────────────────────────────────────────

const PAGE_TYPES: Array<[PageType, RegExp]> = [
  ['contact', /(?:^|[/_-])(?:contact|contactgegevens|bereikbaarheid|route|contact-us)(?:[/_.-]|$)/],
  ['locations', /(?:^|[/_-])(?:vestigingen|vestiging|locaties|locatie|werkgebied|servicegebied|regio|locations|branches-and-locations)(?:[/_.-]|$)/],
  ['projects', /(?:^|[/_-])(?:projecten|project|referenties|referentie|cases|case|portfolio|klantverhalen|klantcases|realisaties|references)(?:[/_.-]|$)/],
  ['sectors', /(?:^|[/_-])(?:sectoren|sector|markten|markt|branches|branche|doelgroepen|voor-wie|klanten|industries|markets|toepassingen)(?:[/_.-]|$)/],
  ['products', /(?:^|[/_-])(?:producten|product|assortiment|oplossingen|oplossing|systemen|solutions|products|catalogus)(?:[/_.-]|$)/],
  ['services', /(?:^|[/_-])(?:diensten|dienst|dienstverlening|services|service|expertise|wat-we-doen|werkzaamheden|specialisaties|specialisatie|disciplines)(?:[/_.-]|$)/],
  ['about', /(?:^|[/_-])(?:over-ons|over|about|about-us|wie-zijn-wij|wie-we-zijn|organisatie|bedrijf|het-bedrijf|historie|geschiedenis|profiel)(?:[/_.-]|$)/],
];
const SKIP_PATH = /(?:^|[/_-])(?:nieuws|news|blog|blogs|vacatures|vacature|werken-bij|careers|jobs|privacy|cookies?|cookiebeleid|disclaimer|algemene-voorwaarden|voorwaarden|terms|login|inloggen|account|winkelwagen|cart|checkout|zoeken|search|tag|tags|author|feed|wp-json|agenda|events?)(?:[/_.-]|$)/;

/** Pages that say nothing about what a company does (news, jobs, legal, account): never read as evidence. */
export function isNonInformativePage(url: string): boolean {
  try { return SKIP_PATH.test(decodeURI(new URL(url).pathname).toLowerCase()); } catch { return false; }
}

export function pageTypeOf(url: string, isHomepage = false): PageType {
  let path = '/';
  try { path = decodeURI(new URL(url).pathname).toLowerCase(); } catch { /* keep '/' */ }
  if (isHomepage || path === '/' || /^\/(?:nl|en|home|index\.html?)\/?$/.test(path)) return 'home';
  return PAGE_TYPES.find(([, pattern]) => pattern.test(path))?.[0] ?? 'other';
}

/** Company pages worth reading first: about, products, services, sectors, projects, locations, contact. */
export const COMPANY_LINK_TIER: PriorityTier = { pattern: /over-ons|about|producten|products|diensten|services|oplossingen|sectoren|markten|branches|projecten|referenties|cases|vestigingen|werkgebied|contact/, priority: 1 };

export function rankCompanyCandidate(evidence: CandidateEvidence): CandidateRank {
  let path = '/';
  try { path = decodeURI(new URL(evidence.url).pathname).toLowerCase(); } catch { /* weak evidence only */ }
  const type = pageTypeOf(evidence.url);
  const reasons: string[] = [type];
  const depth = path.split('/').filter(Boolean).length;
  let score = { home: 5, about: 60, products: 70, services: 70, sectors: 65, projects: 45, locations: 50, contact: 55, other: 15 }[type];
  if (/(?:over ons|producten|diensten|sectoren|markten|projecten|referenties|contact|vestigingen)/.test(evidence.label.toLowerCase())) { score += 10; reasons.push('link_text'); }
  if (depth > 3) { score -= 10 * (depth - 3); reasons.push('deep'); }
  if (SKIP_PATH.test(path)) { score -= 100; reasons.push('not_company_information'); }
  if (/\.(?:pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/.test(path)) { score -= 100; reasons.push('file'); }
  return { score, reasons, classification: 'general' };
}

// ─── Page analysis ──────────────────────────────────────────────────────────────────────────────────────────────────

const SUPPLY_CUE = /(?:\baan|\bvoor|\bbij|\bklanten|\bopdrachtgevers|\bsectoren|\bmarkten|\bbranches|\bdoelgroepen|werken voor|werkt voor|leveren aan|levert aan|o\.a\.|onder andere|zoals|waaronder|\bto|\bfor|\bclients|\bcustomers|\bserving)\s+(?:de\s+|het\s+|diverse\s+|verschillende\s+|onder meer\s+|the\s+)?(?:[\p{L}'-]+[,\s]+){0,4}$/u;
/** A role word after these is somebody else's role ("voor installateurs", "partner van fabrikanten"), not the company's. */
const OTHER_PARTY = /(?:\bvoor|\baan|\bvan|\bdoor|\bmet|\bnaar|\bandere|\bonze|\bdiverse|\bfor|\bto|\bfrom|\bwith|\bbij)\s+(?:de\s+|het\s+|alle\s+|onze\s+|diverse\s+|the\s+)?(?:[\p{L}'-]+\s+){0,1}$/u;
const GENERAL_MAILBOX = /^(?:info|contact|sales|verkoop|service|support|office|kantoor|hallo|hello|hi|algemeen|receptie|administratie|offerte|offertes|orders?|order|bestellingen|klantenservice|customerservice|mail|post|secretariaat|planning|inkoop|welkom|team|vragen|servicedesk|helpdesk)(?:[.-]\w+)?$/;
const SERVICE_AREA_CUE = /\b(?:werkgebied|werkzaam in|actief in|actief door|door heel|in heel|in geheel|landelijk|landelijke dekking|regio|verzorgen|service in|leveren in|servicegebied|wij komen|we komen|nationwide|throughout|serving)\b/;
const NATIONAL = /\b(?:(?:heel|geheel|gehele|het hele|in het hele) (?:nederland|land)|landelijk|landelijke dekking|door (?:heel )?nederland|nationwide|throughout the netherlands|all over the netherlands)\b/;
const KVK = /\b(?:kvk|k\.v\.k\.?|kamer van koophandel|chamber of commerce|coc)(?:[- ]?(?:nummer|nr\.?|no\.?|number|registratie))?\s*[:.#]?\s*(\d{8})\b/i;
const LEGAL_FORM = /(?:©|[Cc]opyright|\([Cc]\))\s*(?:[Cc]opyright\s*)?(?:[-–|:]\s*)?(?:\d{4}(?:\s*[-–]\s*\d{4})?\s*[-–|]?\s*)?([A-Z0-9][\p{L}\p{N}&'.\- ]{1,60}?\s(?:B\.?V\.?|N\.?V\.?|V\.?O\.?F\.?|C\.?V\.?|Holding B\.?V\.?))(?![\p{L}])/u;
const MOBILE = /^(?:\+316|00316|06)\d{8}$/;
const NOT_A_PLACE = /^(?:telefoon|tel|telephone|phone|openingstijden|email|e-mail|mail|fax|kvk|btw|route|contact|nederland|netherlands|postbus|bezoekadres|postadres|adres|the|en|of|www|info|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)$/i;
const CART = /(?:in (?:de |het |mijn )?winkel(?:wagen|mand)|winkelwagen|winkelmand|winkelwagentje|add to cart|shopping cart|afrekenen|(?:^|\/)(?:cart|checkout|winkelwagen|afrekenen)(?:\/|$))/i;
const PRICE = /€\s?\d{1,5}(?:[.,]\d{2}|,-)?/g;
const CONSUMER_CUE = /\b(?:voor thuis|voor particulieren|particulieren|consumenten|thuisgebruik|gratis verzending|gratis bezorging|vandaag besteld|morgen (?:in huis|geleverd|bezorgd)|op voorraad|incl(?:\.|usief) btw|gratis retour|retourneren)\b/g;
const BUSINESS_CUE = /\b(?:zakelijke klanten|zakelijke markt|zakelijke gebruikers|voor bedrijven|voor ondernemers|b2b|business-to-business|excl(?:\.|usief) btw|offerte aanvragen|vraag (?:een |vrijblijvend (?:een )?)?offerte|dealers?|dealernetwerk|vakhandel|voor installateurs|zakelijk account|groothandel|projectmatig|bedrijfsleven|opdrachtgevers|business customers)\b/g;
const ORG_TYPE = /Organization|Organisation|Business|Corporation|Company|Store|Contractor|Service|Electrician|Plumber|HVAC|Locksmith|MedicalOrganization|GeneralContractor/;

/** Entities some sites leave in structured data or meta tags ("Goetheer &amp; Huissoon"). */
const decodeEntities = (value: string) => value.replace(/&(amp|quot|apos|#39|nbsp|lt|gt);/g, (_, name: string) => ({ amp: '&', quot: '"', apos: "'", '#39': "'", nbsp: ' ', lt: '<', gt: '>' } as Record<string, string>)[name]);
const text = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const clean = decodeEntities(String(value)).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
};
const strings = (value: unknown): string[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
  .map(item => (typeof item === 'object' && item !== null ? text((item as Record<string, unknown>).name) : text(item))).filter((item): item is string => Boolean(item));

function jsonLdNodes($: CrawlPage['$']): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (Array.isArray(node['@graph'])) node['@graph'].forEach(add);
    nodes.push(node);
  };
  $('script[type="application/ld+json"]').each((_: number, element: any) => {
    try { add(JSON.parse($(element).text())); } catch { /* invalid structured data is ignored, never a failure */ }
  });
  return nodes.slice(0, 50);
}

function organizationOf(nodes: Array<Record<string, unknown>>, url: string): { organization: OrganizationData | null; addresses: CompanyLocation[] } {
  const org = nodes.find(node => ORG_TYPE.test(String(node['@type'] ?? '')) && (node.name || node.legalName));
  if (!org) return { organization: null, addresses: [] };
  const addresses: CompanyLocation[] = [];
  const addressNodes = [org.address, ...(Array.isArray(org.location) ? org.location.map((l: any) => l?.address) : [(org.location as any)?.address])].flat().filter(Boolean);
  for (const node of addressNodes.slice(0, 10)) {
    if (!node || typeof node !== 'object') continue;
    const a = node as Record<string, unknown>;
    const city = text(a.addressLocality, 80);
    const place = city ? findPlace(city) : null;
    const region = text(a.addressRegion, 80);
    const postcode = text(a.postalCode, 12);
    const country = text(typeof a.addressCountry === 'object' ? (a.addressCountry as any)?.name ?? (a.addressCountry as any)?.['@id'] : a.addressCountry, 40);
    addresses.push({
      address: text(a.streetAddress, 120), postcode, city: place?.name ?? city,
      province: place?.province ?? (region ? findProvince(region)?.id ?? null : null),
      country: country ? (/^(nl|nld|nederland|netherlands|the netherlands)$/i.test(country) ? 'NL' : country.slice(0, 40)) : (postcode && NL_POSTCODE.test(postcode) ? 'NL' : null),
      sourceUrl: url,
    });
  }
  return {
    organization: {
      name: text(org.name, 120), legalName: text(org.legalName, 160), alternateNames: strings(org.alternateName).slice(0, 5),
      description: text(org.description, 600), telephone: text(org.telephone, 40), email: text(org.email, 120), areaServed: strings(org.areaServed).slice(0, 20),
    },
    addresses,
  };
}

/** Addresses in the page text: "Straat 12, 2511 AB Den Haag". Only the city part that is a known place gets a province. */
function textAddresses(body: string, url: string): CompanyLocation[] {
  const out: CompanyLocation[] = [];
  const pattern = new RegExp(`${NL_POSTCODE.source}\\s*,?\\s*([A-Z'][\\p{L}'’.\\- ]{1,40})`, 'gu');
  for (const match of body.matchAll(pattern)) {
    if (out.length >= 8) break;
    const words = match[3].trim().split(/\s+/);
    let place = null;
    for (let n = Math.min(4, words.length); n >= 1 && !place; n--) place = findPlace(words.slice(0, n).join(' '));
    const raw = words[0].replace(/[.,:]+$/, '');
    const before = body.slice(Math.max(0, (match.index ?? 0) - 70), match.index ?? 0);
    // A known place right before the postcode ("Achterdijk 46 Vierpolders 3237LA") wins over a word after it.
    // Separators between address parts ("Achterdijk 46 | Vierpolders | 3237LA") are not part of a place name.
    const preceding = before.split(/[\s|,·•;/]+/).filter(Boolean).slice(-3);
    if (!place) for (let n = Math.min(3, preceding.length); n >= 1 && !place; n--) place = findPlace(preceding.slice(-n).join(' ').replace(/[.,:]+$/, ''));
    // An unknown place is kept as written, unless it is a page word that happened to follow the postcode.
    const city = place?.name ?? (/^[A-Z][\p{L}'-]{2,30}$/u.test(raw) && !NOT_A_PLACE.test(raw) ? raw : null);
    const street = /([A-Z][\p{L}.' -]{2,50}\s\d{1,5}\s?[a-zA-Z]?(?:[-/]\d{1,4})?|Postbus\s\d{1,6})\s*[,|]?\s*$/u.exec(before)?.[1] ?? null;
    const postcode = `${match[1]} ${match[2]}`;
    if (out.some(existing => existing.postcode === postcode)) continue;
    out.push({ address: street, postcode, city, province: place?.province ?? null, country: 'NL', sourceUrl: url });
  }
  return out;
}

function serviceAreasOf(body: string, areaServed: string[], url: string): ServiceArea[] {
  const out: ServiceArea[] = [];
  const add = (area: ServiceArea) => { if (!out.some(existing => existing.scope === area.scope && existing.value === area.value)) out.push(area); };
  const names = geographyNames();
  const scan = (sentence: string, quote: string) => {
    const norm = normalizeText(sentence);
    if (NATIONAL.test(norm)) add({ scope: 'national', value: 'NL', quote, sourceUrl: url });
    for (const { name, kind, id } of names) {
      if (!termPattern(name).test(norm)) continue;
      add(kind === 'province' ? { scope: 'province', value: id, quote, sourceUrl: url } : { scope: 'place', value: id, quote, sourceUrl: url });
    }
  };
  for (const sentence of sentences(body)) {
    if (out.length >= 12) break;
    if (SERVICE_AREA_CUE.test(normalizeText(sentence))) scan(sentence, sentence.slice(0, 240));
  }
  for (const area of areaServed) scan(`werkgebied ${area}`, `areaServed: ${area}`);
  return out;
}

function generalEmail(value: string | null | undefined): string | null {
  const email = value?.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return null;
  return GENERAL_MAILBOX.test(email.split('@')[0]) ? email : null;
}
function businessPhone(value: string | null | undefined, allowMobile: boolean): string | null {
  const digits = value?.replace(/^tel:/i, '').replace(/[^\d+]/g, '') ?? '';
  if (!/^\+?\d{9,15}$/.test(digits)) return null;
  return MOBILE.test(digits) && !allowMobile ? null : digits;
}

/** Analyses one fetched page of a company site for the given term specs. */
export function analyzeCompanyPage(page: Pick<CrawlPage, '$' | 'url' | 'isHomepage' | 'contacts'>, specs: TermSpec[]): PageAnalysis {
  const { $, url } = page;
  const pageType = pageTypeOf(url, page.isHomepage);
  const nodes = jsonLdNodes($);
  const { organization, addresses: structuredAddresses } = organizationOf(nodes, url);
  const title = text($('title').first().text(), 300);
  const metaDescription = text($('meta[name="description"]').attr('content'), 600);
  const siteName = text($('meta[property="og:site_name"]').attr('content'), 120);
  const root = $('body').clone();
  root.find('script,style,noscript,svg,iframe,template').remove();
  // Cookie and consent banners say nothing about the company ("cookies die zorgen voor ...").
  root.find('[id*="cookie"],[class*="cookie"],[id*="consent"],[class*="consent"],[id*="gdpr"],[class*="gdpr"],[id*="cookiebar"]').remove();
  // Adjacent elements must not run together ("Den Haag</span><span>Openingstijden" -> "Den HaagOpeningstijden").
  root.find('*').append(' ');
  const body = root.text().replace(/\s+/g, ' ').trim().slice(0, 60_000);
  const normBody = normalizeText(body);
  const footer = root.find('footer').text().replace(/\s+/g, ' ');
  // The page's own content: without the menu, header, footer and side bars, which repeat on every page.
  const content = root.clone();
  content.find('nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]').remove();
  const contentSentences = sentences(content.text().replace(/\s+/g, ' ')).map(normalizeText);
  const headings = normalizeText([title ?? '', ...content.find('h1,h2,h3').toArray().map((el: any) => $(el).text())].join(' | '));
  const nav = normalizeText(root.find('nav a, header a, [role="navigation"] a').toArray().slice(0, 150).map((el: any) => $(el).text()).join(' | '));
  let slug = '';
  try { slug = normalizeText(decodeURI(new URL(url).pathname).replace(/[-_/.]+/g, ' ')); } catch { /* no slug evidence */ }
  const notOtherParty = (text: string, term: string) => { const at = text.search(termPattern(term)); return at >= 0 && !OTHER_PARTY.test(text.slice(Math.max(0, at - 60), at)); };

  const hits: TermHit[] = [];
  for (const spec of specs) {
    let count = 0; let quote = ''; let supply = false; let structural = false; let inNav = false; let found = '';
    const counted = new Set<number>();
    for (const term of spec.terms) {
      const role = spec.kind === 'role';
      if (!structural && termPattern(term).test(headings) && (!role || notOtherParty(headings, term))) { structural = true; found ||= term; }
      if (!structural && termPattern(term).test(slug) && !role) { structural = true; found ||= term; }
      if (!inNav && termPattern(term).test(nav) && (!role || notOtherParty(nav, term))) { inNav = true; found ||= term; }
      contentSentences.forEach((sentence, index) => {
        for (const match of sentence.matchAll(termPattern(term))) {
          const before = sentence.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
          if (role && OTHER_PARTY.test(before)) continue;
          count++;
          counted.add(index);
          found ||= term;
          const cue = SUPPLY_CUE.test(before);
          if (!quote || (spec.kind === 'customer_sector' && cue && !supply)) quote = sentence.slice(0, 280);
          if (cue) supply = true;
        }
      });
    }
    if (count === 0 && !structural && !inNav) continue;
    hits.push({
      key: spec.key, kind: spec.kind, conceptId: spec.conceptId, label: spec.label, structural, inNav, sentences: counted.size, count,
      supplyContext: spec.kind === 'customer_sector' && (supply || ((pageType === 'sectors' || pageType === 'projects') && structural)),
      related: spec.related === true, term: found,
      quote: quote || (title ?? '').slice(0, 200),
    });
  }

  // How the page sells.
  const contentText = normalizeText(content.text());
  const links = root.find('a,button').toArray().slice(0, 400).map((el: any) => `${$(el).attr('href') ?? ''} ${$(el).text()}`.toLowerCase());
  const consumerCues = [...new Set([...contentText.matchAll(CONSUMER_CUE)].map(m => m[0]))].slice(0, 8);
  const businessCues = [...new Set([...contentText.matchAll(BUSINESS_CUE)].map(m => m[0]))].slice(0, 8);
  const isCue = (sentence: string) => new RegExp(CONSUMER_CUE.source).test(sentence) || new RegExp(BUSINESS_CUE.source).test(sentence);
  const cueSentence = contentSentences.find(isCue) ?? null;
  const commerce: CommerceSignals = {
    cart: links.some(link => CART.test(link)),
    prices: Math.min(50, (content.text().match(PRICE) ?? []).length),
    productSchema: nodes.some(node => /\b(?:Product|Offer|AggregateOffer)\b/.test(String(node['@type'] ?? ''))),
    consumerCues, businessCues, quote: cueSentence ? cueSentence.slice(0, 240) : null,
  };

  const allowAddresses = pageType !== 'projects' && pageType !== 'sectors';
  const addresses = [...structuredAddresses, ...(allowAddresses ? textAddresses(footer ? `${body} ${footer}` : body, url) : [])]
    .filter((address, index, all) => all.findIndex(other => (other.postcode ?? other.city) === (address.postcode ?? address.city)) === index).slice(0, 10);
  return {
    url, pageType, isHomepage: page.isHomepage, title, metaDescription, siteName, organization,
    legalNameInFooter: LEGAL_FORM.exec(footer || body.slice(-3000))?.[1]?.trim() ?? null,
    addresses,
    statedKvk: KVK.exec(body)?.[1] ?? null,
    serviceAreas: serviceAreasOf(body, organization?.areaServed ?? [], url),
    hits,
    commerce,
    email: generalEmail(organization?.email) ?? generalEmail(page.contacts?.email),
    phone: businessPhone(organization?.telephone, true) ?? businessPhone(page.contacts?.phone, false),
    textLength: body.length,
  };
}

/** The contact normalizers the crawl uses: digits only for phones, lower-cased addresses for e-mail (filtered later). */
export const CONTACT_NORMALIZERS = {
  normalizePhone: (raw: string) => { const digits = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, ''); return /^\+?\d{9,15}$/.test(digits) ? digits : null; },
  normalizeEmail: (raw: string) => { const email = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) ? email : null; },
};

export type { CompanyRole };
