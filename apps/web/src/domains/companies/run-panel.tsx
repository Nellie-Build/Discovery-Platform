import {
  BUSINESS_TYPES, BUSINESS_TYPE_LABELS, COMPANY_ROLES, CriteriaError, KIND_LABELS, NETHERLANDS, ROLE_LABELS, conceptsOf, criteriaWarnings, interpretDescription, parseCriteria, provinceLabel,
  type BusinessType, type CompanyRole, type Interpretation, type LogicList,
} from '@discovery-platform/domain-companies/criteria';
import { useState, type FormEvent } from 'react';
import { CompanyJobProgress, JobLimitsFields, buildJobLimits, defaultJobLimits, type JobLimitFields } from './job-panel';
import { ApiError, type DiscoveryRun, type SourceRunInput } from '@discovery-platform/client';
import { api } from '../../lib/api';
import { useAsync } from '../../hooks/use-async';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input, Label, FieldError } from '../../components/ui/input';
import { Badge, statusBadgeTone } from '../../components/ui/badge';
import { SegmentedControl, type SegmentedControlOption } from '../../components/ui/segmented-control';

/**
 * The companies module's "start a run" form and run summary. Two ways in:
 *  - Zoeken (route A, sourceId "search"): describe the companies in plain language; the description is turned into
 *    criteria that stay visible and editable before the search starts;
 *  - Website analyseren (route B, sourceId "website"): one company's own website.
 * The interpretation runs in the browser with the same code the server validates with (domains/companies/criteria).
 */
export type CompanyRunMode = 'search' | 'website';
export const MAX_TARGET = 25;

export interface CompanyRunFields {
  mode: CompanyRunMode;
  description: string;
  query: string;
  industries: string;
  products: string;
  services: string;
  specialisations: string;
  customerSectors: string;
  roles: CompanyRole[];
  businessTypes: BusinessType[];
  /** Kinds of company that must not be found (e.g. consumer web shops). */
  excludedBusinessTypes: BusinessType[];
  /** Lists whose values must ALL apply; any other list needs one of its values. */
  allOf: LogicList[];
  provinces: string;
  places: string;
  extra: string;
  exclusions: string;
  url: string;
  target: string;
  /** Extended processing: the search runs in the background in batches, within these limits. */
  extended: boolean;
  jobLimits: JobLimitFields;
}

export const defaultCompanyRunFields = (): CompanyRunFields => ({
  mode: 'search', description: '', query: '', industries: '', products: '', services: '', specialisations: '', customerSectors: '', roles: [], businessTypes: [],
  excludedBusinessTypes: [], allOf: [], provinces: '', places: '', extra: '', exclusions: '', url: '', target: '10', extended: false, jobLimits: defaultJobLimits(),
});
/** The lists with an AND/OR choice in the form (the choice matters once a list has two or more values). */
const LOGIC_FIELDS: Array<[LogicList & keyof CompanyRunFields, string]> = [
  ['industries', 'Branche'], ['products', 'Producten'], ['services', 'Diensten'], ['specialisations', 'Specialisaties'], ['customerSectors', 'Afnemerssector'],
];

const MODE_OPTIONS: SegmentedControlOption<CompanyRunMode>[] = [{ value: 'search', label: 'Zoeken' }, { value: 'website', label: 'Website analyseren' }];
const split = (value: string) => value.split(/[,;\n]/).map(item => item.trim()).filter(Boolean);
const join = (values: string[]) => values.join(', ');

/** The editable fields after interpreting a description (the description itself is kept). */
export function applyInterpretation(fields: CompanyRunFields, interpretation: Interpretation): CompanyRunFields {
  const c = interpretation.criteria;
  return {
    ...fields, industries: join(c.industries), products: join(c.products), services: join(c.services), specialisations: join(c.specialisations),
    customerSectors: join(c.customerSectors), roles: c.roles, businessTypes: c.businessTypes ?? [], excludedBusinessTypes: c.excludedBusinessTypes ?? [],
    allOf: Object.entries(c.logic ?? {}).filter(([, logic]) => logic === 'all').map(([list]) => list as LogicList),
    provinces: join(c.provinces.map(id => provinceLabel(id) ?? id)), places: join(c.places), exclusions: join(c.exclusions),
  };
}

/** The request for the API, or the first thing the user has to fix (the same validation the server applies). */
export function buildCompanyRunRequest(fields: CompanyRunFields): { request: SourceRunInput } | { error: string } {
  const target = Number(fields.target);
  if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET) return { error: `Het gewenste aantal is een getal van 1 tot ${MAX_TARGET}.` };
  const raw = {
    query: fields.query.trim() || undefined, industries: split(fields.industries), products: split(fields.products), services: split(fields.services),
    specialisations: split(fields.specialisations), customerSectors: split(fields.customerSectors), roles: fields.roles, businessTypes: fields.businessTypes, country: 'NL',
    provinces: split(fields.provinces), places: split(fields.places), extra: fields.extra.trim() || undefined, exclusions: split(fields.exclusions),
    description: fields.description.trim() || undefined, excludedBusinessTypes: fields.excludedBusinessTypes,
    // Only lists that really have two or more values carry a choice; OR (one of them) is the default and is not sent.
    logic: Object.fromEntries(fields.allOf.filter(list => list === 'roles' || list === 'businessTypes' ? fields[list].length > 1 : split(String(fields[list as keyof CompanyRunFields] ?? '')).length > 1).map(list => [list, 'all'])),
  };
  try { parseCriteria(raw); } catch (error) { return { error: error instanceof CriteriaError ? error.message : 'Ongeldige zoekcriteria.' }; }
  const filters: Record<string, unknown> = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)
    && !(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)));
  if (fields.mode === 'website') {
    if (!fields.url.trim()) return { error: 'Geef de website van het bedrijf op.' };
    return { request: { sourceId: 'website', filters: { ...filters, url: fields.url.trim() }, runConfig: { targetRecords: 1 } } };
  }
  const subject = ['query', 'industries', 'products', 'services', 'specialisations', 'customerSectors', 'roles'].some(key => key in filters);
  if (!subject && !filters.description) return { error: 'Beschrijf welke bedrijven je zoekt, of vul ten minste een branche, product, dienst, specialisatie, afnemerssector, rol of zoekterm in.' };
  return { request: { sourceId: 'search', filters, runConfig: { targetRecords: target } } };
}

/** Contradictions in the criteria as they are now (the same checks the interpretation applies). */
export function liveWarnings(fields: CompanyRunFields): string[] {
  const built = buildCompanyRunRequest(fields);
  if ('error' in built) return [];
  try { return criteriaWarnings(parseCriteria(built.request.filters ?? {})); } catch { return []; }
}

const RECOGNIZED_KIND: Record<string, string> = { ...KIND_LABELS, business_type: 'Type bedrijf', excluded_business_type: 'Geen type', logic: 'Combinatie', country: 'Land', province: 'Provincie', place: 'Plaats', exclusion: 'Uitsluiting' };
const selectClass = 'block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400';

export function CompanyRunPanel({ projectId, onStarted }: { projectId: string; onStarted: (run: DiscoveryRun) => void }) {
  const [fields, setFields] = useState<CompanyRunFields>(defaultCompanyRunFields);
  const [interpretation, setInterpretation] = useState<Interpretation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobKey, setJobKey] = useState(0);
  const set = (key: keyof CompanyRunFields) => (event: { target: { value: string } }) => setFields(current => ({ ...current, [key]: event.target.value }));
  // The latest search of this project that left candidates for a follow-up batch (and was not continued yet).
  const { data: runs, refetch: refetchRuns } = useAsync(() => Promise.resolve(api.runs.listByProject(projectId)).catch(() => []), [projectId]);
  const runList = Array.isArray(runs) ? runs : [];
  // A batch of extended processing is continued by its job, not by this button.
  const continuable = runList.find(run => {
    if (typeof (run.stats ?? {}).jobId === 'string') return false;
    const state = (run.stats ?? {}).continuation as { remaining?: number } | null | undefined;
    return Boolean(state?.remaining) && !runList.some(other => (other.stats ?? {}).continuesRunId === run.id);
  });
  const remaining = Number(((continuable?.stats ?? {}).continuation as { remaining?: number } | undefined)?.remaining ?? 0);

  async function handleContinue() {
    if (!continuable) return;
    setSubmitting(true);
    setError(null);
    try {
      onStarted(await api.runs.continueRun(projectId, continuable.id));
      await refetchRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kon de volgende batch niet starten.');
    } finally {
      setSubmitting(false);
    }
  }

  const warnings = [...new Set([...(interpretation?.warnings ?? []), ...liveWarnings(fields)])];
  const logicLists = LOGIC_FIELDS.filter(([list]) => split(fields[list] as string).length > 1);

  function interpret() {
    if (!fields.description.trim()) return;
    const result = interpretDescription(fields.description);
    setInterpretation(result);
    setFields(current => applyInterpretation(current, result));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const built = buildCompanyRunRequest(fields);
    if ('error' in built) { setError(built.error); return; }
    const limits = fields.mode === 'search' && fields.extended ? buildJobLimits(fields.jobLimits) : null;
    if (limits && 'error' in limits) { setError(limits.error); return; }
    setSubmitting(true);
    setError(null);
    try {
      if (limits) {
        // Extended processing: the API answers at once; the batches run in the background (progress below).
        await api.jobs.start(projectId, built.request, limits.limits);
        setJobKey(key => key + 1);
      } else {
        onStarted(await api.runs.startSourceRun(projectId, built.request));
      }
      await refetchRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kon de zoekopdracht niet starten.');
    } finally {
      setSubmitting(false);
    }
  }

  const listField = (key: 'query' | 'industries' | 'products' | 'services' | 'specialisations' | 'customerSectors' | 'places' | 'provinces' | 'extra' | 'exclusions', label: string, placeholder: string, suggestions?: string[]) => (
    <div>
      <Label htmlFor={`company-${key}`}>{label}</Label>
      <Input id={`company-${key}`} placeholder={placeholder} value={fields[key]} onChange={set(key)} list={suggestions ? `company-${key}-list` : undefined} />
      {suggestions && <datalist id={`company-${key}-list`}>{suggestions.map(value => <option key={value} value={value} />)}</datalist>}
    </div>
  );

  return (
    <Card>
      <CardHeader><CardTitle>Bedrijven ontdekken</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <SegmentedControl name="Zoekmodus" options={MODE_OPTIONS} value={fields.mode} onChange={mode => { setFields(current => ({ ...current, mode })); setError(null); }} />

          {fields.mode === 'website' && (
            <div>
              <Label htmlFor="company-url">Website van het bedrijf</Label>
              <Input id="company-url" placeholder="https://www.voorbeeld.nl" value={fields.url} onChange={set('url')} />
              <p className="mt-1 text-xs text-slate-500">Discovery leest de toegestane pagina’s van deze website (over ons, producten, diensten, sectoren, projecten, contact) en bouwt een bedrijfsprofiel. Optioneel: vul hieronder criteria in om te zien hoe het bedrijf daarop aansluit.</p>
            </div>
          )}

          <div>
            <Label htmlFor="company-description">Beschrijf welke bedrijven je zoekt</Label>
            <textarea id="company-description" rows={3} value={fields.description} onChange={set('description')} onBlur={interpret}
              placeholder="bijv. Ik zoek bedrijven in Zuid-Holland die camerasystemen installeren en ervaring hebben met ziekenhuizen."
              className="block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400" />
            <div className="mt-2 flex items-center gap-3">
              <Button type="button" variant="secondary" onClick={interpret} disabled={!fields.description.trim()}>Vertaal naar zoekcriteria</Button>
              <span className="text-xs text-slate-500">De vertaling is zichtbaar en aan te passen; niets wordt stilzwijgend toegevoegd.</span>
            </div>
          </div>

          {interpretation && (
            <div aria-label="Herkende zoekcriteria" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="mb-2 font-medium text-slate-700">Herkend in je beschrijving</p>
              {interpretation.recognized.length === 0 ? <p className="text-slate-500">Niets herkend; vul de criteria hieronder zelf in.</p> : (
                <ul className="flex flex-wrap gap-2">
                  {interpretation.recognized.map((item, index) => (
                    <li key={index}><Badge tone={item.kind === 'exclusion' ? 'danger' : item.inferred ? 'neutral' : 'info'}>{RECOGNIZED_KIND[item.kind]}: {item.value}{item.inferred ? ' (afgeleid)' : ''}</Badge></li>
                  ))}
                </ul>
              )}
              {interpretation.unrecognized.length > 0 && <p className="mt-2 text-xs text-slate-600">Niet herkend (niet gebruikt): {interpretation.unrecognized.join(', ')}. Voeg ze zo nodig zelf toe als product, dienst of zoekterm.</p>}
            </div>
          )}
          {warnings.length > 0 && (
            <ul aria-label="Controleer je zoekcriteria" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              {warnings.map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {listField('query', 'Bedrijfsnaam of zoekterm', 'bijv. Voorbeeld Security')}
            {listField('industries', 'Branche', 'bijv. beveiliging, zorg', conceptsOf('industry').map(c => c.label))}
            {listField('products', 'Producten', 'bijv. camerasystemen', conceptsOf('product').map(c => c.label))}
            {listField('services', 'Diensten', 'bijv. installatie, onderhoud', conceptsOf('service').map(c => c.label))}
            {listField('specialisations', 'Specialisaties', 'bijv. branddetectie', conceptsOf('specialisation').map(c => c.label))}
            {listField('customerSectors', 'Afnemerssector (levert aan)', 'bijv. ziekenhuizen, scholen', conceptsOf('customer_sector').map(c => c.label))}
            <div>
              <Label htmlFor="company-country">Land</Label>
              <select id="company-country" value="NL" disabled className={selectClass}><option value="NL">{NETHERLANDS.name}</option></select>
            </div>
            {listField('provinces', 'Provincie', 'bijv. Zuid-Holland', NETHERLANDS.provinces.map(p => provinceLabel(p.id) ?? p.name))}
            {listField('places', 'Plaats', 'bijv. Den Haag')}
            {listField('extra', 'Aanvullende wensen', 'vrije tekst')}
            {listField('exclusions', 'Uitsluitingen', 'bijv. alarmsystemen')}
            {fields.mode === 'search' && (
              <div>
                <Label htmlFor="company-target">Gewenst aantal bedrijven</Label>
                <Input id="company-target" type="number" min={1} max={MAX_TARGET} value={fields.target} onChange={set('target')} />
              </div>
            )}
          </div>

          {logicLists.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-slate-700">Combinatie van waarden</legend>
              <div className="flex flex-wrap gap-4">
                {logicLists.map(([list, label]) => (
                  <label key={list} className="flex flex-col text-xs font-medium text-slate-500">
                    {label}
                    <select aria-label={`Combinatie ${label}`} value={fields.allOf.includes(list) ? 'all' : 'any'} className={selectClass}
                      onChange={e => setFields(current => ({ ...current, allOf: e.target.value === 'all' ? [...current.allOf.filter(l => l !== list), list] : current.allOf.filter(l => l !== list) }))}>
                      <option value="any">Eén van deze volstaat (of)</option>
                      <option value="all">Allemaal vereist (en)</option>
                    </select>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">Bedrijfsrol</legend>
            <div className="flex flex-wrap gap-3">
              {COMPANY_ROLES.map(role => (
                <label key={role} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={fields.roles.includes(role)}
                    onChange={e => setFields(current => ({ ...current, roles: e.target.checked ? [...current.roles, role] : current.roles.filter(r => r !== role) }))} />
                  {ROLE_LABELS[role]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">Type bedrijf</legend>
            <div className="flex flex-wrap gap-3">
              {BUSINESS_TYPES.map(type => (
                <label key={type} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={fields.businessTypes.includes(type)}
                    onChange={e => setFields(current => ({ ...current, businessTypes: e.target.checked ? [...current.businessTypes, type] : current.businessTypes.filter(t => t !== type) }))} />
                  {BUSINESS_TYPE_LABELS[type]}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">Niets aangevinkt: alle typen, ook webwinkels. Aangevinkt: minstens één van deze typen.</p>
          </fieldset>

          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">Niet zoeken naar</legend>
            <div className="flex flex-wrap gap-3">
              {BUSINESS_TYPES.map(type => (
                <label key={type} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" aria-label={`Uitsluiten: ${BUSINESS_TYPE_LABELS[type]}`} checked={fields.excludedBusinessTypes.includes(type)}
                    onChange={e => setFields(current => ({ ...current, excludedBusinessTypes: e.target.checked ? [...current.excludedBusinessTypes, type] : current.excludedBusinessTypes.filter(t => t !== type) }))} />
                  {BUSINESS_TYPE_LABELS[type]}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">Een bedrijf dat duidelijk zo’n type is, wordt niet getoond; bij een enkele aanwijzing staat het erbij met een waarschuwing.</p>
          </fieldset>

          {fields.mode === 'search' && (
            <fieldset className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input type="checkbox" checked={fields.extended} onChange={e => setFields(current => ({ ...current, extended: e.target.checked }))} />
                Uitgebreide verwerking op de achtergrond
              </label>
              {fields.extended && (
                <>
                  <JobLimitsFields fields={fields.jobLimits} onChange={jobLimits => setFields(current => ({ ...current, jobLimits }))} />
                  <p className="text-xs text-slate-500">De zoekopdracht loopt in batches op de achtergrond binnen deze harde limieten. Alleen de eerste batch zoekt op het web; je kunt pauzeren, hervatten en stoppen.</p>
                </>
              )}
            </fieldset>
          )}

          <p className="text-xs text-slate-500">
            Een bedrijf dat actief is <strong>in</strong> een sector (branche) is iets anders dan een bedrijf dat <strong>levert aan</strong> een sector (afnemerssector).
            Vestigingsplaats en werkgebied worden apart beoordeeld; een .nl-adres alleen is geen bewijs.
          </p>
          <FieldError>{error}</FieldError>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={submitting}>{submitting ? 'Bezig…' : fields.mode === 'website' ? 'Analyseer website' : fields.extended ? 'Start uitgebreide verwerking' : 'Zoek bedrijven'}</Button>
            {continuable && (
              <Button type="button" variant="secondary" onClick={handleContinue} disabled={submitting}>
                Volgende batch onderzoeken ({remaining} kandidaten)
              </Button>
            )}
          </div>
          {continuable && <p className="text-xs text-slate-500">De vorige zoekopdracht vond meer kandidaat-bedrijven dan binnen het budget pasten. Een volgende batch onderzoekt de volgende, zonder opnieuw te zoeken.</p>}
        </form>
        <div className="mt-4">
          <CompanyJobProgress projectId={projectId} refreshKey={jobKey} onBatchFinished={run => { onStarted(run); void refetchRuns(); }} />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Run summary ────────────────────────────────────────────────────────────────────────────────────────────────────

const num = (value: unknown) => (typeof value === 'number' ? value : 0);
const EXCLUDED_LABELS: Record<string, string> = {
  directory: 'bedrijvengidsen', review_or_comparison: 'review-/vergelijkingssites', social: 'sociale media', jobs: 'vacaturesites', marketplace: 'webwinkels/marktplaatsen',
  media: 'nieuwssites', government: 'overheidssites', search_or_maps: 'zoekmachines/kaarten', reference: 'naslagwerken',
};

export function CompanyRunSummary({ run }: { run: DiscoveryRun }) {
  const stats = run.stats ?? {};
  const byStatus = (stats.byStatus ?? {}) as Record<string, number>;
  const isSearch = stats.sourceId === 'search';
  const excluded = Object.entries((stats.excludedResults ?? {}) as Record<string, number>);
  const failed = Array.isArray(stats.sitesFailed) ? stats.sitesFailed as Array<{ domain: string; reason: string }> : [];
  const reasons = Array.isArray(stats.incompleteReasons) ? stats.incompleteReasons as string[] : [];
  const rows: Array<[string, string | number]> = [];
  if (typeof stats.criteriaSummary === 'string') rows.push(['Zoekcriteria', stats.criteriaSummary]);
  if (isSearch) rows.push(
    ['Zoekopdrachten', Array.isArray(stats.queries) ? stats.queries.length : 0], ['Zoekresultaten', num(stats.searchResults)],
    ['Kandidaat-bedrijven', num(stats.companyCandidates)], ['Onderzocht', num(stats.companiesResearched)], ['Wacht op vervolgbatch', num(stats.candidatesNotResearched)],
    ...(num(stats.batch) > 1 ? [['Batch', num(stats.batch)] as [string, number]] : []),
  );
  rows.push(
    ['Pagina’s gelezen', num(stats.pagesVisited)], ['Bevestigde match', num(byStatus.confirmed)], ['Mogelijke match', num(byStatus.possible)],
    ...(isSearch ? [['Onvoldoende bewijs (niet opgeslagen)', num(stats.insufficientCount)] as [string, number]] : [['Onvoldoende bewijs', num(byStatus.insufficient)] as [string, number]]),
    ['Nieuw', run.recordsCreated ?? num(stats.recordsCreated)], ['Bijgewerkt', num(stats.recordsUpdated)], ['Ongewijzigd', num(stats.duplicatesUnchanged)],
  );
  return (
    <Card aria-label="Run-resultaat">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{isSearch ? 'Bedrijven zoeken' : 'Website-analyse'}</CardTitle>
          <Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {run.error && <p role="alert" className="mb-3 text-sm text-red-700">{run.error}</p>}
        {stats.yield === 'no_matches' && (
          <p role="status" className="mb-3 text-sm">
            {stats.coverageComplete ? 'De zoekopdracht is uitgevoerd, maar er zijn geen bedrijven gevonden die op deze criteria aansluiten. Maak de criteria ruimer of kies andere termen.' : 'Geen bedrijven gevonden in het deel dat onderzocht kon worden. De zoekopdracht is niet volledig uitgevoerd; zie hieronder.'}
          </p>
        )}
        {stats.yield === 'possible_matches_only' && <p className="mb-3 text-sm">Er zijn alleen mogelijke matches: niet alle criteria konden met de eigen website van het bedrijf worden bevestigd.</p>}
        {reasons.length > 0 && <p className="mb-3 text-sm text-amber-700">Gedeeltelijk uitgevoerd: {reasons.join('; ')}.</p>}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {rows.map(([label, value]) => (
            <div key={label} className={label === 'Zoekcriteria' ? 'col-span-2 sm:col-span-4' : undefined}>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
              <dd className="mt-0.5 break-words text-sm text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>
        {excluded.length > 0 && <p className="mt-4 text-xs text-slate-500">Geen bedrijfswebsite, overgeslagen: {excluded.map(([kind, count]) => `${EXCLUDED_LABELS[kind] ?? kind} (${count})`).join(' · ')}</p>}
        {failed.length > 0 && (
          <ul aria-label="Niet gelezen websites" className="mt-3 text-xs text-slate-600">
            {failed.map(site => <li key={site.domain}>{site.domain}: {site.reason}</li>)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
