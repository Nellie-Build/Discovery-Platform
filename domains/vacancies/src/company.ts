import type { CheerioAPI } from 'cheerio';

/**
 * Employer ("company") extraction for a vacancy page: which source may name the employer, how
 * strong each source is, and when a candidate is not an organisation name at all. Nothing here is
 * tied to one site: no hostname, class name, employer name or heading of one particular site.
 *
 * Precedence, strongest first (a weaker source never overrides a stronger one):
 *  1. `json_ld`             JobPosting `hiringOrganization.name`
 *  2. `microdata`           schema.org `itemprop="hiringOrganization"` / `name`
 *  3. `explicit_label`      a label element with exactly the text "Werkgever" / "Organisatie" /
 *                           "Bedrijf" / "Employer" / "Company" ... followed by its value (dt/dd,
 *                           th/td, label + sibling, data-* hooks)
 *  4. `organization_block`  `itemprop="employer"`, a name-specific employer/company/organisation
 *                           element, or an "Over <Name>" heading whose name also appears in the
 *                           page title
 *  5. `text_fallback`       "Werkgever: <Name>" at the start of a line of running text, and only if
 *                           the value looks like an organisation name
 *  6. `none`                no reliable employer: the company stays empty (null beats a wrong name)
 *
 * The word "organisatie" in ordinary body text is never evidence: only a label at the start of a
 * line, or a label element, counts.
 */
export type CompanySource = 'json_ld' | 'microdata' | 'explicit_label' | 'organization_block' | 'text_fallback' | 'none';

export type CompanyStrength = 'explicit' | 'text';

const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Call-to-action, navigation and page-chrome text: never an employer. */
const CTA_OR_NAVIGATION = /^(?:solliciteer|solliciteren|apply|bekijk|lees\s+meer|meer\s+(?:informatie|info|lezen)|terug|home|menu|contact|login|inloggen|zoek|zoeken|vacatures?|alle\s+vacatures|over\s+ons|naar\s+overzicht|klik|deel|delen|print|bewaar|share|more\s+information|read\s+more|back)\b/i;
/** Words of running prose addressed to the reader — organisation names do not contain them. */
const ADDRESSES_READER = /\b(?:je|jij|jouw|jou|wij|we|ons|onze|ik|mijn|you|your|our)\b/i;
/** Vacancy content: terms of employment and duties, never an employer. */
const VACANCY_CONTENT = /(?:€|\bfte\b|\buur\b|\buren\b|\bper\s+(?:week|maand|jaar|uur)\b|\bsalaris\b|\bervaring\b|\bopleiding\b|\bverantwoordelijk|\bvacature\b|\bsolliciteer|\bfunctie\b|\bwerkzaamheden\b|\btaken\b)/i;
/** Lowercase words that may open a real name ("de Bijenkorf", "van der Valk"). */
const NAME_PREFIXES = new Set(['de', 'het', 'van', 'von', 'der', 'den', 'ten', 'ter', 'la', 'le', 'the']);
/** A trailing full stop is fine for an abbreviation ("B.V.", "Inc.", "N.V."), not after a plain word. */
const ENDS_WITH_ABBREVIATION = /(?:\b[A-Za-z]{1,2}\.[A-Za-z]{1,2}\.|\b(?:inc|ltd|co|corp|bv|nv|gmbh|e\.a|c\.s|a\.o)\.)$/i;

/**
 * Whether `raw` can be an organisation name, and its cleaned form (whitespace collapsed) — or null.
 *
 * `explicit` is for a value a structural signal already labelled as the employer: only obvious
 * non-names (empty, call-to-action, a whole paragraph) are refused. `text` is for a value found in
 * running text next to a label: it must also look like an organisation, and is refused when it looks
 * like a sentence fragment, contains employment terms, or addresses the reader. Long names with
 * several words ("Ministerie van Defensie", "Dienst Justitiële Inrichtingen", "Company & Partners")
 * and acronyms ("TNO") stay valid: nothing is refused merely for its length in words or a full stop.
 */
export function assessCompanyName(raw: string | null | undefined, strength: CompanyStrength): string | null {
  const value = collapse(raw ?? '');
  if (value.length < 2 || value.length > 150) return null;
  if (CTA_OR_NAVIGATION.test(value)) return null;
  const words = value.split(' ');
  if (strength === 'explicit') {
    if (/[:?!]$/.test(value)) return null;
    if (words.length > 12 && /[.!?]/.test(value)) return null;
    return value;
  }
  if (value.length > 90 || words.length > 9) return null;
  if (!/[\p{Lu}\p{N}]/u.test(value)) return null; // an all-lowercase fragment is not a name
  const first = words[0];
  if (/^\p{Ll}/u.test(first) && !NAME_PREFIXES.has(first.toLowerCase())) return null;
  if (/[:;?!]/.test(value) || /\.\s+\S/.test(value)) return null; // a sentence, or several
  if (/\.$/.test(value) && !ENDS_WITH_ABBREVIATION.test(value)) return null;
  if (ADDRESSES_READER.test(value) || VACANCY_CONTENT.test(value)) return null;
  return value;
}

/**
 * "Werkgever: <Name>" as a line of running text. The label must open the line (after an optional
 * bullet) and be followed by a colon or a spaced dash; "organisatie-inrichting" or
 * "Aansturen organisatie: je vertaalt ..." in the middle of a sentence never matches.
 */
export function extractCompanyFromText(pageText: string): string | null {
  const pattern = /^[ \t]*(?:[-•*·▪]\s*)?(?:werkgever|organisatie|employer|company|bedrijf)[ \t]*(?::|[ \t][-–—][ \t])[ \t]*(\S[^\n\r]*)$/gim;
  for (const match of pageText.matchAll(pattern)) {
    const candidate = assessCompanyName(match[1].split(/;|\s{3,}|\t|\s\|\s/)[0], 'text');
    if (candidate) return candidate;
  }
  return null;
}

const NAME_SPECIFIC = [
  'employer-name', 'employer__name', 'employername', 'company-name', 'company__name', 'companyname',
  'organization-name', 'organisation-name', 'organization__name', 'organisation__name', 'hiring-organization', 'hiring-organisation',
].map(token => `[class*="${token}" i], [id*="${token}" i]`).join(', ');

const NOT_A_NAME_AFTER_OVER = /^(?:ons|onze|mij|mijzelf|jou|jouw|jezelf|de|het|een|deze|dit|die|dat|werken|us|our|you|the|this|these|those)\b/i;

/**
 * Delimited employer blocks: an `employer` microdata property, an element whose class/id says it is
 * the employer's (or company's / organisation's) *name*, and an "Over <Name>" / "About <Name>"
 * heading — the last only when that name also appears in the page's own title and is not the job's
 * location, so a section about a city or a team is never taken for the employer.
 */
export function extractOrganizationBlock($: CheerioAPI, context: { title: string | null; location: string | null; nonContentSelector: string }): string | null {
  const inContent = (el: unknown) => $(el as never).closest(context.nonContentSelector).length === 0;
  for (const el of $('[itemprop="employer"]').toArray().filter(inContent)) {
    const name = assessCompanyName($(el).find('[itemprop="name"]').first().text() || $(el).text(), 'explicit');
    if (name) return name;
  }
  for (const el of $(NAME_SPECIFIC).toArray().filter(inContent)) {
    const name = assessCompanyName($(el).text(), 'explicit');
    if (name) return name;
  }
  const title = context.title?.toLowerCase() ?? '';
  const location = context.location?.toLowerCase() ?? '';
  for (const el of $('h2, h3').toArray().filter(inContent)) {
    const match = /^(?:over|about)\s+(\S.{1,80})$/i.exec(collapse($(el).text()));
    if (!match || NOT_A_NAME_AFTER_OVER.test(match[1])) continue;
    const name = assessCompanyName(match[1], 'text');
    if (!name || !title.includes(name.toLowerCase()) || location.includes(name.toLowerCase())) continue;
    return name;
  }
  return null;
}

export interface CompanyCandidates {
  /** JobPosting JSON-LD `hiringOrganization.name` (already the node's own value). */
  jsonLd?: string | null;
  microdata?: string | null;
  explicitLabel?: string | null;
  organizationBlock?: string | null;
  text?: string | null;
}

/** The strongest usable candidate, and which source it came from. */
export function chooseCompany(candidates: CompanyCandidates): { value: string | null; source: CompanySource } {
  const clean = (value: string | null | undefined) => { const v = collapse(value ?? ''); return v || null; };
  const jsonLd = clean(candidates.jsonLd);
  if (jsonLd) return { value: jsonLd, source: 'json_ld' };
  const microdata = clean(candidates.microdata);
  if (microdata) return { value: microdata, source: 'microdata' };
  const explicit = assessCompanyName(candidates.explicitLabel, 'explicit');
  if (explicit) return { value: explicit, source: 'explicit_label' };
  const block = assessCompanyName(candidates.organizationBlock, 'explicit');
  if (block) return { value: block, source: 'organization_block' };
  const text = assessCompanyName(candidates.text, 'text');
  if (text) return { value: text, source: 'text_fallback' };
  return { value: null, source: 'none' };
}
