import { MATCH_STATUS_LABELS, KIND_LABELS, provinceLabel } from '@discovery-platform/domain-companies/criteria';
import { useMemo, useState, type ReactNode } from 'react';
import type { DiscoveryRecord, RecordWithDetails } from '@discovery-platform/client';
import { registerDomainRenderer, EmptyValue, type DomainRenderer } from '../registry';
import { Badge, type BadgeTone } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { CompanyRunPanel, CompanyRunSummary } from './run-panel';

/**
 * Everything the Web App knows about a company record: the list (companies, not web pages), the detail page with the
 * evidence per criterion, and the filters. `CompanyFacts` mirrors domains/companies' own shape (company-facts.ts).
 */
type MatchStatus = 'confirmed' | 'possible' | 'insufficient';
interface Quote { url: string; pageType?: string; quote: string }
interface Activity { kind: string; conceptId: string | null; label: string; strength: 'strong' | 'weak'; evidence: Quote[]; role?: string }
interface Location { address: string | null; postcode: string | null; city: string | null; province: string | null; country: string | null; sourceUrl: string }
interface ServiceArea { scope: 'national' | 'province' | 'place'; value: string; quote: string; sourceUrl: string }
interface Match { kind: string; criterion: string; status: MatchStatus; found: string | null; sourceUrl: string | null; sourceType: string | null; quote: string | null; note: string | null; checkedAt: string }
export interface CompanyFacts {
  identity?: string; name?: string | null; tradeNames?: string[]; website?: string; domain?: string; description?: string | null;
  industries?: Activity[]; products?: Activity[]; services?: Activity[]; specialisations?: Activity[]; customerSectors?: Activity[]; roles?: Activity[];
  locations?: Location[]; serviceAreas?: ServiceArea[]; phone?: string | null; email?: string | null; contactUrl?: string | null;
  registration?: { kvkNumber: string | null; statedKvkNumber: string | null; statedOn: string | null };
  sources?: Array<{ url: string; type: string; pageType: string | null; title: string | null; checkedAt: string }>;
  lastCheckedAt?: string; changes?: Array<{ field: string; previous: unknown; current: unknown; at: string }>;
  discovery?: { via: string; query: string | null; searchProvider: string | null; searchSnippet: string | null } | null;
  search?: { criteria: string; status: MatchStatus; matches: Match[]; checkedAt: string } | null;
}

export const companyData = (record: DiscoveryRecord): CompanyFacts => record.domain_data as CompanyFacts;
const STATUS_TONE: Record<MatchStatus, BadgeTone> = { confirmed: 'success', possible: 'warning', insufficient: 'neutral' };
const SOURCE_TYPE_LABELS: Record<string, string> = { official_website: 'Eigen website', directory: 'Bedrijvengids', search_result: 'Zoekresultaat' };
const PAGE_TYPE_LABELS: Record<string, string> = { home: 'Homepage', about: 'Over ons', products: 'Producten', services: 'Diensten', sectors: 'Sectoren', projects: 'Projecten/referenties', contact: 'Contact', locations: 'Vestigingen', other: 'Overig' };
const MATCH_KIND_LABELS: Record<string, string> = { ...KIND_LABELS, query: 'Zoekterm', country: 'Land', province: 'Provincie', place: 'Plaats' };

export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}
const labels = (items: Activity[] | undefined, onlyStrong = false) => (items ?? []).filter(a => !onlyStrong || a.strength === 'strong').map(a => a.label);
const short = (values: string[], max = 3) => (values.length === 0 ? null : `${values.slice(0, max).join(', ')}${values.length > max ? ` (+${values.length - max})` : ''}`);
export const locationText = (l: Location) => [l.address, [l.postcode, l.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
function areaText(area: ServiceArea): string {
  if (area.scope === 'national') return 'Heel Nederland';
  if (area.scope === 'province') return provinceLabel(area.value) ?? area.value;
  return area.value;
}
function SourceLink({ url, children }: { url: string | null | undefined; children?: ReactNode }) {
  if (!url) return EmptyValue;
  return <a href={url} target="_blank" rel="noreferrer" className="break-all text-brand-700 hover:underline">{children ?? url}</a>;
}
export function MatchBadge({ status }: { status: MatchStatus | undefined }) {
  if (!status) return <Badge tone="neutral">Niet beoordeeld</Badge>;
  return <Badge tone={STATUS_TONE[status]}>{MATCH_STATUS_LABELS[status]}</Badge>;
}

// ─── Filters ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Filters { industry: string; product: string; service: string; role: string; customer: string; region: string; status: string }
const NO_FILTERS: Filters = { industry: '', product: '', service: '', role: '', customer: '', region: '', status: '' };
const regionsOf = (f: CompanyFacts) => [
  ...(f.locations ?? []).flatMap(l => [l.city, l.province ? provinceLabel(l.province) : null]),
  ...(f.serviceAreas ?? []).map(areaText),
].filter((value): value is string => Boolean(value));

export function filterCompanies(records: DiscoveryRecord[], filters: Filters): DiscoveryRecord[] {
  return records.filter(record => {
    const f = companyData(record);
    const has = (items: Activity[] | undefined, value: string, onlyStrong = false) => !value || labels(items, onlyStrong).includes(value);
    return has(f.industries, filters.industry) && has([...(f.products ?? []), ...(f.specialisations ?? [])], filters.product) && has(f.services, filters.service)
      && has(f.roles, filters.role) && has(f.customerSectors, filters.customer, true)
      && (!filters.region || regionsOf(f).includes(filters.region)) && (!filters.status || f.search?.status === filters.status);
  });
}

function CompanyFilters({ records, children }: { records: DiscoveryRecord[]; children: (visible: DiscoveryRecord[]) => ReactNode }) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const options = useMemo(() => {
    const collect = (pick: (f: CompanyFacts) => string[]) => [...new Set(records.flatMap(r => pick(companyData(r))))].sort((a, b) => a.localeCompare(b, 'nl'));
    return {
      industry: collect(f => labels(f.industries)), product: collect(f => labels([...(f.products ?? []), ...(f.specialisations ?? [])])), service: collect(f => labels(f.services)),
      role: collect(f => labels(f.roles)), customer: collect(f => labels(f.customerSectors, true)), region: collect(regionsOf),
    };
  }, [records]);
  const visible = filterCompanies(records, filters);
  const select = (key: keyof Filters, label: string, values: string[] | Array<[string, string]>) => (
    <label className="flex flex-col text-xs font-medium text-slate-500">
      {label}
      <select aria-label={label} value={filters[key]} onChange={e => setFilters(current => ({ ...current, [key]: e.target.value }))}
        className="mt-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800">
        <option value="">Alle</option>
        {values.map(value => (Array.isArray(value) ? <option key={value[0]} value={value[0]}>{value[1]}</option> : <option key={value} value={value}>{value}</option>))}
      </select>
    </label>
  );
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-3">
        {select('status', 'Verificatiestatus', Object.entries(MATCH_STATUS_LABELS))}
        {select('industry', 'Branche', options.industry)}
        {select('product', 'Product / specialisatie', options.product)}
        {select('service', 'Dienst', options.service)}
        {select('role', 'Bedrijfsrol', options.role)}
        {select('customer', 'Levert aan', options.customer)}
        {select('region', 'Regio', options.region)}
        <span className="pb-2 text-xs text-slate-500">{visible.length} van {records.length} bedrijven</span>
      </div>
      {children(visible)}
    </div>
  );
}

// ─── Detail sections ────────────────────────────────────────────────────────────────────────────────────────────────

function MatchesSection({ facts }: { facts: CompanyFacts }) {
  const search = facts.search;
  if (!search) return null;
  return (
    <Card aria-label="Bewijs per criterium">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Waarom dit bedrijf aansluit</CardTitle>
          <MatchBadge status={search.status} />
        </div>
        <p className="text-sm text-slate-500">Zoekopdracht: {search.criteria} · gecontroleerd {formatDate(search.checkedAt)}</p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-400"><th className="py-2 pr-3">Criterium</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Gevonden</th><th className="py-2 pr-3">Bron</th><th className="py-2">Toelichting</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {search.matches.map((match, index) => (
                <tr key={index} className="align-top">
                  <td className="py-2 pr-3"><span className="block text-xs text-slate-400">{MATCH_KIND_LABELS[match.kind] ?? match.kind}</span>{match.criterion}</td>
                  <td className="py-2 pr-3"><MatchBadge status={match.status} /></td>
                  <td className="py-2 pr-3">{match.found ?? EmptyValue}{match.quote && <q className="mt-1 block text-xs text-slate-500">{match.quote}</q>}</td>
                  <td className="py-2 pr-3">{match.sourceUrl ? <SourceLink url={match.sourceUrl}>{SOURCE_TYPE_LABELS[match.sourceType ?? ''] ?? 'Bron'}</SourceLink> : match.sourceType ? SOURCE_TYPE_LABELS[match.sourceType] : EmptyValue}</td>
                  <td className="py-2 text-xs text-slate-600">{match.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ActivitiesSection({ facts }: { facts: CompanyFacts }) {
  const groups: Array<[string, Activity[] | undefined]> = [
    ['Branches', facts.industries], ['Producten', facts.products], ['Diensten', facts.services], ['Specialisaties', facts.specialisations],
    ['Levert aan (afnemerssectoren)', facts.customerSectors], ['Bedrijfsrollen', facts.roles],
  ];
  if (groups.every(([, items]) => !items?.length)) return null;
  return (
    <Card aria-label="Gevonden activiteiten">
      <CardHeader><CardTitle>Gevonden activiteiten en bewijs</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {groups.filter(([, items]) => items?.length).map(([title, items]) => (
          <div key={title}>
            <h3 className="mb-1 text-sm font-semibold text-slate-700">{title}</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {items!.map(activity => (
                <li key={`${activity.kind}:${activity.label}`}>
                  <span className="font-medium">{activity.label}</span>{' '}
                  <Badge tone={activity.strength === 'strong' ? 'success' : 'neutral'}>{activity.strength === 'strong' ? 'Specifiek onderbouwd' : 'Terloops genoemd'}</Badge>
                  {activity.evidence.slice(0, 2).map(quote => (
                    <span key={quote.url} className="mt-0.5 block text-xs text-slate-500">
                      <q>{quote.quote}</q> — <SourceLink url={quote.url}>{PAGE_TYPE_LABELS[quote.pageType ?? ''] ?? 'pagina'}</SourceLink>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SourcesSection({ facts }: { facts: CompanyFacts }) {
  const sources = facts.sources ?? [];
  return (
    <Card aria-label="Bronnen">
      <CardHeader><CardTitle>Bronnen</CardTitle></CardHeader>
      <CardContent>
        {sources.length === 0 ? <p className="text-sm text-slate-500">Geen bronnen.</p> : (
          <ul className="flex flex-col gap-1 text-sm">
            {sources.map(source => (
              <li key={source.url}>
                <SourceLink url={source.url}>{source.title ?? source.url}</SourceLink>
                <span className="text-xs text-slate-500"> · {SOURCE_TYPE_LABELS[source.type] ?? source.type}{source.pageType ? `, ${PAGE_TYPE_LABELS[source.pageType] ?? source.pageType}` : ''} · gecontroleerd {formatDate(source.checkedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {facts.discovery?.via === 'web_search' && facts.discovery.query && <p className="mt-3 text-xs text-slate-500">Gevonden via zoekopdracht “{facts.discovery.query}”. Een zoekresultaat alleen geldt niet als bewijs.</p>}
        {(facts.changes ?? []).length > 0 && (
          <div className="mt-3">
            <h3 className="text-sm font-semibold text-slate-700">Wijzigingen</h3>
            <ul className="text-xs text-slate-600">
              {facts.changes!.map((change, index) => <li key={index}>{formatDate(change.at)}: {change.field} van “{String(change.previous)}” naar “{String(change.current)}”</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Renderer ───────────────────────────────────────────────────────────────────────────────────────────────────────

const companiesRenderer: DomainRenderer = {
  recordLabelPlural: 'Bedrijven',
  columns: [
    { key: 'name', label: 'Bedrijf' },
    { key: 'industry', label: 'Branche' },
    { key: 'location', label: 'Vestiging' },
    { key: 'activities', label: 'Producten / diensten' },
    { key: 'website', label: 'Website' },
    { key: 'match', label: 'Match' },
    { key: 'checked', label: 'Laatst gecontroleerd' },
  ],
  renderCell(record, columnKey) {
    const f = companyData(record);
    switch (columnKey) {
      case 'name': return record.display_name ?? f.name ?? f.domain ?? EmptyValue;
      case 'industry': return short(labels(f.industries)) ?? EmptyValue;
      case 'location': {
        const first = f.locations?.[0];
        return first?.city ? <span>{first.city}{(f.locations?.length ?? 0) > 1 ? ` (+${f.locations!.length - 1})` : ''}</span> : <span className="text-slate-400">Onbekend</span>;
      }
      case 'activities': return short([...labels(f.products), ...labels(f.specialisations), ...labels(f.services)], 4) ?? EmptyValue;
      case 'website': return f.domain ?? EmptyValue;
      case 'match': return <MatchBadge status={f.search?.status} />;
      case 'checked': return formatDate(f.lastCheckedAt) ?? EmptyValue;
      default: return EmptyValue;
    }
  },
  renderDetailFields(record: RecordWithDetails) {
    const f = companyData(record);
    const list = (values: string[]) => (values.length ? values.join(', ') : EmptyValue);
    return [
      { label: 'Bedrijfsnaam', value: f.name ?? EmptyValue },
      { label: 'Handelsnamen', value: list(f.tradeNames ?? []) },
      { label: 'Website', value: <SourceLink url={f.website} /> },
      { label: 'Omschrijving (eigen website)', value: f.description ?? EmptyValue },
      { label: 'Branches', value: list(labels(f.industries)) },
      { label: 'Producten', value: list(labels(f.products)) },
      { label: 'Diensten', value: list(labels(f.services)) },
      { label: 'Specialisaties', value: list(labels(f.specialisations)) },
      { label: 'Bedrijfsrollen', value: list(labels(f.roles)) },
      { label: 'Levert aan (onderbouwd)', value: list(labels(f.customerSectors, true)) },
      { label: 'Vestiging(en)', value: (f.locations ?? []).length ? <ul>{f.locations!.map(l => <li key={l.sourceUrl + (l.postcode ?? l.city)}>{locationText(l)} <SourceLink url={l.sourceUrl}>bron</SourceLink></li>)}</ul> : 'Onbekend' },
      { label: 'Aantoonbaar werkgebied', value: (f.serviceAreas ?? []).length ? <ul>{f.serviceAreas!.map(a => <li key={a.scope + a.value}>{areaText(a)} <SourceLink url={a.sourceUrl}>bron</SourceLink></li>)}</ul> : 'Onbekend' },
      { label: 'Telefoon (algemeen)', value: f.phone ?? EmptyValue },
      { label: 'E-mail (algemeen)', value: f.email ?? EmptyValue },
      { label: 'Contactpagina', value: <SourceLink url={f.contactUrl} /> },
      { label: 'KvK-nummer', value: f.registration?.kvkNumber ?? (f.registration?.statedKvkNumber ? <span>{f.registration.statedKvkNumber} <span className="text-xs text-slate-500">(vermeld op de eigen website, niet geverifieerd)</span></span> : EmptyValue) },
      { label: 'Laatst gecontroleerd', value: formatDate(f.lastCheckedAt) ?? EmptyValue },
    ];
  },
  renderDetailSections: record => {
    const f = companyData(record);
    return <><MatchesSection facts={f} /><ActivitiesSection facts={f} /><SourcesSection facts={f} /></>;
  },
  RunPanel: CompanyRunPanel,
  RunSummary: CompanyRunSummary,
  RecordsView: CompanyFilters,
};

registerDomainRenderer('companies', companiesRenderer);
