import type { Activity, CompanyFacts, FieldChange } from './company-facts.js';

/**
 * Who a company is, across runs: its registrable web domain ("www.shop.voorbeeld.nl" -> "voorbeeld.nl"). Never its
 * name: two companies can share a name, and a group can have several trade names. A registration number would be the
 * stronger key, but only a number verified against the registry counts, and this version has no registry source, so a
 * number a website merely states is kept as information and never merges companies. Several sites of one group stay
 * separate companies; branches (vestigingen) on one domain are one company with several locations.
 */
const MULTI_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.nz', 'co.za', 'com.br', 'com.tr', 'co.jp', 'com.cn', 'com.mx', 'co.in']);

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\d?\./, '');
  const labels = host.split('.');
  if (labels.length <= 2 || /^\d+(?:\.\d+){3}$/.test(host)) return host;
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** The identity key and the canonical homepage of a company website URL. */
export function companyIdentity(url: string): { domain: string; website: string } {
  const parsed = new URL(url);
  const domain = registrableDomain(parsed.hostname);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return { domain, website: `${parsed.protocol}//${host}/` };
}

export const companyIdentityKey = (facts: Pick<CompanyFacts, 'identity'>) => `domain:${facts.identity}`;
export function storedCompanyIdentityKey(domainData: Record<string, unknown>): string | null {
  return typeof domainData.identity === 'string' && domainData.identity ? `domain:${domainData.identity}` : null;
}

/** A stored `domain_data` as CompanyFacts when it has the shape of one, else null. */
export function storedCompanyFacts(domainData: Record<string, unknown>): CompanyFacts | null {
  const d = domainData as Partial<CompanyFacts>;
  return typeof d.identity === 'string' && typeof d.domain === 'string' && Array.isArray(d.products) && Array.isArray(d.sources) ? d as CompanyFacts : null;
}

// ─── Updating a stored company ──────────────────────────────────────────────────────────────────────────────────────

const SINGLE_FIELDS = ['name', 'description', 'phone', 'email', 'contactUrl'] as const;
const LIST_FIELDS = ['industries', 'products', 'services', 'specialisations', 'customerSectors', 'roles'] as const;
/** Fields that change on every check and are not new information about the company. */
const volatile = (facts: CompanyFacts) => ({ ...facts, lastCheckedAt: '', search: null, discovery: null, sources: facts.sources.map(source => ({ ...source, checkedAt: '' })) });

/** JSON with object keys sorted: a profile read back from jsonb (which reorders keys) compares equal to the same profile. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

function mergeActivities<T extends Activity>(stored: T[], incoming: T[]): T[] {
  const out = stored.map(activity => ({ ...activity, evidence: [...activity.evidence] }));
  for (const activity of incoming) {
    const existing = out.find(other => other.kind === activity.kind && (activity.conceptId ? other.conceptId === activity.conceptId : other.label === activity.label));
    if (!existing) { out.push({ ...activity }); continue; }
    if (activity.strength === 'strong') existing.strength = 'strong';
    for (const quote of activity.evidence) if (!existing.evidence.some(e => e.url === quote.url) && existing.evidence.length < 5) existing.evidence.push(quote);
  }
  return out;
}

export interface CompanyUpdate { facts: CompanyFacts; changed: boolean }

/**
 * Merges what a later run found into a stored company. Nothing verified earlier is dropped: activities, locations, service
 * areas and sources are unions (an activity can only become stronger); a single-valued field that now reads differently
 * takes the new value and the previous one is kept in `changes`; a field the new run did not find keeps its stored value.
 * `changed` is false when the run found nothing new (only the check date and the search evaluation differ).
 */
export function updateStoredCompany(stored: CompanyFacts, incoming: CompanyFacts): CompanyUpdate {
  const at = incoming.lastCheckedAt;
  const changes: FieldChange[] = [...(stored.changes ?? [])];
  const facts: CompanyFacts = { ...stored };
  for (const field of SINGLE_FIELDS) {
    const next = incoming[field];
    if (next === null || next === undefined || next === stored[field]) continue;
    if (stored[field] !== null && stored[field] !== undefined) changes.push({ field, previous: stored[field], current: next, at });
    (facts as unknown as Record<string, unknown>)[field] = next;
  }
  for (const field of LIST_FIELDS) (facts as unknown as Record<string, unknown>)[field] = mergeActivities(stored[field] as Activity[], incoming[field] as Activity[]);
  facts.tradeNames = [...new Set([...stored.tradeNames, ...incoming.tradeNames])].slice(0, 8);
  // The same address read better (a known place where the stored reading had none) replaces the stored reading;
  // otherwise addresses are only added.
  const sameAddress = (a: CompanyFacts['locations'][number], b: CompanyFacts['locations'][number]) => (a.postcode ?? a.city) === (b.postcode ?? b.city);
  facts.locations = [
    ...stored.locations.map(s => incoming.locations.find(l => sameAddress(l, s) && l.province && !s.province) ?? s),
    ...incoming.locations.filter(l => !stored.locations.some(s => sameAddress(s, l))),
  ].slice(0, 15);
  facts.serviceAreas = [...stored.serviceAreas, ...incoming.serviceAreas.filter(a => !stored.serviceAreas.some(s => s.scope === a.scope && s.value === a.value))].slice(0, 20);
  facts.registration = {
    kvkNumber: stored.registration.kvkNumber ?? incoming.registration.kvkNumber,
    statedKvkNumber: incoming.registration.statedKvkNumber ?? stored.registration.statedKvkNumber,
    statedOn: incoming.registration.statedKvkNumber ? incoming.registration.statedOn : stored.registration.statedOn,
  };
  if (stored.registration.statedKvkNumber && incoming.registration.statedKvkNumber && stored.registration.statedKvkNumber !== incoming.registration.statedKvkNumber) {
    changes.push({ field: 'registration.statedKvkNumber', previous: stored.registration.statedKvkNumber, current: incoming.registration.statedKvkNumber, at });
  }
  const sources = stored.sources.map(source => ({ ...source, checkedAt: incoming.sources.some(s => s.url === source.url) ? at : source.checkedAt }));
  for (const source of incoming.sources) if (!sources.some(s => s.url === source.url)) sources.push(source);
  facts.sources = sources.slice(0, 60);
  facts.changes = changes.slice(-50);
  facts.lastCheckedAt = at;
  facts.discovery = stored.discovery;
  facts.search = incoming.search;
  const changed = canonical(volatile(facts)) !== canonical(volatile(stored));
  return { facts, changed };
}

/** Which profile fields are known (data completeness only; never a judgement of the company). */
export function companyProfileSignals(facts: CompanyFacts): { presentSignals: string[]; missingSignals: string[] } {
  const signals: Array<[string, boolean]> = [
    ['name', Boolean(facts.name)], ['description', Boolean(facts.description)], ['activities', [...facts.products, ...facts.services, ...facts.specialisations].length > 0],
    ['industry', facts.industries.length > 0], ['customerSectors', facts.customerSectors.some(a => a.strength === 'strong')], ['roles', facts.roles.length > 0],
    ['location', facts.locations.length > 0], ['serviceArea', facts.serviceAreas.length > 0], ['contact', Boolean(facts.phone || facts.email || facts.contactUrl)],
  ];
  return { presentSignals: signals.filter(([, ok]) => ok).map(([name]) => name), missingSignals: signals.filter(([, ok]) => !ok).map(([name]) => name) };
}
