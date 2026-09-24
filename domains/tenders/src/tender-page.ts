import type { CrawlPage } from '@discovery-platform/core';
import type { CpvCode, TenderDiscovery, TenderFacts } from './tender-facts.js';
import { classifySourceRole, type RoleAssessment } from './source-role.js';

/**
 * Reads ONE ordinary web page and decides whether it is a concrete tender, an overview of tenders, general procurement
 * information, or nothing of the kind. Generic rules only: no host is ever special-cased. A page counts as one concrete
 * tender only with enough independent evidence (see assessTenderPage); a page of general purchasing information
 * ("Informatie voor leveranciers", "Zo koopt onze organisatie in") never does.
 *
 * A page that itself lists several DIFFERENT procurements inline (not as links to other pages, but written out on the
 * page itself — see assessTenderPageMulti) can still yield one record per procurement: see splitTenderPageSections.
 */
export type TenderPageKind = 'detail' | 'overview' | 'general' | 'none';

export type TenderPageRejection = 'overview_page' | 'general_procurement_information' | 'insufficient_evidence' | 'no_tender_evidence' | 'foreign_country';

/**
 * Where a page's own site says it is — evidence only, never a guess from its language or wording (Dutch
 * tender-sounding text is written by organisations everywhere Dutch is spoken, not only in the Netherlands; English
 * text says even less). Two generic, page-language-neutral signals go into `code`: the host's own country-code
 * top-level domain, read only from a curated safe subset (many ccTLDs are sold and used as generic/vanity domains —
 * ".io", ".ai", ".co", ".me", ".tv", ... — so a domain ending in one of those says nothing reliable about where the
 * organisation actually is, and is deliberately left out), and a structured `addressCountry` the page's own
 * JSON-LD/microdata states as a plain ISO 3166-1 alpha-2 code (the value schema.org itself recommends). Several
 * distinct countries found this way is itself "unknown": the page's own signals disagree, so nothing is asserted.
 */
export interface PageCountryEvidence {
  /** ISO 3166-1 alpha-2 — set only together with confidence 'explicit'. */
  code: string | null;
  confidence: 'explicit' | 'unknown';
}

export interface TenderPageFacts {
  title: string | null;
  contractingAuthority: string | null;
  referenceNumber: string | null;
  procedureType: string | null;
  contractType: string | null;
  cpvCodes: CpvCode[];
  location: string | null;
  publicationDate: string | null;
  submissionDeadline: string | null;
  estimatedValue: { amount: number; currency: string } | null;
  description: string | null;
  documentCount: number;
}

export interface TenderPageAssessment {
  url: string;
  kind: TenderPageKind;
  /** Set when the page is not a concrete tender: why. */
  rejection: TenderPageRejection | null;
  /** The generic signals found: deadline, reference, cpv, procedure, documents (strong); publication_date, labeled_authority, tender_word_in_title, tender_word_in_lead (supporting). */
  signals: string[];
  /** Tender links to further pages found on this page (an overview has several). */
  tenderLinks: number;
  facts: TenderPageFacts | null;
  /** The organisation that runs the site, when the page says so. A separate concept from the contracting authority. */
  publisher: string | null;
  /** Where the contracting authority came from, when one was found. */
  authoritySource: 'structured' | 'label' | 'prose_label' | null;
  /** What kind of web source the page is on (see source-role.ts). */
  role: RoleAssessment;
  /** Where the page's own site says it is (see PageCountryEvidence) — evidence only, a caller with a target country decides what to do with it. */
  countryEvidence: PageCountryEvidence;
  /**
   * Set only for one procurement split out of a page that inline-lists several (see splitTenderPageSections): the
   * characteristic that identifies this one within the page — a real DOM anchor id, else the procurement's own reference
   * number, else its heading text. Never an invented tender number. Absent (undefined) for an ordinary, whole-page assessment.
   */
  sectionId?: string;
  /** The real `id` attribute of the section's container/heading, when it has one — used to build a navigable URL fragment. */
  sectionAnchor?: string | null;
  /** The section's own heading text — kept as a human-readable pointer to it, even when there is no real anchor. */
  sectionHeading?: string | null;
}

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** A stable, readable identity fragment from arbitrary text (a heading, typically) — never a fabricated number. */
const slugify = (value: string): string => norm(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
/** `scope` may be a section (several sibling nodes, not just their descendants): include nodes IN `scope` itself, not only inside them. */
const querySelf = (scope: any, selector: string): any => scope.filter(selector).add(scope.find(selector));

/** A word that says the page is about a concrete procurement procedure. */
const EXPLICIT_TENDER_WORD = /\b(?:aanbesteding\w*|offerte-?aanvra\w+|uitnodiging tot (?:inschrijving|het doen van een offerte)|tender\w*|rfp|rfq|request for (?:proposals?|quotations?|quotes?)|marktconsultatie|inschrijving)\b/i;
/** Pages that explain how an organisation buys, not one procurement. */
const GENERAL_INFORMATION = /\b(?:aanbesteden\s+(?:bij|voor)|inkopen\s+bij|inkoopbeleid|inkoopvoorwaarden|inkoopproces|inkoopkader|zo koopt|hoe koopt|hoe kopen|zakendoen met|zaken doen met|informatie voor leveranciers|leveranciersinformatie|leverancier (?:worden|zijn)|registreren als leverancier|leveranciersportaal|algemene inkoopvoorwaarden|duurzaam inkopen|social return|procurement (?:policy|process)|information for suppliers|how we buy|doing business with)\b/i;
/** Link text of documents, advice and forms attached to a tender: never another tender. */
const DOCUMENT_LINK_TEXT = /\b(?:leidraad|documenten?|bijlagen?|formulier\w*|advies|adviezen|nota van|download\w*|bestek|verklaring|uniform|gunningscriteria|inschrijfstaat|pve|programma van eisen)\b/i;
/** A last path segment that is a listing, not one item. */
const LISTING_SEGMENT = /^(?:aanbestedingen|openstaande-aanbestedingen|lopende-aanbestedingen|actuele-aanbestedingen|aanbestedingskalender|tenders?|tender-?overzicht|inkoopkalender|opdrachten|uitvragen|offerteaanvragen|marktconsultaties|procurement|inkoop|inkopen|leveranciers|current-tenders|open-tenders)$/;

const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mrt: 3, maart: 3, mar: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5,
  jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, augustus: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAME = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DATE_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => [number, number, number]]> = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, m => [+m[1], +m[2], +m[3]]],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|e)?[\\s-]+(${MONTH_NAME})\\.?[\\s,-]+(\\d{4})\\b`, 'i'), m => [+m[3], MONTHS[m[2].toLowerCase()], +m[1]]],
  [new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'), m => [+m[3], MONTHS[m[1].toLowerCase()], +m[2]]],
  [/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/, m => [+m[3], +m[2], +m[1]]],
];
const TIME_AFTER = /^[\s,.–-]*(?:om|at|tot|voor|vóór|before|by|uiterlijk)?\s*(\d{1,2})[:.](\d{2})\s*(?:uur|u\b|h\b)?/i;

/** The first date in `fragment` as { date: YYYY-MM-DD, end } (where the match ended), or null. Day-first for numeric dates, as in the Netherlands. */
function firstDate(fragment: string): { date: string; end: number } | null {
  let best: { date: string; end: number; at: number } | null = null;
  for (const [pattern, read] of DATE_PATTERNS) {
    const match = pattern.exec(fragment);
    if (!match) continue;
    const [year, month, day] = read(match);
    if (!(year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) continue;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1) continue;
    if (!best || match.index < best.at) best = { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, end: match.index + match[0].length, at: match.index };
  }
  return best;
}

/** "10 november 2026 om 12:00 uur" -> "2026-11-10T12:00:00" (a date alone stays a date). */
function dateTimeIn(fragment: string): string | null {
  const found = firstDate(fragment);
  if (!found) return null;
  const time = TIME_AFTER.exec(fragment.slice(found.end, found.end + 40));
  if (time && +time[1] < 24 && +time[2] < 60) return `${found.date}T${time[1].padStart(2, '0')}:${time[2]}:00`;
  return found.date;
}

const DEADLINE_LABEL = /(?:sluitingsdatum|sluitingstijdstip|sluitingstermijn|uiterste\s+(?:datum\s+)?(?:van\s+)?(?:inschrijving|inschrijfdatum|indiening|inzending|aanmelding|reactie)|uiterlijk\s+(?:in te dienen|indienen)|inschrijfdatum|inschrijftermijn|inschrijven\s+(?:kan\s+)?tot|indiendatum|indienen\s+(?:kan\s+)?(?:tot|voor)|termijn\s+voor\s+(?:inschrijving|indiening)|deadline(?:\s+(?:for\s+)?(?:submission|tenders?|proposals?|inschrijving|indienen))?|closing\s+date|submission\s+deadline|(?:tenders?|proposals?|offers?)\s+(?:must\s+be\s+(?:submitted|received)\s+)?(?:by|before))/i;
const PUBLICATION_LABEL = /(?:gepubliceerd(?:\s+op)?|publicatiedatum|datum\s+(?:van\s+)?publicatie|geplaatst\s+op|plaatsingsdatum|published(?:\s+on)?|publication\s+date|date\s+published)/i;
const REFERENCE_LABEL = /(?:aanbestedings?(?:nummer|kenmerk)|tender(?:nummer|\s+(?:no\.?|number|id|reference)|-?id)|kenmerk|referentie(?:nummer|\s+nummer|code)?|zaaknummer|dossiernummer|opdrachtnummer|inkoopnummer|reference(?:\s+(?:no\.?|number|code))?|rfp\s+(?:no\.?|number)|rfq\s+(?:no\.?|number))/i;
const AUTHORITY_LABEL = /^(?:aanbestedende\s+(?:dienst|organisatie|instantie|partij)|opdrachtgever(?:\s+organisatie)?|uitvragende\s+(?:organisatie|partij)|contracting\s+(?:authority|entity|body|organi[sz]ation)|issuing\s+(?:authority|organi[sz]ation)|procuring\s+(?:entity|organi[sz]ation)|buyer(?:\s+name)?)$/i;
const AUTHORITY_PROSE = /(?:aanbestedende\s+(?:dienst|organisatie|partij)|opdrachtgever|contracting\s+(?:authority|entity))\s+(?:is|zijn|=)\s+(?:de\s+|het\s+)?([\p{L}][\p{L}0-9 '’&.-]{2,80}?)(?=\s*[.,;:(]|\s+(?:schrijft|heeft|wil|zoekt|nodigt|en|die|voor)\b|$)/iu;
const STRUCTURED_AUTHORITY_KEYS = ['buyer', 'contractingAuthority', 'contractingEntity', 'procuringEntity'];
const ORGANIZATION_TYPES = /^(?:Organization|GovernmentOrganization|LocalBusiness|EducationalOrganization|NGO|Corporation|MedicalOrganization|Hospital|CollegeOrUniversity|School)$/;
/** How an organisation talks about its own procurements. */
const FIRST_PERSON_PROCUREMENT = /\b(?:onze|ons)\s+(?:aanbestedingen|inkoop\w*|opdrachten|offerte\w*)|\bwij\s+(?:schrijven|zoeken|nodigen|vragen|willen|gaan)\b|\bwe\s+(?:invite|are\s+looking|are\s+seeking|seek)\b|\bour\s+(?:tenders|procurements?)\b/i;
const PROCEDURE_LABEL = /^(?:procedure|type\s+procedure|aanbestedingsprocedure|aanbestedingsvorm|type\s+aanbesteding|procedure\s+type)$/i;
const PROCEDURE_TEXT = /\b(?:niet-?openbare\s+procedure|openbare\s+procedure|europese\s+(?:openbare\s+)?aanbesteding|nationale\s+(?:openbare\s+)?aanbesteding|meervoudig\s+onderhands\w*|enkelvoudig\s+onderhands\w*|onderhandse\s+aanbesteding|mededingingsprocedure\w*|concurrentiegerichte\s+dialoog|open\s+procedure|restricted\s+procedure|negotiated\s+procedure)\b/i;
const CONTRACT_LABEL = /^(?:soort\s+opdracht|type\s+opdracht|opdrachtsoort|contract\s+type|type\s+of\s+contract)$/i;
const LOCATION_LABEL = /^(?:plaats|locatie|uitvoeringslocatie|plaats\s+van\s+uitvoering|regio|place\s+of\s+performance|location)$/i;
const VALUE_LABEL = /^(?:geraamde\s+waarde|raming|waarde|geschatte\s+waarde|estimated\s+value|contract\s+value)$/i;

/**
 * All "label: value" pairs within `scope`: definition lists, two-cell table rows, short "Label: value" text blocks, and a
 * label element directly followed by its value element (label/value grids without a dl or table). `scope` is usually the
 * whole document (`$.root()`), but can be one section's own nodes — a `querySelf`-based scope, so a label/value pair that
 * IS one of the scope's own top-level nodes (not just nested inside them) is still found.
 */
function labelPairs($: CrawlPage['$'], scope: any): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const add = (label: string, value: string) => {
    const l = collapse(label).replace(/[:：]\s*$/, '');
    const v = collapse(value);
    if (l && v && l.length <= 60 && v.length <= 300) pairs.push([l, v]);
  };
  querySelf(scope, 'dt').slice(0, 200).each((_: number, element: any) => { add($(element).text(), $(element).nextAll('dd').first().text()); });
  querySelf(scope, 'tr').slice(0, 400).each((_: number, element: any) => {
    const cells = $(element).children('th,td');
    if (cells.length === 2) add($(cells[0]).text(), $(cells[1]).text());
  });
  querySelf(scope, 'li,p,div,span').slice(0, 1500).each((_: number, element: any) => {
    const node = $(element);
    if (node.children('li,p,div,ul,ol,table,section,article').length > 0) return;
    const match = /^([^:：]{2,50})[:：]\s*(.{1,300})$/.exec(collapse(node.text()));
    if (match) add(match[1], match[2]);
  });
  // A label element directly followed by its value element (label/value grids without a dl or table).
  querySelf(scope, 'div,span,p,strong,b,label,h3,h4,dt,th').slice(0, 1500).each((_: number, element: any) => {
    const node = $(element);
    if (node.children().not('svg,i,img').length > 0) return; // an icon next to the label text is fine
    const label = collapse(node.text());
    if (label.length < 3 || label.length > 40) return;
    const next = node.next();
    if (next.length === 0 || next.children('div,p,ul,ol,table,section').length > 0) return;
    const value = collapse(next.text());
    if (value && value !== label) add(label, value);
  });
  return pairs;
}

const valueOf = (pairs: Array<[string, string]>, label: RegExp) => pairs.find(([name]) => label.test(name.trim()))?.[1] ?? null;

/** `scope`'s own text, scripts/styles/navigation stripped — the whole page (via pickContentRoot) or just one section. */
function textOf(scope: any): string {
  const clone = scope.clone();
  clone.find('script,style,noscript,svg,iframe,nav,footer,form,[role="navigation"],[aria-hidden="true"]').remove();
  return collapse(clone.text()).slice(0, 80_000);
}

/** The element the page's own content lives in: `<main>`, else `<article>`, else the whole body. */
function pickContentRoot($: CrawlPage['$']): any {
  return $('main').length > 0 ? $('main').first() : $('article').length > 0 ? $('article').first() : $('body');
}

function bodyText($: CrawlPage['$']): string {
  return textOf(pickContentRoot($));
}

/** A plausible organisation name: short, no sentence, not a date or a placeholder. */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = collapse(value).replace(/^[\s:–—-]+|[\s.,;:–—-]+$/g, '');
  if (name.length < 3 || name.length > 120 || name.split(' ').length > 12) return null;
  if (/^(?:n\.?v\.?t\.?|onbekend|nvt|-|n\/a|zie\b)/i.test(name) || firstDate(name)) return null;
  return name;
}

/** Every JSON-LD object on the page, flattened (arrays and @graph included). */
function structuredData($: CrawlPage['$']): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 200)) visit(item, depth + 1); return; }
    out.push(value as Record<string, unknown>);
    for (const nested of Object.values(value as Record<string, unknown>)) visit(nested, depth + 1);
  };
  $('script[type="application/ld+json"]').slice(0, 10).each((_, element) => {
    try { visit(JSON.parse($(element).contents().text()), 0); } catch { /* invalid JSON-LD is ignored */ }
  });
  return out;
}
const nameOf = (value: unknown): string | null => cleanName(typeof value === 'string' ? value : value && typeof value === 'object' ? (value as Record<string, unknown>).name : null);

/**
 * The contracting authority, by precedence: structured data (a buyer/contracting-authority property or meta tag), an explicit
 * label ("Aanbestedende dienst", "Opdrachtgever", ...), a labeled sentence ("De opdrachtgever is Gemeente X."). Nothing else:
 * the name of the site or of its publisher is NEVER taken as the contracting authority, and no authority stays null.
 */
function findAuthority($: CrawlPage['$'], pairs: Array<[string, string]>, text: string, data: Record<string, unknown>[]): { name: string; source: 'structured' | 'label' | 'prose_label' } | null {
  for (const object of data) for (const key of STRUCTURED_AUTHORITY_KEYS) { const name = nameOf(object[key]); if (name) return { name, source: 'structured' }; }
  for (const key of ['contracting-authority', 'aanbestedende-dienst', 'opdrachtgever', 'buyer']) {
    const name = cleanName($('meta[name="' + key + '"]').attr('content'));
    if (name) return { name, source: 'structured' };
  }
  for (const [label, value] of pairs) if (AUTHORITY_LABEL.test(label.trim())) { const name = cleanName(value); if (name) return { name: name.slice(0, 200), source: 'label' }; }
  const prose = AUTHORITY_PROSE.exec(text);
  const proseName = prose ? cleanName(prose[1]) : null;
  if (proseName && /^\p{Lu}/u.test(proseName)) return { name: proseName, source: 'prose_label' };
  return null;
}

/** The organisation that runs the site: structured data first, then site metadata. Not the contracting authority. */
function findPublisher($: CrawlPage['$'], data: Record<string, unknown>[]): string | null {
  for (const object of data) { const name = nameOf(object.publisher); if (name) return name; }
  for (const object of data) {
    const type = object['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some(entry => typeof entry === 'string' && (ORGANIZATION_TYPES.test(entry) || entry === 'WebSite'))) { const name = nameOf(object); if (name) return name; }
  }
  for (const selector of ['meta[property="og:site_name"]', 'meta[name="application-name"]', 'meta[name="apple-mobile-web-app-title"]']) {
    const name = cleanName($(selector).attr('content'));
    if (name) return name;
  }
  return null;
}

/** The name of the site itself, from site metadata (not from a page's structured data). */
function findSiteName($: CrawlPage['$'], data: Record<string, unknown>[]): string | null {
  for (const selector of ['meta[property="og:site_name"]', 'meta[name="application-name"]', 'meta[name="apple-mobile-web-app-title"]']) {
    const name = cleanName($(selector).attr('content'));
    if (name) return name;
  }
  for (const object of data) if (object['@type'] === 'WebSite') { const name = nameOf(object); if (name) return name; }
  return null;
}

/** How the site presents itself: header, footer, navigation and the meta descriptions (not the page's own content). */
function selfDescription($: CrawlPage['$']): string {
  const parts = ['header', 'footer', 'nav'].map(selector => $(selector).slice(0, 5).map((_, element) => $(element).text()).get().join(' '));
  parts.push($('meta[name="description"]').attr('content') ?? '', $('meta[property="og:description"]').attr('content') ?? '', $('meta[property="og:site_name"]').attr('content') ?? '');
  return collapse(parts.join(' ')).slice(0, 6000);
}

function pageTitle($: CrawlPage['$']): string | null {
  const heading = collapse($('h1').first().text());
  if (heading.length >= 4) return heading.slice(0, 300);
  const og = collapse($('meta[property="og:title"]').attr('content') ?? '');
  if (og.length >= 4) return og.split(/\s+[|–—]\s+/)[0].slice(0, 300);
  const title = collapse($('title').first().text());
  return title.length >= 4 ? title.split(/\s+[|–—]\s+/)[0].slice(0, 300) : null;
}

function findCpv(text: string, pairs: Array<[string, string]>): CpvCode[] {
  const codes: string[] = [];
  const scan = (fragment: string) => { for (const match of fragment.matchAll(/\b(\d{8})(?:-\d)?\b/g)) codes.push(match[1]); };
  for (const [label, value] of pairs) if (/\bcpv\b/i.test(label)) scan(value);
  for (const match of text.matchAll(/\bCPV\b/gi)) scan(text.slice(match.index, match.index + 160));
  // A CPV code starts with a division 03..98; other eight-digit numbers (phone numbers, ids) are not codes.
  return [...new Set(codes)].filter(code => +code.slice(0, 2) >= 3 && +code.slice(0, 2) <= 98)
    .map((code, index) => ({ code, description: null, main: index === 0 }));
}

function amount(value: string | null): { amount: number; currency: string } | null {
  if (!value) return null;
  const match = /(?:€|eur(?:o)?)\s*([\d.,]+)|([\d.,]+)\s*(?:€|eur(?:o)?)/i.exec(value);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const normalized = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/[.,](?=\d{3}\b)/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? { amount: number, currency: 'EUR' } : null;
}

/**
 * Words that mean flowing text has moved past the reference value itself — another field's own label (a deadline,
 * a date, a procedure, a location, an authority, ...) or an ordinary connecting word that starts a new clause.
 * Generic vocabulary, not tied to any one organisation's page. A reference span (see referenceSpanAt) never
 * extends across one of these: it would otherwise risk swallowing the next sentence or the next field.
 */
const REFERENCE_BOUNDARY_WORD = /^(?:sluitingsdatum|sluitingstijdstip|sluitingstermijn|uiterste|uiterlijk|inschrijfdatum|inschrijftermijn|inschrijven|indiendatum|indienen|termijn|deadline|closing|submission|gepubliceerd|publicatiedatum|geplaatst|plaatsingsdatum|published|publication|procedure|aanbestedingsvorm|aanbestedingsprocedure|opdrachtsoort|soort|type|plaats|locatie|regio|location|waarde|raming|geraamde|geschatte|estimated|value|cpv|opdrachtgever|aanbestedende|uitvragende|contracting|issuing|procuring|buyer|en|of|de|het|een|op|in|na|tot|voor|door|met|bij|aan|uit|als|dat|die|dit|deze|onze|wordt|worden|moet|kan|heeft|is|zijn|and|or|the|a|an|to|for|by|with|at|on|was|were|will|must|can|has|have)$/i;
const REFERENCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9+]*/;
/**
 * What joins two segments of one reference: a dash/dot/slash/underscore with no surrounding space at all (glued
 * tight, as in "2026.04.041" or "GV/2026/041" — no genuine sentence break can look like this); a dash padded by
 * spaces ("2025 - SA"); or plain whitespace alone ("Nasira+ OS"). A dot, slash or underscore padded by spaces is
 * NOT a join — that is what an ordinary sentence boundary looks like (". Meer informatie ..."), never a reference.
 */
const REFERENCE_JOIN = /^[-–—./_](?=[A-Za-z0-9])|^[ \t]*[-–—][ \t]*|^[ \t]+/;

/** True when a recognisable date starts exactly at the beginning of `fragment` (used to keep a bare date out of a reference span). */
function looksLikeDateStart(fragment: string): boolean {
  return DATE_PATTERNS.some(([pattern]) => { const m = pattern.exec(fragment); return m !== null && m.index === 0; });
}

/**
 * The reference token starting at `from` in `text`: one or more alphanumeric segments joined by a dash, dot,
 * slash, underscore or plain space, e.g. "ABC-XX-1" or "2025 - SA - Nasira+ OS - 005". Stops before it would
 * swallow another field's label, a bare date, or an ordinary word — it never absorbs the next sentence.
 */
function referenceSpanAt(text: string, from: number): string | null {
  const first = REFERENCE_SEGMENT.exec(text.slice(from));
  if (!first) return null;
  let end = from + first[0].length;
  for (let segments = 1; segments < 8 && end - from < 60; segments++) {
    const join = REFERENCE_JOIN.exec(text.slice(end));
    if (!join) break;
    const afterJoin = end + join[0].length;
    const rest = text.slice(afterJoin);
    const next = REFERENCE_SEGMENT.exec(rest);
    if (!next || REFERENCE_BOUNDARY_WORD.test(next[0]) || looksLikeDateStart(rest)) break;
    end = afterJoin + next[0].length;
  }
  return text.slice(from, end);
}

/** Trims trailing punctuation and validates a candidate reference span: too short, too long or digit-free is not a reference. */
function cleanReferenceToken(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = collapse(raw).replace(/[.,;:]+$/, '');
  return trimmed.length >= 3 && trimmed.length <= 60 && /\d/.test(trimmed) ? trimmed : null;
}

/** The value written after a label in flowing text, e.g. "Kenmerk: 2026-041". A reference always contains a digit. */
function referenceIn(text: string, pairs: Array<[string, string]>): string | null {
  const fromPair = pairs.find(([label]) => REFERENCE_LABEL.test(label) && label.length <= 40)?.[1];
  if (fromPair) {
    const at = /[A-Za-z0-9]/.exec(fromPair)?.index;
    const token = at !== undefined ? cleanReferenceToken(referenceSpanAt(fromPair, at)) : null;
    if (token) return token;
  }
  const match = new RegExp(`${REFERENCE_LABEL.source}\\s*[:#-]?\\s*([A-Za-z0-9])`, 'i').exec(text);
  return match ? cleanReferenceToken(referenceSpanAt(text, match.index + match[0].length - 1)) : null;
}

/** Every distinct reference number and every distinct labeled deadline on the page: several of either means the page shows several procurements. */
function distinctReferenceAndDeadlines(text: string, pairs: Array<[string, string]>): { references: string[]; deadlines: string[] } {
  const references = new Set<string>();
  for (const [label, value] of pairs) if (REFERENCE_LABEL.test(label) && label.length <= 40) {
    const at = /[A-Za-z0-9]/.exec(value)?.index;
    const token = at !== undefined ? cleanReferenceToken(referenceSpanAt(value, at)) : null;
    if (token) references.add(token);
  }
  for (const match of text.matchAll(new RegExp(REFERENCE_LABEL.source + '\\s*[:#-]?\\s*([A-Za-z0-9])', 'gi'))) {
    const token = cleanReferenceToken(referenceSpanAt(text, match.index + match[0].length - 1));
    if (token) references.add(token);
  }
  const deadlines = new Set<string>();
  for (const [label, value] of pairs) if (DEADLINE_LABEL.test(label)) { const parsed = firstDate(value)?.date; if (parsed) deadlines.add(parsed); }
  for (const match of text.matchAll(new RegExp(DEADLINE_LABEL.source, 'gi'))) { const parsed = firstDate(text.slice(match.index + match[0].length, match.index + match[0].length + 90))?.date; if (parsed) deadlines.add(parsed); }
  // Flattened text glues neighbouring cells together ("GV-1Procedure"): a token that merely extends another one is the same reference.
  const all = [...references];
  return { references: all.filter(token => !all.some(other => other !== token && token.startsWith(other))), deadlines: [...deadlines] };
}

function deadlineIn(text: string, pairs: Array<[string, string]>): string | null {
  for (const [label, value] of pairs) if (DEADLINE_LABEL.test(label)) { const parsed = dateTimeIn(value); if (parsed) return parsed; }
  for (const match of text.matchAll(new RegExp(DEADLINE_LABEL.source, 'gi'))) {
    const parsed = dateTimeIn(text.slice(match.index + match[0].length, match.index + match[0].length + 90));
    if (parsed) return parsed;
  }
  return null;
}

function publicationDateIn(text: string, pairs: Array<[string, string]>): string | null {
  for (const [label, value] of pairs) if (PUBLICATION_LABEL.test(label)) { const parsed = firstDate(value)?.date; if (parsed) return parsed; }
  for (const match of text.matchAll(new RegExp(PUBLICATION_LABEL.source, 'gi'))) {
    const parsed = firstDate(text.slice(match.index + match[0].length, match.index + match[0].length + 60))?.date;
    if (parsed) return parsed;
  }
  return null;
}

/** Links on the page that point at a deeper page and read like a tender (link text or path), used to recognise an overview. */
function countTenderLinks($: CrawlPage['$'], url: string): number {
  let base: URL;
  try { base = new URL(url); } catch { return 0; }
  const seen = new Set<string>();
  $('a[href]').slice(0, 800).each((_, element) => {
    let target: URL;
    try { target = new URL($(element).attr('href') ?? '', base); } catch { return; }
    if (target.hostname !== base.hostname || target.pathname === base.pathname) return;
    if (/^(?:mailto|tel):/i.test($(element).attr('href') ?? '') || /\.(?:pdf|docx?|xlsx?|zip|jpe?g|png)$/i.test(target.pathname)) return;
    if ($(element).closest('nav,header,footer').length > 0) return;
    const label = collapse($(element).text());
    if (label.length < 6 || DOCUMENT_LINK_TEXT.test(label)) return;
    if (EXPLICIT_TENDER_WORD.test(label) || EXPLICIT_TENDER_WORD.test(decodeURIComponent(target.pathname))) seen.add(target.pathname);
  });
  return seen.size;
}

/** Distinct document links (pdf/doc/xls/zip) within `scope` — the whole page, or just one section. */
function documentLinksOf(scope: any): number {
  const seen = new Set<string>();
  querySelf(scope, 'a[href]').slice(0, 800).each((_: number, element: any) => {
    const href: string = element.attribs?.href ?? '';
    if (/\.(?:pdf|docx?|xlsx?|zip)(?:[?#].*)?$/i.test(href)) seen.add(href);
  });
  return seen.size;
}

/**
 * ccTLDs safe to read as "this site's own country": the ISO 3166-1 alpha-2 code each one maps to. Limited to ccTLDs
 * that are not routinely resold and used as a generic/vanity domain for something unrelated to that country — the
 * United Kingdom's ".uk" is included (with its ISO code "GB", not "uk") because it is not one of those; ".io", ".ai",
 * ".co", ".me", ".tv" and the like are deliberately left out (see PageCountryEvidence).
 */
const COUNTRY_CCTLD: Record<string, string> = Object.fromEntries([
  ['uk', 'GB'],
  ...['nl', 'be', 'de', 'fr', 'es', 'it', 'pt', 'at', 'ch', 'dk', 'se', 'no', 'fi', 'ie', 'lu', 'cz', 'sk', 'hu', 'pl', 'gr', 'ro', 'bg', 'hr', 'si', 'lt', 'lv', 'ee', 'mt', 'cy',
    'us', 'ca', 'au', 'nz', 'jp', 'cn', 'in', 'br', 'mx', 'za', 'kr', 'sg', 'ae', 'il', 'tr', 'ua'].map(cc => [cc, cc.toUpperCase()]),
]);

/** A clean ISO 3166-1 alpha-2 code, if `value` is nothing more than one — schema.org's own recommendation for `addressCountry`. */
function isoCountryCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

/** Every `addressCountry` value in the page's own structured data (schema.org PostalAddress, nested at any depth). */
function structuredAddressCountries(data: Record<string, unknown>[]): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    if ('addressCountry' in record) { const code = isoCountryCode(record.addressCountry); if (code) found.push(code); }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  for (const object of data) visit(object, 0);
  return found;
}

/** See PageCountryEvidence. */
function detectPageCountry(url: string, data: Record<string, unknown>[]): PageCountryEvidence {
  const codes = new Set<string>();
  try { const tld = new URL(url).hostname.toLowerCase().split('.').at(-1) ?? ''; const cc = COUNTRY_CCTLD[tld]; if (cc) codes.add(cc); } catch { /* an unparsable URL states nothing */ }
  for (const code of structuredAddressCountries(data)) codes.add(code);
  return codes.size === 1 ? { code: [...codes][0], confidence: 'explicit' } : { code: null, confidence: 'unknown' };
}

/**
 * Decides what one page is. Strong evidence of a concrete tender: a submission deadline, a reference number, CPV codes,
 * a named procedure, downloadable documents. Supporting evidence: a publication date, an authority under a
 * "contracting authority" style label, tender wording in the title or the first lines.
 *
 * A page is ONE concrete tender only when it has a title, at least two strong signals, and an intent (tender wording in
 * the title/URL/opening text, or a reference or CPV code, which only tender pages carry) — or one strong signal with
 * tender wording in the title plus a publication date or a labeled contracting authority. A page that lists several tenders is an overview even when
 * its items show deadlines. A page about how the organisation buys, without a deadline or reference, is general
 * information. Everything else is rejected with a reason so a run can report why.
 */
export function assessTenderPage(page: Pick<CrawlPage, '$' | 'url'>): TenderPageAssessment {
  const { $, url } = page;
  const text = bodyText($);
  const title = pageTitle($);
  const pairs = labelPairs($, $.root());
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { /* keep empty */ }
  const lastSegment = path.split('/').filter(Boolean).at(-1) ?? '';

  const deadline = deadlineIn(text, pairs);
  const reference = referenceIn(text, pairs);
  const distinct = distinctReferenceAndDeadlines(text, pairs);
  const cpvCodes = findCpv(text, pairs);
  // A procedure under a label is evidence; the same words in running text (news, policy pages) are not.
  const procedureLabeled = valueOf(pairs, PROCEDURE_LABEL);
  const procedure = procedureLabeled ?? PROCEDURE_TEXT.exec(text)?.[0] ?? null;
  const documentCount = documentLinksOf($.root());
  const publicationDate = publicationDateIn(text, pairs);
  const data = structuredData($);
  const authority = findAuthority($, pairs, text, data);
  const authorityLabeled = authority?.name ?? null;
  const publisher = findPublisher($, data);
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* keep empty */ }
  const role = classifySourceRole({ host, publisher, siteName: findSiteName($, data), authority: authorityLabeled, selfDescription: selfDescription($), firstPersonProcurement: FIRST_PERSON_PROCUREMENT.test(text) });
  const countryEvidence = detectPageCountry(url, data);
  const lead = text.slice(0, 700);
  const tenderWordInTitle = title !== null && EXPLICIT_TENDER_WORD.test(title);
  const tenderWordInUrl = EXPLICIT_TENDER_WORD.test(path.replace(/[-_/]+/g, ' '));
  const tenderWordInLead = EXPLICIT_TENDER_WORD.test(lead);

  const strong = [deadline && 'deadline', reference && 'reference', cpvCodes.length > 0 && 'cpv', procedureLabeled && 'procedure', documentCount > 0 && 'documents'].filter((s): s is string => Boolean(s));
  const supporting = [publicationDate && 'publication_date', authorityLabeled && 'labeled_authority', tenderWordInTitle && 'tender_word_in_title', tenderWordInLead && 'tender_word_in_lead'].filter((s): s is string => Boolean(s));
  const signals = [...strong, ...supporting];
  const tenderLinks = countTenderLinks($, url);
  const dateMentions = new Set([...text.matchAll(new RegExp(`${DATE_PATTERNS.map(([p]) => p.source).join('|')}`, 'gi'))].map(m => m[0])).size;

  const facts = (): TenderPageFacts => {
    const description = collapse($('meta[name="description"]').attr('content') ?? '')
      || collapse($('main p, article p, p').filter((_, el) => collapse($(el).text()).length >= 80).first().text());
    return {
      title,
      // Only an authority the page states (structured, labeled or a labeled sentence): the site name or publisher names the site, not the buyer.
      contractingAuthority: authorityLabeled ? authorityLabeled.slice(0, 200) : null,
      referenceNumber: reference,
      procedureType: procedure ? collapse(procedure).slice(0, 120) : null,
      contractType: (() => { const raw = valueOf(pairs, CONTRACT_LABEL); return raw ? raw.slice(0, 60) : null; })(),
      cpvCodes,
      location: valueOf(pairs, LOCATION_LABEL)?.slice(0, 120) ?? null,
      publicationDate,
      submissionDeadline: deadline,
      estimatedValue: amount(valueOf(pairs, VALUE_LABEL)),
      description: description ? description.slice(0, 2000) : null,
      documentCount,
    };
  };
  const result = (kind: TenderPageKind, rejection: TenderPageRejection | null, withFacts = false): TenderPageAssessment =>
    ({ url, kind, rejection, signals, tenderLinks, facts: withFacts ? facts() : null, publisher, authoritySource: authority?.source ?? null, role, countryEvidence });

  // One page that lists several tenders is an overview, even when every item shows a date.
  const listingPath = LISTING_SEGMENT.test(lastSegment);
  // A page with its own multi-word slug and two strong signals is one tender with a list of related ones, not a listing.
  const specificSlug = lastSegment.split(/[-_]/).filter(word => /[a-z]{2}/.test(word)).length >= 3;
  // Several different reference numbers (or three labeled deadlines) mean the page shows several procurements, not one.
  const multipleProcurements = !specificSlug && (distinct.references.length >= 2 || distinct.deadlines.length >= 3);
  const overview = multipleProcurements || (tenderLinks >= 4 && strong.length <= 1) || (tenderLinks >= 5 && dateMentions >= 3 && !(specificSlug && strong.length >= 2)) || (listingPath && strong.length <= 1 && tenderLinks >= 1);
  // Purchasing information ("Informatie voor leveranciers") that merely points to the tender list is general, not an overview.
  const looksGeneral = GENERAL_INFORMATION.test(title ?? '') || GENERAL_INFORMATION.test(path.replace(/[-_/]+/g, ' ')) || GENERAL_INFORMATION.test(lead);
  if (looksGeneral && !deadline && !reference && tenderLinks < 4) return result('general', 'general_procurement_information');
  if (overview) return result('overview', 'overview_page');
  if (looksGeneral && !deadline && !reference) return result('general', 'general_procurement_information');

  const intent = tenderWordInTitle || tenderWordInUrl || tenderWordInLead || reference !== null || cpvCodes.length > 0;
  // The opening text repeats the title, so tender wording there never counts as a second supporting signal.
  const corroborated = publicationDate !== null || authorityLabeled !== null;
  const concrete = title !== null && ((strong.length >= 2 && intent) || (strong.length >= 1 && tenderWordInTitle && corroborated));
  if (concrete) return result('detail', null, true);
  if (strong.length === 0 && !tenderWordInTitle) return result('none', 'no_tender_evidence');
  return result('none', 'insufficient_evidence');
}

// ─── Several procurements inline on one page (no separate links to follow — see domains/tenders/tests/inline-tender-items.test.mjs) ──

interface RawSection { headingText: string | null; anchor: string | null; scope: ReturnType<CrawlPage['$']> }

/**
 * The best group of "card" containers (article/li/section) that each carry their own heading: siblings under the same
 * parent, innermost only (an outer wrapper around several cards is never itself counted). The largest qualifying group
 * wins, in document order.
 */
const HEADINGS = 'h1,h2,h3,h4,h5,h6';
/** How many of `scope`'s own descendants (or `scope` itself) are one of the page's candidate headings. */
function headingsWithin($: CrawlPage['$'], scope: any, headingSet: Set<unknown>): number {
  return querySelf(scope, HEADINGS).toArray().filter((h: unknown) => headingSet.has(h)).length;
}

/**
 * Real markup rarely puts a heading directly inside the repeating item container: a CMS typically wraps each item in
 * one or more single-child divs first (an "item" div containing a "body" div containing the heading and its text).
 * So for every heading, this climbs from the heading itself, testing at each level whether that ancestor has two or
 * more siblings that also each contain a heading of their own — the first level (closest to the heading) where that
 * holds is the item boundary. Different headings on the same page can (and usually do) all resolve to the very same
 * group; only the distinct groups actually found are returned, largest first.
 */
function cardSections($: CrawlPage['$'], contentRoot: ReturnType<CrawlPage['$']>): RawSection[][] {
  const headings = querySelf(contentRoot, HEADINGS).toArray().filter((h: any) => $(h).closest('nav,header,footer').length === 0);
  if (headings.length < 2) return [];
  const headingSet = new Set(headings);
  const groups = new Map<unknown, any[]>();
  for (const heading of headings) {
    let container = $(heading);
    for (let depth = 0; depth < 8; depth++) {
      const parent = container.parent();
      if (parent.length === 0 || parent.is('body,html')) break;
      const siblings = parent.children().toArray();
      const matching = siblings.filter((s: any) => headingsWithin($, $(s), headingSet) >= 1);
      if (matching.length >= 2) { groups.set(parent[0], matching); break; }
      container = parent;
    }
  }
  // Every group of two or more siblings, largest first: a real "list of procurements" wrapper is rarely the only
  // same-shaped group on a page (a cookie-consent widget or a set of promo cards can look like one too), so
  // splitTenderPageSections tries each in turn and keeps the first one whose sections actually qualify.
  return [...groups.values()].sort((a, b) => b.length - a.length).map(list => {
    const parent = $(list[0]).parent();
    const order = parent.children().toArray();
    const sorted = [...list].sort((a: any, b: any) => order.indexOf(a) - order.indexOf(b));
    return sorted.map((el: any) => {
      const c = $(el);
      return { headingText: collapse(querySelf(c, HEADINGS).first().text()) || null, anchor: c.attr('id') ?? null, scope: c };
    });
  });
}

/**
 * Flat markup: a heading (h2, else h3, else h4 — the first level with two or more) plus the sibling nodes that follow it
 * up to the next heading of that level, all direct children of the same parent. Used when the page has no card-style
 * containers, only a run of headings and paragraphs at the same level (only tried once cardSections found nothing).
 */
function headingRunSections($: CrawlPage['$'], contentRoot: ReturnType<CrawlPage['$']>): RawSection[] {
  for (const tag of ['h2', 'h3', 'h4']) {
    const headings = querySelf(contentRoot, tag).toArray().map((el: any) => $(el)).filter((h: any) => h.closest('nav,header,footer').length === 0);
    if (headings.length < 2) continue;
    const parents = new Set(headings.map((h: any) => h.parent()[0]));
    if (parents.size !== 1) continue;
    const parent = headings[0].parent();
    const children: any[] = parent.children().toArray();
    const headingEls = new Set(headings.map((h: any) => h[0]));
    const indices = children.map((c, i) => (headingEls.has(c) ? i : -1)).filter(i => i >= 0);
    return indices.map((start, k) => {
      const end = k + 1 < indices.length ? indices[k + 1] : children.length;
      const nodes = children.slice(start, end);
      const headingEl = $(nodes[0]);
      return { headingText: collapse(headingEl.text()) || null, anchor: (headingEl.attr('id') as string | undefined) ?? null, scope: $(nodes) };
    });
  }
  return [];
}

/**
 * One inline procurement, scoped strictly to its own section: nothing outside `section.scope` is read, so one item's
 * reference/deadline/CPV/documents never leak into another. Qualifies only with its own heading AND its own reference
 * number or deadline (the identity-bearing signals) — documents or CPV alone are not enough, and general-information
 * wording in the heading disqualifies it. `authority` is looked up within the section only (no page-level structured
 * data, which is not item-specific); `publisher` and `role` are the page's own (one page belongs to one site).
 */
function buildSectionAssessment(
  $: CrawlPage['$'], section: RawSection, url: string, pagePublisher: string | null, pageRole: RoleAssessment, pageCountryEvidence: PageCountryEvidence,
): TenderPageAssessment | null {
  const { headingText, anchor, scope } = section;
  if (!headingText || headingText.length < 4 || headingText.length > 200 || GENERAL_INFORMATION.test(headingText)) return null;
  const text = textOf(scope);
  const pairs = labelPairs($, scope);
  const deadline = deadlineIn(text, pairs);
  const reference = referenceIn(text, pairs);
  if (!deadline && !reference) return null; // no signal of its own to identify or deduplicate it by
  const cpvCodes = findCpv(text, pairs);
  const documentCount = documentLinksOf(scope);
  const procedureLabeled = valueOf(pairs, PROCEDURE_LABEL);
  const procedure = procedureLabeled ?? PROCEDURE_TEXT.exec(text)?.[0] ?? null;
  const publicationDate = publicationDateIn(text, pairs);
  const authority = findAuthority($, pairs, text, []);
  const sectionUrl = anchor ? `${url}#${anchor}` : url;
  const sectionId = anchor ?? reference ?? slugify(headingText);
  const strong = [deadline && 'deadline', reference && 'reference', cpvCodes.length > 0 && 'cpv', procedureLabeled && 'procedure', documentCount > 0 && 'documents'].filter((s): s is string => Boolean(s));
  const supporting = [publicationDate && 'publication_date', authority && 'labeled_authority'].filter((s): s is string => Boolean(s));
  const description = collapse(querySelf(scope, 'p').filter((_: number, el: any) => collapse($(el).text()).length >= 40).first().text()) || null;
  return {
    url: sectionUrl, kind: 'detail', rejection: null,
    signals: [...strong, 'own_heading_section', ...supporting], tenderLinks: 0,
    facts: {
      title: headingText, contractingAuthority: authority?.name ?? null, referenceNumber: reference,
      procedureType: procedure ? collapse(procedure).slice(0, 120) : null,
      contractType: (() => { const raw = valueOf(pairs, CONTRACT_LABEL); return raw ? raw.slice(0, 60) : null; })(),
      cpvCodes, location: valueOf(pairs, LOCATION_LABEL)?.slice(0, 120) ?? null, publicationDate, submissionDeadline: deadline,
      estimatedValue: amount(valueOf(pairs, VALUE_LABEL)), description: description ? description.slice(0, 2000) : null, documentCount,
    },
    publisher: pagePublisher, authoritySource: authority?.source ?? null, role: pageRole, countryEvidence: pageCountryEvidence,
    sectionId, sectionAnchor: anchor, sectionHeading: headingText,
  };
}

/**
 * Splits one page into its several inline procurements, or returns [] when the page cannot be split with confidence.
 * Requires at least two sections that each independently qualify (own heading, own reference or deadline); a heading
 * with neither is simply left out, not turned into a record. Duplicate identities (two sections that resolve to the
 * same heading slug) are disambiguated by position, never by inventing a new value for a field.
 */
function buildAndDedupe($: CrawlPage['$'], sections: RawSection[], url: string, pagePublisher: string | null, pageRole: RoleAssessment, pageCountryEvidence: PageCountryEvidence): TenderPageAssessment[] {
  const built = sections.map(section => buildSectionAssessment($, section, url, pagePublisher, pageRole, pageCountryEvidence)).filter((item): item is TenderPageAssessment => item !== null);
  if (built.length < 2) return [];
  const seen = new Map<string, number>();
  for (const item of built) {
    const key = item.sectionId!;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) item.sectionId = `${key}-${count}`;
  }
  return built;
}

export function splitTenderPageSections($: CrawlPage['$'], url: string, pagePublisher: string | null, pageRole: RoleAssessment, pageCountryEvidence: PageCountryEvidence): TenderPageAssessment[] {
  const contentRoot = pickContentRoot($);
  // Several same-shaped sibling groups can exist on one real page (a cookie-consent widget can look like a card list
  // too) — the largest is tried first, but any group that actually yields two or more real procurements will do.
  for (const group of cardSections($, contentRoot)) {
    const built = buildAndDedupe($, group, url, pagePublisher, pageRole, pageCountryEvidence);
    if (built.length >= 2) return built;
  }
  return buildAndDedupe($, headingRunSections($, contentRoot), url, pagePublisher, pageRole, pageCountryEvidence);
}

/**
 * The normal single-page assessment, unless the page is an inline overview of several procurements written out on the
 * page itself (not one reached only through separate links — `tenderLinks < 2` — see splitTenderPageSections): then the
 * confidently-split procurements, one TenderPageAssessment (kind 'detail') each. General-information pages, news items and
 * link-based overviews are never affected: only a page that assessTenderPage already called 'overview' is tried.
 */
export function assessTenderPageMulti(page: Pick<CrawlPage, '$' | 'url'>): TenderPageAssessment | TenderPageAssessment[] {
  const single = assessTenderPage(page);
  if (single.kind !== 'overview' || single.tenderLinks >= 2) return single;
  const items = splitTenderPageSections(page.$, page.url, single.publisher, single.role, single.countryEvidence);
  return items.length >= 2 ? items : single;
}

/** The stable identity of a page-based tender: host + path (+ id-like query parameters). Titles and dates never take part. */
export function tenderPageIdentity(url: string): string {
  const parsed = new URL(url);
  const keep = [...parsed.searchParams.entries()].filter(([key]) => /^(?:id|nid|tenderid|tender|kenmerk|ref|reference|item|p|page_id|post)$/i.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${path}${keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join('&')}` : ''}`;
}

/** The identity of one procurement split out of a page (see splitTenderPageSections): the page's identity plus its own section characteristic. */
export function tenderPageItemIdentity(url: string, sectionId: string): string {
  return `${tenderPageIdentity(url)}#${slugify(sectionId)}`;
}

export const WEBSITE_SOURCE_ID = 'website';
export const SEARCH_SOURCE_ID = 'search';

/** What a website/search source hands to mapTenderPage. */
export interface TenderPageRaw {
  url: string;
  assessment: TenderPageAssessment;
  discovery: TenderDiscovery;
}

/** The record for a page-based tender; null when the page was not assessed as a concrete tender. */
export function mapTenderPage(raw: TenderPageRaw): TenderFacts | null {
  const facts = raw.assessment.facts;
  if (!facts || raw.assessment.kind !== 'detail') return null;
  const identity = raw.assessment.sectionId !== undefined ? tenderPageItemIdentity(raw.url, raw.assessment.sectionId) : tenderPageIdentity(raw.url);
  const publication = {
    publicationId: identity, noticeType: 'webpage', noticeTypeLabel: 'Webpagina', publicationDate: facts.publicationDate,
    submissionDeadline: facts.submissionDeadline, sourceUrl: raw.url,
  };
  return {
    sourceSystem: WEBSITE_SOURCE_ID, tenderIdentity: identity, publicationId: identity,
    title: facts.title, contractingAuthority: facts.contractingAuthority, referenceNumber: facts.referenceNumber,
    noticeType: 'webpage', noticeTypeLabel: 'Webpagina', procedureType: facts.procedureType, contractType: facts.contractType,
    cpvCodes: facts.cpvCodes, nutsCodes: [], location: facts.location, publicationDate: facts.publicationDate,
    submissionDeadline: facts.submissionDeadline, estimatedValue: facts.estimatedValue, description: facts.description,
    sourceUrl: raw.url, publications: [publication], discovery: raw.discovery,
  };
}
