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
function text(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}
function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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

export function extractVacancyText(pageText: string): Partial<VacancyFacts> {
  const facts: Partial<VacancyFacts> = {};
  const location = afterLabel(pageText, ['locatie', 'location', 'standplaats', 'werklocatie']);
  if (location) facts.location = location;
  const salary = afterLabel(pageText, ['salaris', 'salary', 'salarisindicatie']);
  if (salary) facts.salary = salary;
  const hours = afterLabel(pageText, ['uren', 'werkuren', 'hours', 'aantal uur']);
  if (hours) facts.hours = hours;
  const contractType = afterLabel(pageText, ['contractsoort', 'contract type', 'contracttype', 'dienstverband']);
  if (contractType) facts.contractType = contractType;
  const contactPerson = afterLabel(pageText, ['contactpersoon', 'contact person']);
  if (contactPerson) facts.contactPerson = contactPerson;
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

/**
 * schema.org JobPosting structured data — the same @graph-walking approach discovery/src/
 * extractors/accommodation.ts already uses for its own Accommodation/Hotel/VacationRental
 * types, applied to a completely different @type. Structured data always outranks the
 * text-label fallback above for any field it actually supplies.
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
    const company = text(object(n.hiringOrganization).name); if (company) facts.company = company;

    const address = object(object(n.jobLocation).address);
    const locationParts = [text(address.addressLocality), text(address.addressRegion)].filter((v): v is string => Boolean(v));
    if (locationParts.length) facts.location = [...new Set(locationParts)].join(', ');

    const salaryObj = object(n.baseSalary);
    const salaryValue = object(salaryObj.value);
    const amount = typeof salaryValue.value === 'number' ? String(salaryValue.value)
      : typeof salaryValue.minValue === 'number' && typeof salaryValue.maxValue === 'number' ? `${salaryValue.minValue}-${salaryValue.maxValue}`
      : null;
    if (amount) facts.salary = [text(salaryObj.currency), amount, text(salaryValue.unitText)].filter(Boolean).join(' ');

    const employmentType = text(Array.isArray(n.employmentType) ? n.employmentType[0] : n.employmentType);
    if (employmentType) facts.contractType = employmentType;

    const description = text(n.description, 10_000);
    if (description) facts.description = stripHtml(description);

    return facts;
  });
}

/**
 * One crawled page → zero or more VacancyFacts. Composes, in order of trust: structured
 * JobPosting data (page-level, needs the DOM — never routed through DomainConfig.extractText,
 * since that seam only ever sees plain text, not the DOM), then the plain-text label fallback,
 * then generic contact details discovery-core's own crawler already extracted for this page. A
 * page with only a `<title>` and nothing else specific is never reported — a title alone is too
 * weak a signal that this was really a vacancy page, not just any page on the site.
 */
export function extractVacancy(page: CrawlPage): VacancyFacts[] | undefined {
  const bodyText = page.$('body').clone().find('script, style, noscript').remove().end().text();
  const textFacts = normalizeVacancyFacts(extractVacancyText(bodyText));
  const jsonLdFacts = extractJobPostingJsonLd(page.$);
  const titleTag = text(page.$('title').first().text()) ?? text(page.$('h1').first().text());

  function build(structured: Partial<VacancyFacts>): VacancyFacts {
    return {
      title: structured.title ?? titleTag ?? null,
      company: structured.company ?? null,
      location: structured.location ?? textFacts.location ?? null,
      salary: structured.salary ?? textFacts.salary ?? null,
      hours: textFacts.hours ?? null,
      contractType: structured.contractType ?? textFacts.contractType ?? null,
      description: structured.description ?? null,
      contactPerson: textFacts.contactPerson ?? null,
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
