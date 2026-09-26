import { tenderOpportunityStatus } from '@discovery-platform/domain-tenders/presentation';
import { combineLinkedTenders, linkTenders } from '@discovery-platform/domain-tenders/links';
import type { ReactNode } from 'react';
import type { DiscoveryRecord, RecordWithDetails } from '@discovery-platform/client';
import { registerDomainRenderer, EmptyValue, type DomainRenderer } from '../registry';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { TenderRunPanel, TenderRunSummary } from './run-panel';

/**
 * Everything the Web App knows about a tender record lives in this folder (renderer, run form, run summary).
 * `TenderFacts` mirrors domains/tenders' own shape (see domains/tenders/src/tender-facts.ts); the generic record
 * components only ever call the DomainRenderer below.
 */
export interface TenderPublication {
  publicationId: string;
  noticeType?: string | null;
  noticeTypeLabel?: string | null;
  publicationDate?: string | null;
  submissionDeadline?: string | null;
  sourceUrl?: string | null;
  /** The TED publication number TenderNed states for this publication: the key that links the two records. */
  tedPublicationNumber?: string | null;
}
export interface TenderDiscovery {
  via?: 'website_crawl' | 'web_search';
  host?: string | null;
  query?: string | null;
  searchProvider?: string | null;
  discoveredFrom?: string | null;
  evidence?: string[];
  mode?: 'website' | 'search' | 'auto';
  sourceRole?: 'official_organization_site' | 'aggregator' | 'unknown_web_source';
  roleConfidence?: 'high' | 'medium' | 'low';
  roleEvidence?: string[];
  publisher?: string | null;
  authoritySource?: 'structured' | 'label' | 'prose_label' | null;
}
export interface TenderFacts {
  sourceSystem?: string | null;
  tenderIdentity?: string | null;
  publicationId?: string | null;
  title?: string | null;
  contractingAuthority?: string | null;
  referenceNumber?: string | null;
  noticeType?: string | null;
  noticeTypeLabel?: string | null;
  procedureType?: string | null;
  contractType?: string | null;
  cpvCodes?: Array<{ code: string; description?: string | null; main?: boolean }>;
  nutsCodes?: Array<{ code: string; description?: string | null }>;
  location?: string | null;
  publicationDate?: string | null;
  submissionDeadline?: string | null;
  estimatedValue?: { amount: number; currency: string } | null;
  description?: string | null;
  sourceUrl?: string | null;
  publications?: TenderPublication[];
  discovery?: TenderDiscovery | null;
}

/** Where a tender comes from, in the words a user knows: TenderNed, TED, or a website (of an organisation, or found by a search). */
export function tenderOrigin(facts: TenderFacts): string {
  if (facts.sourceSystem === 'tenderned') return 'TenderNed';
  if (facts.sourceSystem === 'ted') return 'TED';
  if (facts.sourceSystem === 'website') return facts.discovery?.via === 'web_search' ? 'Website (ontdekt via zoekopdracht)' : 'Website van organisatie';
  return facts.sourceSystem ?? 'Onbekend';
}
const ROLE_LABELS: Record<string, string> = {
  official_organization_site: 'Officiële site van de organisatie', aggregator: 'Aggregator (verzamelt aanbestedingen van anderen)', unknown_web_source: 'Onbekende webbron',
};
const MODE_LABELS: Record<string, string> = { website: 'Website-run', search: 'Zoek-run', auto: 'Automatische run' };
const AUTHORITY_SOURCE_LABELS: Record<string, string> = { structured: 'gestructureerde data', label: 'expliciet label op de pagina', prose_label: 'benoemd in de tekst' };
/** Short role label for the list; empty for TenderNed and TED. */
export const tenderRoleLabel = (facts: TenderFacts): string | null => (facts.discovery?.sourceRole ? ROLE_LABELS[facts.discovery.sourceRole].split(' (')[0] : null);
const EVIDENCE_LABELS: Record<string, string> = {
  deadline: 'sluitingsdatum', reference: 'kenmerk', cpv: 'CPV', procedure: 'procedure', documents: 'documenten', publication_date: 'publicatiedatum',
  labeled_authority: 'aanbestedende dienst', tender_word_in_title: 'aanbesteding in titel', tender_word_in_lead: 'aanbesteding in tekst',
};

export const tenderData = (record: DiscoveryRecord): TenderFacts => record.domain_data as TenderFacts;

/** "2026-11-02T08:00:00" (a Dutch local date-time as published) -> "02-11-2026 08:00"; a bare date -> "02-11-2026". */
export function formatTenderDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  return `${day}-${month}-${year}${hour ? ` ${hour}:${minute}` : ''}`;
}

/** True when the record was changed after it was created (a later publication was merged into it). */
export function isUpdatedRecord(record: Pick<DiscoveryRecord, 'created_at' | 'updated_at'>): boolean {
  return new Date(record.updated_at).getTime() - new Date(record.created_at).getTime() > 1000;
}

const cpvSummary = (facts: TenderFacts): ReactNode => {
  const codes = facts.cpvCodes ?? [];
  if (codes.length === 0) return EmptyValue;
  const main = codes.find(code => code.main) ?? codes[0];
  return <span>{main.code}{main.description ? ` · ${main.description}` : ''}{codes.length > 1 ? ` (+${codes.length - 1})` : ''}</span>;
};
const locationSummary = (facts: TenderFacts): ReactNode => {
  const nuts = (facts.nutsCodes ?? []).map(entry => entry.code).join(', ');
  if (!facts.location && !nuts) return EmptyValue;
  return <span>{facts.location ?? ''}{facts.location && nuts ? ' ' : ''}{nuts ? `(${nuts})` : ''}</span>;
};
const noticeLabel = (facts: TenderFacts | TenderPublication): string | null =>
  facts.noticeTypeLabel ?? facts.noticeType ?? null;

const OPPORTUNITY_LABELS = { open: 'Open', expired: 'Verlopen / gegund', unknown: 'Onbekend' } as const;
const SOURCE_NAMES: Record<string, string> = { tenderned: 'TenderNed', ted: 'TED' };
const sourceName = (sourceSystem: string | null | undefined): string => SOURCE_NAMES[sourceSystem ?? ''] ?? sourceSystem ?? 'onbekend';

function SourceLink({ url }: { url?: string | null }) {
  if (!url) return EmptyValue;
  return <a href={url} target="_blank" rel="noreferrer" className="break-all text-brand-700 hover:underline">{url}</a>;
}

function PublicationHistory({ record }: { record: RecordWithDetails }) {
  const facts = tenderData(record);
  const publications = facts.publications ?? [];
  const updated = isUpdatedRecord(record);
  return (
    <>
      {updated && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">Bijgewerkt op {new Date(record.updated_at).toLocaleString('nl-NL')}</p>
          <p>Een latere publicatie van deze aanbesteding is samengevoegd met dit record. Laatste publicatie: {noticeLabel(facts) ?? 'onbekend'}
            {facts.publicationDate ? ` (${formatTenderDate(facts.publicationDate)})` : ''}; {publications.length} publicatie{publications.length === 1 ? '' : 's'} in totaal.</p>
        </div>
      )}
      <Card>
        <CardHeader><CardTitle>Publicatiehistorie</CardTitle></CardHeader>
        <CardContent className="p-0">
          {publications.length === 0 ? (
            <p className="px-6 py-6 text-sm text-slate-500">Geen publicaties vastgelegd.</p>
          ) : (
            <ol aria-label="Publicaties" className="divide-y divide-slate-100">
              {[...publications].reverse().map(publication => {
                const latest = publication.publicationId === facts.publicationId;
                return (
                  <li key={publication.publicationId} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                    <div>
                      <p className="text-sm font-medium text-slate-800">
                        {noticeLabel(publication) ?? 'Publicatie'} <span className="font-normal text-slate-500">· {publication.publicationId}</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        Gepubliceerd {formatTenderDate(publication.publicationDate) ?? '—'}
                        {publication.submissionDeadline ? ` · sluiting ${formatTenderDate(publication.submissionDeadline)}` : ''}
                      </p>
                      {publication.sourceUrl && <a href={publication.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">Bekijk op de bron</a>}
                    </div>
                    <div className="flex items-center gap-2">
                      {publication.noticeType && <Badge tone="neutral">{publication.noticeType}</Badge>}
                      {latest && <Badge tone="info">Laatste</Badge>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </>
  );
}

const tendersRenderer: DomainRenderer = {
  recordLabelPlural: 'Tenders',
  tableClassName: 'tender-results-table',
  columns: [
    { key: 'title', label: 'Aanbesteding' },
    { key: 'authority', label: 'Aanbestedende dienst' },
    { key: 'deadline', label: 'Sluitingsdatum' },
    { key: 'opportunity', label: 'Opdrachtstatus' },
    { key: 'procedure', label: 'Procedure' },
    { key: 'cpv', label: 'CPV' },
    { key: 'location', label: 'Locatie / NUTS' },
    { key: 'notice', label: 'Laatste publicatie' },
    { key: 'origin', label: 'Herkomst' },
  ],
  renderCell(record, columnKey) {
    const facts = tenderData(record);
    switch (columnKey) {
      case 'title': return (
        <span>
          {record.display_name ?? facts.title ?? EmptyValue}
          {isUpdatedRecord(record) && <Badge tone="warning" className="ml-2 align-middle">Bijgewerkt</Badge>}
        </span>
      );
      case 'authority': return facts.contractingAuthority ?? EmptyValue;
      case 'opportunity': {
        const state = tenderOpportunityStatus(facts);
        return <Badge tone={state === 'open' ? 'success' : 'neutral'}>{OPPORTUNITY_LABELS[state]}</Badge>;
      }
      case 'deadline': return formatTenderDate(facts.submissionDeadline) ?? EmptyValue;
      case 'procedure': return facts.procedureType ?? EmptyValue;
      case 'cpv': return cpvSummary(facts);
      case 'location': return locationSummary(facts);
      case 'notice': return noticeLabel(facts) ?? EmptyValue;
      case 'origin': return <span>{tenderOrigin(facts)}{tenderRoleLabel(facts) ? <span className="block text-xs text-slate-500">{tenderRoleLabel(facts)}</span> : null}</span>;
      default: return EmptyValue;
    }
  },
  renderDetailFields(record: RecordWithDetails) {
    const facts = tenderData(record);
    const list = <T,>(items: T[] | undefined, render: (item: T) => ReactNode): ReactNode =>
      items && items.length > 0 ? <ul className="list-disc pl-4">{items.map((item, index) => <li key={index}>{render(item)}</li>)}</ul> : EmptyValue;
    return [
      { label: 'Aanbesteding', value: facts.title ?? EmptyValue },
      { label: 'Aanbestedende dienst', value: facts.contractingAuthority ?? EmptyValue },
      { label: 'Kenmerk (tender-identiteit)', value: facts.tenderIdentity ?? EmptyValue },
      { label: 'Herkomst', value: tenderOrigin(facts) },
      ...(facts.discovery ? [
        { label: 'Bronrol', value: facts.discovery.sourceRole ? `${ROLE_LABELS[facts.discovery.sourceRole]}${facts.discovery.roleConfidence ? ` · zekerheid ${facts.discovery.roleConfidence}` : ''}` : EmptyValue },
        { label: 'Uitgever van de site (publisher)', value: facts.discovery.publisher ?? EmptyValue },
        { label: 'Aanbestedende dienst gevonden via', value: facts.discovery.authoritySource ? AUTHORITY_SOURCE_LABELS[facts.discovery.authoritySource] : EmptyValue },
        { label: 'Run-modus', value: facts.discovery.mode ? MODE_LABELS[facts.discovery.mode] : EmptyValue },
        { label: 'Gevonden op', value: facts.discovery.host ?? EmptyValue },
        { label: 'Gevonden met zoekopdracht', value: facts.discovery.query ?? EmptyValue },
        { label: 'Gevonden via pagina', value: <SourceLink url={facts.discovery.discoveredFrom} /> },
        { label: 'Bewijs voor "concrete aanbesteding"', value: facts.discovery.evidence && facts.discovery.evidence.length > 0 ? facts.discovery.evidence.map(item => EVIDENCE_LABELS[item] ?? item).join(', ') : EmptyValue },
      ] : []),
      { label: 'Referentienummer', value: facts.referenceNumber ?? EmptyValue },
      { label: 'Laatste publicatie-ID', value: facts.publicationId ?? EmptyValue },
      { label: 'Publicatietype', value: noticeLabel(facts) ? `${noticeLabel(facts)}${facts.noticeType && facts.noticeTypeLabel ? ` (${facts.noticeType})` : ''}` : EmptyValue },
      { label: 'Procedure', value: facts.procedureType ?? EmptyValue },
      { label: 'Soort opdracht', value: facts.contractType ?? EmptyValue },
      { label: 'CPV-codes', value: list(facts.cpvCodes, code => <>{code.code}{code.description ? ` · ${code.description}` : ''}{code.main ? ' (hoofd)' : ''}</>) },
      { label: 'NUTS', value: list(facts.nutsCodes, nuts => <>{nuts.code}{nuts.description ? ` · ${nuts.description}` : ''}</>) },
      { label: 'Locatie', value: facts.location ?? EmptyValue },
      { label: 'Publicatiedatum', value: formatTenderDate(facts.publicationDate) ?? EmptyValue },
      { label: 'Sluitingsdatum', value: formatTenderDate(facts.submissionDeadline) ?? EmptyValue },
      { label: 'Geraamde waarde', value: facts.estimatedValue ? `${facts.estimatedValue.currency} ${facts.estimatedValue.amount.toLocaleString('nl-NL')}` : EmptyValue },
      { label: 'Beschrijving', value: facts.description ? <p className="whitespace-pre-line">{facts.description}</p> : EmptyValue },
      { label: 'Bronlink', value: <SourceLink url={facts.sourceUrl} /> },
    ];
  },
  renderDetailSections: record => <PublicationHistory record={record} />,
  RunPanel: TenderRunPanel,
  RunSummary: TenderRunSummary,
  groupRecords: records => linkTenders(records.map(record => ({ ...tenderData(record), record }))).map(group => group.map(member => member.record)),
  renderGroupCell(records, columnKey) {
    const combined = combineLinkedTenders(records.map(record => ({ ...tenderData(record), record })));
    const { members } = combined;
    const sourced = (value: { value: string; sourceSystem: string } | null, format: (v: string) => ReactNode = v => v): ReactNode =>
      value ? <span>{format(value.value)}<span className="block text-xs text-slate-500">volgens {sourceName(value.sourceSystem)}</span></span> : EmptyValue;
    switch (columnKey) {
      case 'title': return (
        <span>
          {combined.title?.value ?? members[0].record.display_name ?? EmptyValue}
          <Badge tone="neutral" className="ml-2 align-middle">{members.map(m => sourceName(m.sourceSystem)).join(' + ')}</Badge>
          {members.some(m => isUpdatedRecord(m.record)) && <Badge tone="warning" className="ml-2 align-middle">Bijgewerkt</Badge>}
        </span>
      );
      case 'authority': return sourced(combined.contractingAuthority);
      case 'deadline': return sourced(combined.submissionDeadline, v => formatTenderDate(v) ?? v);
      case 'opportunity': return <Badge tone={combined.status === 'open' ? 'success' : 'neutral'}>{OPPORTUNITY_LABELS[combined.status]}</Badge>;
      case 'procedure': return sourced(combined.procedureType);
      case 'cpv': return cpvSummary(members.find(m => (m.cpvCodes ?? []).length > 0) ?? members[0]);
      case 'location': return locationSummary(members.find(m => m.location || (m.nutsCodes ?? []).length > 0) ?? members[0]);
      // Per source: its own latest publication, its own deadline (or that it states none) and its own link.
      case 'notice': return (
        <ul>{members.map(m => <li key={m.record.id}>{sourceName(m.sourceSystem)}: {noticeLabel(m) ?? '—'}</li>)}</ul>
      );
      case 'origin': return (
        <ul>{members.map(m => (
          <li key={m.record.id}>
            {m.sourceUrl ? <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{sourceName(m.sourceSystem)} ↗</a> : sourceName(m.sourceSystem)}
            <span className="block text-xs text-slate-500">{m.submissionDeadline ? `sluit ${formatTenderDate(m.submissionDeadline) ?? m.submissionDeadline}` : 'geen sluitingsdatum gepubliceerd'}</span>
          </li>
        ))}</ul>
      );
      default: return EmptyValue;
    }
  },
};

registerDomainRenderer('tenders', tendersRenderer);
export { tendersRenderer };
