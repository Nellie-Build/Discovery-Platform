import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../hooks/use-async';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, statusBadgeTone } from '../components/ui/badge';
import { LoadingState, ErrorState } from '../components/ui/states';
import { getDomainRenderer, EmptyValue } from '../domains/registry';

function ContactIcon({ type }: { type: string }) {
  return <Badge tone="neutral" className="capitalize">{type.replace('_', ' ')}</Badge>;
}

export function RecordDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [debugOpen, setDebugOpen] = useState(false);
  const { data: record, loading, error, refetch } = useAsync(() => api.records.get(id!), [id]);

  if (loading) return <LoadingState label="Loading record…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!record) return null;

  const renderer = getDomainRenderer(record.domain);
  const detailFields = renderer.renderDetailFields(record);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/records" className="text-sm font-medium text-slate-500 hover:text-slate-700">← All records</Link>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{record.display_name ?? 'Untitled record'}</h1>
            <p className="mt-1 text-sm text-slate-500">{renderer.recordLabelPlural.replace(/s$/, '')} · found {new Date(record.created_at).toLocaleDateString()}</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={statusBadgeTone(record.status)}>{record.status}</Badge>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-slate-400">Score</p>
              <p className="text-2xl font-semibold text-slate-900">{record.score ?? '—'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* Found information */}
          <Card>
            <CardHeader><CardTitle>Found information</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {detailFields.map(field => (
                  <div key={field.label}>
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{field.label}</dt>
                    <dd className="mt-0.5 text-sm text-slate-800">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          {/* Sources / provenance — a strong point of Discovery Platform: show where data came
              from, never hidden in raw JSON as the primary way to see it. */}
          <Card>
            <CardHeader><CardTitle>Sources</CardTitle></CardHeader>
            <CardContent className="p-0">
              {record.sources.length === 0 ? (
                <p className="px-6 py-6 text-sm text-slate-500">No sources recorded.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {record.sources.map(source => (
                    <li key={source.id} className="flex items-center justify-between gap-4 px-6 py-4">
                      <div>
                        <p className="text-sm font-medium text-slate-800">
                          Found on {source.source_label ?? (source.source_type === 'website' ? 'company website' : source.source_type)}
                        </p>
                        {source.source_url && (
                          <a href={source.source_url} target="_blank" rel="noreferrer" className="text-sm text-brand-700 hover:underline">
                            {source.source_url}
                          </a>
                        )}
                        <p className="mt-0.5 text-xs text-slate-400">{new Date(source.discovered_at).toLocaleString()}</p>
                      </div>
                      <Badge tone="neutral" className="capitalize shrink-0">{source.source_type.replace('_', ' ')}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          {/* Contact */}
          <Card>
            <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
            <CardContent>
              {record.contacts.length === 0 ? (
                <p className="text-sm text-slate-500">No contact details found.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {record.contacts.map(contact => (
                    <li key={contact.id} className="flex items-center justify-between gap-3">
                      <ContactIcon type={contact.type} />
                      {contact.type === 'email' ? (
                        <a href={`mailto:${contact.value}`} className="text-sm text-brand-700 hover:underline">{contact.value}</a>
                      ) : contact.type === 'phone' ? (
                        <a href={`tel:${contact.value}`} className="text-sm text-brand-700 hover:underline">{contact.value}</a>
                      ) : (
                        <span className="text-sm text-slate-700">{contact.value}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Discovery information */}
          <Card>
            <CardHeader><CardTitle>Discovery information</CardTitle></CardHeader>
            <CardContent>
              <dl className="flex flex-col gap-3">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Score</dt>
                  <dd className="mt-0.5 text-sm text-slate-800">{record.score ?? EmptyValue}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Signals present</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {Array.isArray(record.classification?.presentSignals) && record.classification.presentSignals.length > 0
                      ? record.classification.presentSignals.map((signal: unknown) => (
                        <Badge key={String(signal)} tone="success">{String(signal)}</Badge>
                      ))
                      : EmptyValue}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Signals missing</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {Array.isArray(record.classification?.missingSignals) && record.classification.missingSignals.length > 0
                      ? record.classification.missingSignals.map((signal: unknown) => (
                        <Badge key={String(signal)} tone="warning">{String(signal)}</Badge>
                      ))
                      : EmptyValue}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {/* Raw data — development/debug only, never the primary way to read this record. */}
          <details open={debugOpen} onToggle={e => setDebugOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer text-sm font-medium text-slate-500 hover:text-slate-700">Raw data (debug)</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100 shadow-md">
              {JSON.stringify(record, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
