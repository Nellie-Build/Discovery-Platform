import type { DiscoveryRecord, RecordWithDetails } from '@discovery-platform/client';
import { registerDomainRenderer, EmptyValue, type DomainRenderer } from '../registry';

/** Mirrors domains/vacancies' own VacancyFacts shape (see the Discovery Platform repository's
 * domains/vacancies/src/extract-vacancy.ts) — this file is the *only* place the Web App knows
 * that shape; DiscoveryRecord.domain_data is otherwise opaque `Record<string, unknown>`. */
interface VacancyFacts {
  title?: string | null;
  company?: string | null;
  location?: string | null;
  salary?: string | null;
  hours?: string | null;
  contractType?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  sourceUrl?: string | null;
}

function vacancyData(record: DiscoveryRecord): VacancyFacts {
  return record.domain_data as VacancyFacts;
}

function ContactCell({ facts }: { facts: VacancyFacts }) {
  if (facts.email) return <a href={`mailto:${facts.email}`} className="text-brand-700 hover:underline">{facts.email}</a>;
  if (facts.phone) return <a href={`tel:${facts.phone}`} className="text-brand-700 hover:underline">{facts.phone}</a>;
  return EmptyValue;
}
function SourceCell({ facts }: { facts: VacancyFacts }) {
  if (!facts.sourceUrl) return EmptyValue;
  let host = facts.sourceUrl;
  try { host = new URL(facts.sourceUrl).host; } catch { /* keep raw value */ }
  return (
    <a href={facts.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
      {host}
    </a>
  );
}

const vacanciesRenderer: DomainRenderer = {
  recordLabelPlural: 'Vacancy leads',
  columns: [
    { key: 'title', label: 'Function' },
    { key: 'company', label: 'Company' },
    { key: 'location', label: 'Location' },
    { key: 'score', label: 'Score' },
    { key: 'contact', label: 'Contact' },
    { key: 'source', label: 'Source' },
  ],
  renderCell(record, columnKey) {
    const facts = vacancyData(record);
    switch (columnKey) {
      case 'title': return record.display_name ?? facts.title ?? EmptyValue;
      case 'company': return facts.company ?? EmptyValue;
      case 'location': return facts.location ?? EmptyValue;
      case 'score': return record.score ?? EmptyValue;
      case 'contact': return <ContactCell facts={facts} />;
      case 'source': return <SourceCell facts={facts} />;
      default: return EmptyValue;
    }
  },
  renderDetailFields(record: RecordWithDetails) {
    const facts = vacancyData(record);
    return [
      { label: 'Function', value: facts.title ?? EmptyValue },
      { label: 'Company', value: facts.company ?? EmptyValue },
      { label: 'Location', value: facts.location ?? EmptyValue },
      { label: 'Salary', value: facts.salary ?? EmptyValue },
      { label: 'Hours', value: facts.hours ?? EmptyValue },
      { label: 'Contract', value: facts.contractType ?? EmptyValue },
      { label: 'Contact person', value: facts.contactPerson ?? EmptyValue },
      { label: 'Phone', value: facts.phone ? <a href={`tel:${facts.phone}`} className="text-brand-700 hover:underline">{facts.phone}</a> : EmptyValue },
      { label: 'Email', value: facts.email ? <a href={`mailto:${facts.email}`} className="text-brand-700 hover:underline">{facts.email}</a> : EmptyValue },
    ];
  },
};

registerDomainRenderer('vacancies', vacanciesRenderer);
export { vacanciesRenderer };
