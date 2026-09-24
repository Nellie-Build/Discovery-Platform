import { useState, type FormEvent } from 'react';
import { ApiError, type DiscoveryRun, type SourceRunInput } from '@discovery-platform/client';
import { api } from '../../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input, Label, FieldError } from '../../components/ui/input';
import { Badge, statusBadgeTone } from '../../components/ui/badge';
import { SegmentedControl, type SegmentedControlOption } from '../../components/ui/segmented-control';

/**
 * The tenders module's own "start a run" form and run summary. Three ways to look for tenders, clearly apart:
 *  - Zoeken: branch, keywords, country/region and CPV; Discovery finds the sources and tender pages itself (sourceId "search");
 *  - Directe bron: one known source, TenderNed, TED or a website URL;
 *  - Automatisch: every suitable source at once (TenderNed, TED and the web search), "auto".
 * Every mode is one `source` run against the API; nothing tender-specific lives outside this folder.
 */
export const TENDER_SOURCE_ID = 'tenderned';
export const MAX_RANGE_DAYS = 14;
export const MAX_TARGET = 200;

export type TenderRunMode = 'search' | 'direct' | 'auto';
export type TenderDirectSource = 'tenderned' | 'ted' | 'website';

export interface TenderRunFields {
  mode: TenderRunMode;
  source: TenderDirectSource;
  branch: string;
  keywords: string;
  country: string;
  region: string;
  url: string;
  publishedFrom: string;
  publishedTo: string;
  cpvPrefixes: string;
  nutsPrefixes: string;
  target: string;
}

export const COUNTRY_OPTIONS = [
  { value: 'NL', label: 'Nederland' }, { value: 'BE', label: 'België' }, { value: 'DE', label: 'Duitsland' }, { value: 'FR', label: 'Frankrijk' },
];

const MODE_OPTIONS: SegmentedControlOption<TenderRunMode>[] = [
  { value: 'search', label: 'Zoeken' }, { value: 'direct', label: 'Directe bron' }, { value: 'auto', label: 'Automatisch' },
];
const SOURCE_OPTIONS: SegmentedControlOption<TenderDirectSource>[] = [
  { value: 'tenderned', label: 'TenderNed' }, { value: 'ted', label: 'TED' }, { value: 'website', label: 'Website-URL' },
];
const MODE_HELP: Record<TenderRunMode, string> = {
  search: 'Geef een branche en/of zoektermen op. Discovery zoekt zelf op het web naar aanbestedingen en leest alleen pagina’s die één concrete opdracht beschrijven.',
  direct: 'Haal aanbestedingen uit één bekende bron: TenderNed, TED of de website van een organisatie.',
  auto: 'Gebruikt alle geschikte bronnen tegelijk: TenderNed, TED en (als die is ingesteld) het zoeken op het web. Zoektermen filteren de resultaten van TenderNed en TED.',
};

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function defaultTenderRunFields(now: Date = new Date()): TenderRunFields {
  const yesterday = new Date(now.getTime() - 86_400_000);
  return {
    mode: 'search', source: 'tenderned', branch: '', keywords: '', country: 'NL', region: '', url: '',
    publishedFrom: localDate(yesterday), publishedTo: localDate(now), cpvPrefixes: '', nutsPrefixes: '', target: '20',
  };
}
const list = (value: string) => value.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);

/** Returns the request for the API, or the first thing the user has to fix. */
export function buildTenderRunRequest(fields: TenderRunFields): { request: SourceRunInput } | { error: string } {
  const filters: Record<string, unknown> = {};
  const usesPeriod = fields.mode === 'auto' || (fields.mode === 'direct' && fields.source !== 'website');
  if (usesPeriod) {
    if (fields.publishedFrom) filters.publishedFrom = fields.publishedFrom;
    if (fields.publishedTo) filters.publishedTo = fields.publishedTo;
    if (fields.publishedFrom && fields.publishedTo) {
      const days = (Date.parse(fields.publishedTo) - Date.parse(fields.publishedFrom)) / 86_400_000 + 1;
      if (Number.isNaN(days) || days < 1) return { error: 'De einddatum ligt voor de begindatum.' };
      if (days > MAX_RANGE_DAYS) return { error: `De periode mag maximaal ${MAX_RANGE_DAYS} dagen beslaan.` };
    }
  }
  const cpv = list(fields.cpvPrefixes);
  if (cpv.some(prefix => !/^\d{2,8}$/.test(prefix))) return { error: 'Een CPV-prefix bestaat uit 2 tot 8 cijfers (bijvoorbeeld 45 of 45000000).' };
  const nuts = list(fields.nutsPrefixes).map(prefix => prefix.toUpperCase());
  if (nuts.some(prefix => !/^[A-Z]{2}[A-Z0-9]{0,3}$/.test(prefix))) return { error: 'Een NUTS-prefix begint met twee letters (bijvoorbeeld NL33).' };
  if (cpv.length > 0) filters.cpvPrefixes = cpv;
  const usesNuts = fields.mode === 'auto' || (fields.mode === 'direct' && fields.source !== 'website');
  if (usesNuts && nuts.length > 0) filters.nutsPrefixes = nuts;
  const target = Number(fields.target);
  if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET) return { error: `Het gewenste aantal is een getal van 1 tot ${MAX_TARGET}.` };
  const runConfig = { targetRecords: target };

  if (fields.mode === 'search' || fields.mode === 'auto') {
    const branch = fields.branch.trim();
    const keywords = fields.keywords.trim();
    if (fields.mode === 'search' && !branch && !keywords) return { error: 'Geef een branche of zoektermen op om naar aanbestedingen te zoeken.' };
    if (branch) filters.branch = branch;
    if (keywords) filters.keywords = keywords;
    if (fields.region.trim()) filters.region = fields.region.trim();
    filters.country = fields.country;
    return { request: { sourceId: fields.mode === 'search' ? 'search' : 'auto', filters, runConfig } };
  }
  if (fields.source === 'website') {
    const url = fields.url.trim();
    if (!url) return { error: 'Geef de URL van een website op.' };
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) throw new Error('invalid');
      filters.url = parsed.href;
    } catch { return { error: 'De website-URL is ongeldig (bijvoorbeeld https://www.voorbeeld.nl/aanbestedingen).' }; }
    return { request: { sourceId: 'website', filters, runConfig } };
  }
  return { request: { sourceId: fields.source, filters, runConfig } };
}

const START_LABELS: Record<string, string> = { tenderned: 'Start TenderNed-run', ted: 'Start TED-run', website: 'Crawl website', search: 'Zoek aanbestedingen', auto: 'Start automatische run' };
const startLabel = (fields: TenderRunFields) => START_LABELS[fields.mode === 'direct' ? fields.source : fields.mode];

export function TenderRunPanel({ projectId, onStarted }: { projectId: string; onStarted: (run: DiscoveryRun) => void }) {
  const [fields, setFields] = useState<TenderRunFields>(() => defaultTenderRunFields());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (key: keyof TenderRunFields) => (event: { target: { value: string } }) => setFields(current => ({ ...current, [key]: event.target.value }));
  const showText = fields.mode === 'search' || fields.mode === 'auto';
  const showPeriod = fields.mode === 'auto' || (fields.mode === 'direct' && fields.source !== 'website');
  const showNuts = showPeriod;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const built = buildTenderRunRequest(fields);
    if ('error' in built) { setError(built.error); return; }
    setSubmitting(true);
    setError(null);
    try {
      onStarted(await api.runs.startSourceRun(projectId, built.request));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kon de run niet starten.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Aanbestedingen ontdekken</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <SegmentedControl name="Zoekmodus" options={MODE_OPTIONS} value={fields.mode} onChange={mode => { setFields(current => ({ ...current, mode })); setError(null); }} />
          <p className="text-sm text-slate-600">{MODE_HELP[fields.mode]}</p>

          {fields.mode === 'direct' && (
            <SegmentedControl name="Bron" options={SOURCE_OPTIONS} value={fields.source} onChange={source => { setFields(current => ({ ...current, source })); setError(null); }} />
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {showText && (
              <>
                <div>
                  <Label htmlFor="tender-branch">Branche</Label>
                  <Input id="tender-branch" placeholder="bijv. Bouw" value={fields.branch} onChange={set('branch')} />
                </div>
                <div>
                  <Label htmlFor="tender-keywords">Zoektermen</Label>
                  <Input id="tender-keywords" placeholder="bijv. renovatie schoolgebouwen" value={fields.keywords} onChange={set('keywords')} />
                </div>
                <div>
                  <Label htmlFor="tender-country">Land</Label>
                  <select id="tender-country" value={fields.country} onChange={set('country')}
                    className="block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400">
                    {COUNTRY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div>
                  <Label htmlFor="tender-region">Regio</Label>
                  <Input id="tender-region" placeholder="bijv. Zuid-Holland" value={fields.region} onChange={set('region')} />
                </div>
              </>
            )}
            {fields.mode === 'direct' && fields.source === 'website' && (
              <div className="sm:col-span-2">
                <Label htmlFor="tender-url">Website-URL</Label>
                <Input id="tender-url" placeholder="https://www.voorbeeld.nl/aanbestedingen" value={fields.url} onChange={set('url')} />
              </div>
            )}
            {showPeriod && (
              <>
                <div>
                  <Label htmlFor="tender-from">Gepubliceerd vanaf</Label>
                  <Input id="tender-from" type="date" value={fields.publishedFrom} onChange={set('publishedFrom')} />
                </div>
                <div>
                  <Label htmlFor="tender-to">Gepubliceerd tot en met</Label>
                  <Input id="tender-to" type="date" value={fields.publishedTo} onChange={set('publishedTo')} />
                </div>
              </>
            )}
            <div>
              <Label htmlFor="tender-cpv">CPV-prefix</Label>
              <Input id="tender-cpv" placeholder="bijv. 45, 72" value={fields.cpvPrefixes} onChange={set('cpvPrefixes')} />
            </div>
            {showNuts && (
              <div>
                <Label htmlFor="tender-nuts">NUTS-prefix</Label>
                <Input id="tender-nuts" placeholder="bijv. NL33" value={fields.nutsPrefixes} onChange={set('nutsPrefixes')} />
              </div>
            )}
            <div>
              <Label htmlFor="tender-target">Gewenst aantal resultaten</Label>
              <Input id="tender-target" type="number" min={1} max={MAX_TARGET} value={fields.target} onChange={set('target')} />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            {showPeriod ? `Alleen publicaties van de gekozen periode (maximaal ${MAX_RANGE_DAYS} dagen); ` : ''}
            CPV{showNuts ? ' en NUTS' : ''} worden na het ophalen gefilterd; een pagina zonder CPV blijft staan.
            Een aanbesteding die al is opgeslagen wordt bijgewerkt in plaats van opnieuw aangemaakt; dezelfde aanbesteding uit verschillende bronnen blijft apart.
          </p>
          <FieldError>{error}</FieldError>
          <div><Button type="submit" disabled={submitting}>{submitting ? 'Bezig…' : startLabel(fields)}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

const STOP_LABELS: Record<string, string> = {
  target_reached: 'Gewenst aantal bereikt',
  no_more_candidates: 'Alles in de bron verwerkt',
  candidate_limit: 'Maximum aantal resultaten per run bereikt',
  time_limit: 'Tijdslimiet bereikt',
  page_limit: 'Maximum aantal pagina’s bereikt',
};
const SOURCE_TITLES: Record<string, string> = { tenderned: 'TenderNed-run', ted: 'TED-run', website: 'Website-run', search: 'Zoek-run', auto: 'Automatische run' };
const REJECTION_LABELS: Record<string, string> = {
  overview_page: 'Overzichtspagina', general_procurement_information: 'Algemene inkoopinformatie', insufficient_evidence: 'Te weinig bewijs',
  no_tender_evidence: 'Geen aanbesteding', cpv_mismatch: 'Andere CPV', robots_blocked: 'Geblokkeerd door robots.txt', fetch_failed: 'Niet op te halen', overview_crawl_failed: 'Site niet te crawlen',
};
const SOURCE_LABELS: Record<string, string> = { tenderned: 'TenderNed', ted: 'TED', search: 'Zoeken op het web', website: 'Website' };
const num = (value: unknown) => (typeof value === 'number' ? value : 0);

export function TenderRunSummary({ run }: { run: DiscoveryRun }) {
  const stats = run.stats ?? {};
  const created = run.recordsCreated ?? num(stats.recordsCreated);
  const sourceId = typeof stats.sourceId === 'string' ? stats.sourceId : 'tenderned';
  const isWeb = sourceId === 'website' || sourceId === 'search';
  const isAuto = sourceId === 'auto';
  const reasons = Object.entries((stats.rejectionReasons ?? {}) as Record<string, number>);
  const rows: Array<[string, string | number]> = [];
  if (!isWeb) rows.push(['Periode', stats.publishedFrom ? `${String(stats.publishedFrom)} t/m ${String(stats.publishedTo)}` : '—']);
  if (sourceId === 'search') rows.push(['Zoekopdrachten', Array.isArray(stats.queries) ? stats.queries.length : 0], ['Kandidaat-pagina’s', num(stats.searchCandidates)], ['Site-crawls', num(stats.overviewCrawls)]);
  if (sourceId === 'website') rows.push(['Website', typeof stats.websiteUrl === 'string' ? stats.websiteUrl : '—']);
  if (isWeb) rows.push(
    ['Pagina’s bekeken', num(stats.pagesVisited)], ['Concrete aanbestedingen', num(stats.concreteTenders)], ['Overzichtspagina’s', num(stats.overviewPages)],
    ['Algemene inkoopinformatie', num(stats.generalInformationPages)], ['Afgewezen pagina’s', num(stats.rejectedPages)],
  );
  const roles = (stats.sourceRoles ?? null) as Record<string, number> | null;
  if (isWeb && roles) rows.push(['Officiële sites', num(roles.official_organization_site)], ['Aggregators', num(roles.aggregator)], ['Onbekende webbronnen', num(roles.unknown_web_source)]);
  else rows.push(['Publicaties opgehaald', num(stats.publicationsFetched)], ['Aanbestedingen', num(stats.tendersFound)]);
  rows.push(['Nieuw', created], ['Bijgewerkt', num(stats.recordsUpdated)], ['Ongewijzigd', num(stats.duplicatesUnchanged)]);
  if (!isWeb) rows.push(['Weggefilterd (CPV/NUTS)', num(stats.filteredOut)]);
  if (isAuto) rows.push(['Weggefilterd (zoektermen)', num(stats.filteredByKeywords)]);
  rows.push(['Resultaat', typeof stats.stopReason === 'string' ? (STOP_LABELS[stats.stopReason] ?? stats.stopReason) : '—']);
  const sources = Array.isArray(stats.sources) ? stats.sources as Array<{ sourceId: string; status: string; error?: string; reason?: string; publications?: number }> : [];
  return (
    <Card aria-label="Run-resultaat">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{SOURCE_TITLES[sourceId] ?? 'Tender-run'}</CardTitle>
          <Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {run.error && <p role="alert" className="mb-3 text-sm text-red-700">{run.error}</p>}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
              <dd className="mt-0.5 break-words text-sm text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>
        {sources.length > 0 && (
          <ul aria-label="Bronnen" className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {sources.map(source => (
              <li key={source.sourceId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span className="font-medium text-slate-800">{SOURCE_LABELS[source.sourceId] ?? source.sourceId}</span>
                <span className="text-slate-600">
                  {source.status === 'ok' ? `${source.publications ?? 0} resultaten` : source.status === 'skipped' ? `Overgeslagen: ${source.reason ?? ''}` : `Mislukt: ${source.error ?? ''}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {isWeb && reasons.length > 0 && (
          <p className="mt-4 text-xs text-slate-500">
            Afgewezen: {reasons.map(([reason, count]) => `${REJECTION_LABELS[reason] ?? reason} (${count})`).join(' · ')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
