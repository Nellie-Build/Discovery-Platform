import { useState, type FormEvent } from 'react';
import { ApiError, type DiscoveryRun, type SourceRunInput } from '@discovery-platform/client';
import { api } from '../../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input, Label, FieldError } from '../../components/ui/input';
import { Badge, statusBadgeTone } from '../../components/ui/badge';

/** The tenders module's own "start a run" form and run summary — the only source it offers today is TenderNed. */
export const TENDER_SOURCE_ID = 'tenderned';
export const MAX_RANGE_DAYS = 14;
export const MAX_TARGET = 200;

export interface TenderRunFields {
  publishedFrom: string;
  publishedTo: string;
  cpvPrefixes: string;
  nutsPrefixes: string;
  target: string;
}

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function defaultTenderRunFields(now: Date = new Date()): TenderRunFields {
  const yesterday = new Date(now.getTime() - 86_400_000);
  return { publishedFrom: localDate(yesterday), publishedTo: localDate(now), cpvPrefixes: '', nutsPrefixes: '', target: '20' };
}
const list = (value: string) => value.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);

/** Returns the request for the API, or the first thing the user has to fix. */
export function buildTenderRunRequest(fields: TenderRunFields): { request: SourceRunInput } | { error: string } {
  const filters: Record<string, unknown> = {};
  if (fields.publishedFrom) filters.publishedFrom = fields.publishedFrom;
  if (fields.publishedTo) filters.publishedTo = fields.publishedTo;
  if (fields.publishedFrom && fields.publishedTo) {
    const days = (Date.parse(fields.publishedTo) - Date.parse(fields.publishedFrom)) / 86_400_000 + 1;
    if (Number.isNaN(days) || days < 1) return { error: 'De einddatum ligt voor de begindatum.' };
    if (days > MAX_RANGE_DAYS) return { error: `De periode mag maximaal ${MAX_RANGE_DAYS} dagen beslaan.` };
  }
  const cpv = list(fields.cpvPrefixes);
  if (cpv.some(prefix => !/^\d{2,8}$/.test(prefix))) return { error: 'Een CPV-prefix bestaat uit 2 tot 8 cijfers (bijvoorbeeld 45 of 45000000).' };
  const nuts = list(fields.nutsPrefixes).map(prefix => prefix.toUpperCase());
  if (nuts.some(prefix => !/^[A-Z]{2}[A-Z0-9]{0,3}$/.test(prefix))) return { error: 'Een NUTS-prefix begint met twee letters (bijvoorbeeld NL33).' };
  if (cpv.length > 0) filters.cpvPrefixes = cpv;
  if (nuts.length > 0) filters.nutsPrefixes = nuts;
  const target = Number(fields.target);
  if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET) return { error: `Het gewenste aantal is een getal van 1 tot ${MAX_TARGET}.` };
  return { request: { sourceId: TENDER_SOURCE_ID, filters, runConfig: { targetRecords: target } } };
}

export function TenderRunPanel({ projectId, onStarted }: { projectId: string; onStarted: (run: DiscoveryRun) => void }) {
  const [fields, setFields] = useState<TenderRunFields>(() => defaultTenderRunFields());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (key: keyof TenderRunFields) => (event: { target: { value: string } }) => setFields(current => ({ ...current, [key]: event.target.value }));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const built = buildTenderRunRequest(fields);
    if ('error' in built) { setError(built.error); return; }
    setSubmitting(true);
    setError(null);
    try {
      onStarted(await api.runs.startSourceRun(projectId, built.request));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Kon de TenderNed-run niet starten.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Aanbestedingen ophalen (TenderNed)</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <Label htmlFor="tender-from">Gepubliceerd vanaf</Label>
              <Input id="tender-from" type="date" value={fields.publishedFrom} onChange={set('publishedFrom')} />
            </div>
            <div>
              <Label htmlFor="tender-to">Gepubliceerd tot en met</Label>
              <Input id="tender-to" type="date" value={fields.publishedTo} onChange={set('publishedTo')} />
            </div>
            <div>
              <Label htmlFor="tender-cpv">CPV-prefix</Label>
              <Input id="tender-cpv" placeholder="bijv. 45, 72" value={fields.cpvPrefixes} onChange={set('cpvPrefixes')} />
            </div>
            <div>
              <Label htmlFor="tender-nuts">NUTS-prefix</Label>
              <Input id="tender-nuts" placeholder="bijv. NL33" value={fields.nutsPrefixes} onChange={set('nutsPrefixes')} />
            </div>
            <div>
              <Label htmlFor="tender-target">Gewenst aantal resultaten</Label>
              <Input id="tender-target" type="number" min={1} max={MAX_TARGET} value={fields.target} onChange={set('target')} />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Alleen publicaties van de gekozen periode (maximaal {MAX_RANGE_DAYS} dagen); CPV en NUTS worden na het ophalen gefilterd.
            Een aanbesteding die al is opgeslagen wordt bijgewerkt in plaats van opnieuw aangemaakt.
          </p>
          <FieldError>{error}</FieldError>
          <div><Button type="submit" disabled={submitting}>{submitting ? 'Bezig met ophalen…' : 'Start TenderNed-run'}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

const STOP_LABELS: Record<string, string> = {
  target_reached: 'Gewenst aantal bereikt',
  no_more_candidates: 'Alle publicaties in de periode verwerkt',
  candidate_limit: 'Maximum aantal publicaties per run bereikt',
  time_limit: 'Tijdslimiet bereikt',
};
const num = (value: unknown) => (typeof value === 'number' ? value : 0);

export function TenderRunSummary({ run }: { run: DiscoveryRun }) {
  const stats = run.stats ?? {};
  const created = run.recordsCreated ?? num(stats.recordsCreated);
  const rows: Array<[string, string | number]> = [
    ['Periode', stats.publishedFrom ? `${String(stats.publishedFrom)} t/m ${String(stats.publishedTo)}` : '—'],
    ['Publicaties opgehaald', num(stats.publicationsFetched)],
    ['Aanbestedingen', num(stats.tendersFound)],
    ['Nieuw', created],
    ['Bijgewerkt', num(stats.recordsUpdated)],
    ['Ongewijzigd', num(stats.duplicatesUnchanged)],
    ['Weggefilterd (CPV/NUTS)', num(stats.filteredOut)],
    ['Resultaat', typeof stats.stopReason === 'string' ? (STOP_LABELS[stats.stopReason] ?? stats.stopReason) : '—'],
  ];
  return (
    <Card aria-label="Run-resultaat">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>TenderNed-run</CardTitle>
          <Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {run.error && <p role="alert" className="mb-3 text-sm text-red-700">{run.error}</p>}
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
              <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
