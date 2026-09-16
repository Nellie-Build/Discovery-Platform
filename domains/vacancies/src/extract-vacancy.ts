import type { CheerioAPI } from 'cheerio';
import type { CrawlPage } from '@discovery-platform/core';

/** Only explicit source facts — a field stays `null` rather than being guessed. No AI, no
 * inference beyond "this exact structured field, label or contact pattern was actually there". */
export interface VacancyFacts {
  title: string | null;
  company: string | null;
  location: string | null;
  salary: string | null;
  hours: string | null;
  contractType: string | null;
  description: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  sourceUrl: string;
}

function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
/** The first array entry (or the bare value) that is actually an object — schema.org properties
 * like `hiringOrganization`/`jobLocation` are documented as single-or-array-of values. */
function firstObject(v: unknown): Record<string, unknown> {
  for (const entry of array(v)) { const o = object(entry); if (Object.keys(o).length) return o; }
  return {};
}
function text(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}
function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function dedupeJoin(parts: (string | null)[], sep: string): string | null {
  const seen = [...new Set(parts.filter((v): v is string => Boolean(v)))];
  return seen.length ? seen.join(sep) : null;
}

/**
 * Plain-text, label-based extraction ("Locatie: Amsterdam", "Salaris: €2.800 - €3.400 per
 * maand") — the exact `(text: string) => Partial<TFacts>` shape @discovery-platform/core's
 * `DomainConfig.extractText` already documents (see packages/discovery-core/src/
 * domain-config.ts). Every pattern requires an explicit label immediately before the value —
 * never a bare number/word picked up from unrelated surrounding text.
 */
function afterLabel(text_: string, labels: string[], maxLen = 120): string | null {
  for (const label of labels) {
    const match = new RegExp(`\\b${label}\\b\\s*[:\\-]\\s*([^\\n\\r]{1,${maxLen}})`, 'i').exec(text_);
    if (!match) continue;
    // Stop at the first sentence break or a run of 2+ spaces (the start of unrelated layout
    // text), never the full rest of the line.
    const value = match[1].split(/[.;]\s|\s{2,}/)[0].trim();
    if (value) return value;
  }
  return null;
}

/** Field labels recognized both in plain running text ("Label: value" on one line) and as a
 * standalone DOM label element paired with a neighboring value element (dt/dd, th/td, a
 * strong/bold tag followed by its sibling). Dutch and English variants only — never a bare word
 * without an explicit label role next to it. */
const LABEL_GROUPS: Record<'location' | 'salary' | 'hours' | 'contractType' | 'contactPerson' | 'company', string[]> = {
  location: ['locatie', 'location', 'standplaats', 'werklocatie'],
  salary: ['salaris', 'salary', 'salarisindicatie'],
  hours: ['uren', 'werkuren', 'hours', 'aantal uur'],
  contractType: ['contractsoort', 'contract type', 'contracttype', 'dienstverband'],
  contactPerson: ['contactpersoon', 'contact person'],
  company: ['werkgever', 'organisatie', 'employer', 'company'],
};

export function extractVacancyText(pageText: string): Partial<VacancyFacts> {
  const facts: Partial<VacancyFacts> = {};
  for (const [field, labels] of Object.entries(LABEL_GROUPS) as [keyof typeof LABEL_GROUPS, string[]][]) {
    const value = afterLabel(pageText, labels);
    if (value) facts[field] = value;
  }
  return facts;
}

/** The exact `(facts: Partial<TFacts>) => Partial<TFacts>` shape `DomainConfig.normalize`
 * documents — collapses whitespace and drops anything that normalized down to empty. */
export function normalizeVacancyFacts(facts: Partial<VacancyFacts>): Partial<VacancyFacts> {
  const cleaned: Partial<VacancyFacts> = {};
  for (const [key, value] of Object.entries(facts) as [keyof VacancyFacts, unknown][]) {
    if (typeof value !== 'string') continue;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed) (cleaned as Record<string, string>)[key] = trimmed;
  }
  return cleaned;
}

/** A label word matches only when it is the *entire* trimmed text of a DOM element (minus a
 * trailing colon) — never a substring of a longer sentence, so this never fires on running body
 * copy that merely mentions "locatie" in passing. */
function matchLabelElement(labelText: string): keyof typeof LABEL_GROUPS | null {
  const norm = labelText.trim().replace(/[:：]\s*$/, '').trim().toLowerCase();
  if (!norm || norm.length > 40) return null;
  for (const [field, labels] of Object.entries(LABEL_GROUPS) as [keyof typeof LABEL_GROUPS, string[]][]) {
    if (labels.includes(norm)) return field;
  }
  return null;
}

/**
 * Generic semantic DOM label/value extraction — no site-specific selectors, only structural HTML
 * patterns any vacancy site might reasonably use: definition lists (dt/dd), tables (th/td within
 * one row), and a label element (dt/th/strong/b/span/div/p/li) immediately followed, within its
 * own parent, by the value — either a sibling element or trailing inline text. Only fires when
 * the label element's own text is *exactly* one of the known label words; the paired value is
 * read from the very next node, never guessed from surrounding content.
 */
function extractLabelValueDom($: CheerioAPI): Partial<VacancyFacts> {
  const facts: Partial<VacancyFacts> = {};
  const setOnce = (field: keyof typeof LABEL_GROUPS, raw: string | null | undefined) => {
    if (field in facts) return;
    const value = text((raw ?? '').replace(/^[\s:：\-–]+/, ''), 200);
    if (value) facts[field] = value;
  };

  $('dt').slice(0, 300).each((_i, el) => {
    const field = matchLabelElement($(el).text());
    if (field) setOnce(field, $(el).next('dd').text());
  });

  $('tr').slice(0, 300).each((_i, row) => {
    const th = $(row).children('th').first();
    if (!th.length) return;
    const field = matchLabelElement(th.text());
    if (field) setOnce(field, $(row).children('td').first().text());
  });

  $('strong, b, span, div, p, li, label').slice(0, 500).each((_i, el) => {
    const $el = $(el);
    const field = matchLabelElement($el.text());
    if (!field) return;
    const siblings = $el.parent().contents().toArray();
    const idx = siblings.indexOf(el);
    if (idx < 0) return;
    // Walk forward past purely-whitespace text nodes (common formatting between a label element
    // and its value, e.g. "<span>Locatie</span> <span>Amsterdam</span>") to the first node that
    // actually carries text — still always the *next* real content, never a further search.
    for (let j = idx + 1; j < siblings.length; j++) {
      const node = siblings[j];
      const raw = node.type === 'text' ? (node as unknown as { data: string }).data : $(node).text();
      if (!raw.trim()) continue;
      setOnce(field, raw);
      break;
    }
  });

  return facts;
}

/**
 * A duly semantic, standards-based description block only — schema.org microdata's own
 * `itemprop="description"` hook (the microdata sibling of the JSON-LD `JobPosting.description`
 * property this file already reads above), never a guess at which `<div>` "looks like" the body
 * copy. If a page doesn't mark its description this way, `description` stays `null` rather than
 * capturing the whole page.
 */
function extractDescriptionDom($: CheerioAPI): string | null {
  const el = $('[itemprop="description"]').first();
  if (!el.length) return null;
  const html = el.html();
  if (!html) return null;
  const value = stripHtml(html);
  return value.length > 40 ? value.slice(0, 10_000) : null;
}

/**
 * schema.org JobPosting structured data — the same @graph-walking approach discovery/src/
 * extractors/accommodation.ts already uses for its own Accommodation/Hotel/VacationRental
 * types, applied to a completely different @type. Structured data always outranks the
 * text-label fallback above for any field it actually supplies. Tolerant of the schema.org
 * variations real sites actually emit: `@type` as a string or array, JobPosting nested inside
 * `@graph`, `hiringOrganization`/`jobLocation` as a single object or an array of them, and
 * `employmentType` as a string or array.
 */
export function extractJobPostingJsonLd($: CheerioAPI): Partial<VacancyFacts>[] {
  const nodes: Record<string, unknown>[] = [];
  function visit(v: unknown, depth = 0) {
    if (depth > 10 || nodes.length > 200) return;
    if (Array.isArray(v)) { v.slice(0, 200).forEach(x => visit(x, depth + 1)); return; }
    const n = object(v);
    if (!Object.keys(n).length) return;
    nodes.push(n);
    if (n['@graph']) visit(n['@graph'], depth + 1);
  }
  $('script[type="application/ld+json"]').slice(0, 30).each((_i, el) => {
    const raw = $(el).text();
    if (raw.length > 200_000) return;
    try { visit(JSON.parse(raw)); } catch { /* Invalid structured data is not evidence. */ }
  });

  return nodes.filter(n => array(n['@type']).includes('JobPosting')).map(n => {
    const facts: Partial<VacancyFacts> = {};
    const title = text(n.title); if (title) facts.title = title;
    const company = text(firstObject(n.hiringOrganization).name); if (company) facts.company = company;

    const locationParts = array(n.jobLocation).map(loc => {
      const address = object(object(loc).address);
      return dedupeJoin([text(address.streetAddress), text(address.addressLocality), text(address.addressRegion)], ', ');
    });
    const location = dedupeJoin(locationParts, '; ');
    if (location) facts.location = location;

    const salaryObj = object(n.baseSalary);
    const salaryValue = object(salaryObj.value);
    const amount = typeof salaryValue.value === 'number' ? String(salaryValue.value)
      : typeof salaryValue.minValue === 'number' && typeof salaryValue.maxValue === 'number' ? `${salaryValue.minValue}-${salaryValue.maxValue}`
      : null;
    if (amount) facts.salary = [text(salaryObj.currency), amount, text(salaryValue.unitText)].filter(Boolean).join(' ');

    const employmentTypes = [...new Set(array(n.employmentType).map(t => text(t)).filter((v): v is string => Boolean(v)))];
    if (employmentTypes.length) facts.contractType = employmentTypes.join(', ');

    const description = text(n.description, 10_000);
    if (description) facts.description = stripHtml(description);

    return facts;
  });
}

/**
 * One crawled page → zero or more VacancyFacts. Composes, in order of trust: structured
 * JobPosting data (page-level, needs the DOM — never routed through DomainConfig.extractText,
 * since that seam only ever sees plain text, not the DOM), then the plain-text label fallback,
 * then the generic DOM label/value fallback, then generic contact details discovery-core's own
 * crawler already extracted for this page. A page with only a `<title>` and nothing else
 * specific is never reported — a title alone is too weak a signal that this was really a
 * vacancy page, not just any page on the site.
 */
export function extractVacancy(page: CrawlPage): VacancyFacts[] | undefined {
  const bodyText = page.$('body').clone().find('script, style, noscript').remove().end().text();
  const textFacts = normalizeVacancyFacts(extractVacancyText(bodyText));
  const domLabelFacts = normalizeVacancyFacts(extractLabelValueDom(page.$));
  const domDescription = extractDescriptionDom(page.$);
  const jsonLdFacts = extractJobPostingJsonLd(page.$);
  // A vacancy detail page's function title is best read from its own first meaningful <h1> —
  // the <title> tag routinely carries an unrelated site-wide suffix ("... - Werken bij de
  // Overheid") that is never part of the actual job title. <title> is only ever a fallback for
  // when no h1 is present at all.
  const titleTag = text(page.$('h1').first().text()) ?? text(page.$('title').first().text());

  function build(structured: Partial<VacancyFacts>): VacancyFacts {
    return {
      title: structured.title ?? titleTag ?? null,
      company: structured.company ?? textFacts.company ?? domLabelFacts.company ?? null,
      location: structured.location ?? textFacts.location ?? domLabelFacts.location ?? null,
      salary: structured.salary ?? textFacts.salary ?? domLabelFacts.salary ?? null,
      hours: textFacts.hours ?? domLabelFacts.hours ?? null,
      contractType: structured.contractType ?? textFacts.contractType ?? domLabelFacts.contractType ?? null,
      description: structured.description ?? domDescription ?? null,
      contactPerson: textFacts.contactPerson ?? domLabelFacts.contactPerson ?? null,
      phone: page.contacts.phone ?? null,
      email: page.contacts.email ?? null,
      sourceUrl: page.url,
    };
  }

  const hasJsonLd = jsonLdFacts.length > 0;
  const results = (hasJsonLd ? jsonLdFacts : [{}]).map(build);
  // Structured JobPosting data is definitive on its own; without it, at least one specific
  // field beyond the ever-present page title must be genuinely present.
  const meaningful = results.filter(r => hasJsonLd ||
    [r.company, r.location, r.salary, r.hours, r.contractType, r.description, r.phone, r.email].some(v => v !== null));
  return meaningful.length ? meaningful : undefined;
}
