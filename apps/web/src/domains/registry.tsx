import type { ComponentType, ReactNode } from 'react';
import type { DiscoveryRecord, DiscoveryRun, RecordWithDetails } from '@discovery-platform/client';

/**
 * The one seam that keeps the generic Record UI (record lists, record detail) from ever
 * hardcoding "every record is a vacancy". A domain renderer turns a record's own opaque
 * `domain_data` into list columns and detail fields; the record shell itself never reads
 * `domain_data` directly. Adding `companies`/`housing`/`candidates` later means writing one new
 * renderer file and adding one line to `domainRenderers` below — no change to any page.
 */
export interface DomainColumn {
  key: string;
  label: string;
}
export interface DomainDetailField {
  label: string;
  value: ReactNode;
}
export interface DomainRenderer {
  /** Shown above the record list — e.g. "Vacancy leads". */
  recordLabelPlural: string;
  columns: DomainColumn[];
  /** Optional domain-specific table presentation; does not change record data. */
  tableClassName?: string;
  renderCell(record: DiscoveryRecord, columnKey: string): ReactNode;
  /** The "Found information" section on the record detail page. */
  renderDetailFields(record: RecordWithDetails): DomainDetailField[];
  /** Optional: the domain's own "start a run" form, shown on the project page instead of the default website/branch form. */
  RunPanel?: ComponentType<{ projectId: string; onStarted: (run: DiscoveryRun) => void }>;
  /** Optional: the domain's own summary of a run, shown instead of the default run status card. */
  RunSummary?: ComponentType<{ run: DiscoveryRun }>;
  /** Optional: extra sections on the record detail page (history, update notice, ...), right below "Found information". */
  renderDetailSections?(record: RecordWithDetails): ReactNode;
  /**
   * Optional: records the domain shows as ONE row (e.g. the same tender published on two sources). A view only: every
   * record stays its own stored record. Groups keep list order; a record in no group is shown on its own.
   */
  groupRecords?(records: DiscoveryRecord[]): DiscoveryRecord[][];
  /** Required with `groupRecords`: a cell of a row that stands for a group of two or more records. */
  renderGroupCell?(records: DiscoveryRecord[], columnKey: string): ReactNode;
  /**
   * Optional: the domain's own filters above its record list. Renders the filter controls and calls `children` with the
   * records that pass them; the generic table renders those. A view only: nothing is filtered on the server.
   */
  RecordsView?: ComponentType<{ records: DiscoveryRecord[]; children: (visible: DiscoveryRecord[]) => ReactNode }>;
}

const missing = <span className="text-slate-400">—</span>;
export { missing as EmptyValue };

const genericRenderer: DomainRenderer = {
  recordLabelPlural: 'Records',
  columns: [{ key: 'display_name', label: 'Name' }, { key: 'score', label: 'Score' }],
  renderCell(record, columnKey) {
    if (columnKey === 'display_name') return record.display_name ?? missing;
    if (columnKey === 'score') return record.score ?? missing;
    return missing;
  },
  renderDetailFields(record) {
    return Object.entries(record.domain_data).map(([key, value]) => ({
      label: key,
      value: value === null || value === undefined || value === '' ? missing : String(value),
    }));
  },
};

export function getDomainRenderer(domain: string): DomainRenderer {
  return domainRenderers[domain] ?? genericRenderer;
}

// Populated by each domain's own renderer module — see domains/vacancies/renderer.tsx. Kept as
// a plain mutable map (not a big switch statement) so a new domain never needs to touch this file.
export const domainRenderers: Record<string, DomainRenderer> = {};
export function registerDomainRenderer(domain: string, renderer: DomainRenderer): void {
  domainRenderers[domain] = renderer;
}
