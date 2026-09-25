import { Link } from 'react-router-dom';
import type { DiscoveryRecord } from '@discovery-platform/client';
import { getDomainRenderer, type DomainRenderer } from '../domains/registry';
import { EmptyState } from './ui/states';

/**
 * The generic Record "shell" — it never assumes a record is a vacancy. Every domain-specific
 * column comes from `getDomainRenderer(domain)` (see domains/registry.tsx); this component only
 * lays out whatever columns that renderer returns, plus the columns every record has regardless
 * of domain (created date, link to detail). Records are grouped by their own `domain` field, so
 * a workspace-wide list that one day mixes vacancies with companies/housing never renders one
 * misleading table with the wrong columns for half its rows.
 */
/** One row per record, unless the domain shows some records together (see DomainRenderer.groupRecords). */
function rowsOf(renderer: DomainRenderer, records: DiscoveryRecord[]): DiscoveryRecord[][] {
  return renderer.groupRecords && renderer.renderGroupCell ? renderer.groupRecords(records) : records.map(record => [record]);
}

function OneDomainTable({ domain, records }: { domain: string; records: DiscoveryRecord[] }) {
  const renderer = getDomainRenderer(domain);
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[640px] divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {renderer.columns.map(column => (
              <th key={column.key} scope="col" className="px-4 py-3 text-left font-medium text-slate-500">{column.label}</th>
            ))}
            <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">Found</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rowsOf(renderer, records).map(group => {
            const [record] = group;
            const cell = (key: string) => (group.length > 1 && renderer.renderGroupCell ? renderer.renderGroupCell(group, key) : renderer.renderCell(record, key));
            return (
              <tr key={group.map(member => member.id).join('+')} className="hover:bg-slate-50">
                {renderer.columns.map((column, index) => (
                  <td key={column.key} className="px-4 py-3 text-slate-700">
                    {index === 0 ? (
                      <Link to={`/records/${record.id}`} className="font-medium text-brand-700 hover:underline">
                        {cell(column.key)}
                      </Link>
                    ) : (
                      cell(column.key)
                    )}
                  </td>
                ))}
                <td className="px-4 py-3 whitespace-nowrap text-slate-400">{new Date(record.created_at).toLocaleDateString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RecordsTable({ records, emptyTitle, emptyDescription }: {
  records: DiscoveryRecord[];
  emptyTitle: string;
  emptyDescription?: string;
}) {
  if (records.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const byDomain = new Map<string, DiscoveryRecord[]>();
  for (const record of records) {
    const group = byDomain.get(record.domain);
    if (group) group.push(record); else byDomain.set(record.domain, [record]);
  }

  if (byDomain.size === 1) {
    const [[domain, group]] = byDomain;
    return <OneDomainTable domain={domain} records={group} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {[...byDomain.entries()].map(([domain, group]) => (
        <div key={domain}>
          <h3 className="mb-2 text-sm font-semibold text-slate-600">{getDomainRenderer(domain).recordLabelPlural}</h3>
          <OneDomainTable domain={domain} records={group} />
        </div>
      ))}
    </div>
  );
}
