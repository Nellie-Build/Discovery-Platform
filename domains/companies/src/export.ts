import type { Activity, CompanyFacts, MatchStatus } from './company-facts.js';
import { explainMatches } from './criteria.js';
import { provinceLabel } from './geography.js';
import { BUSINESS_TYPE_LABELS } from './vocabulary.js';

/**
 * CSV export of company profiles, for use in a spreadsheet. What a company publishes about itself as a business, with
 * how well each criterion is substantiated; no personal data: no e-mail addresses or phone numbers (a general number
 * can still be a person's own), no contact persons. Every cell is quoted, and a cell a spreadsheet would read as a
 * formula (= + - @, tab, carriage return) is prefixed with an apostrophe, so an exported company text can never run as
 * a formula (CSV/formula injection). Semicolon-separated with a UTF-8 byte order mark, as Dutch spreadsheet programs
 * expect.
 */
export const MAX_EXPORT_ROWS = 5000;

const STATUS_TEXT: Record<MatchStatus, string> = { confirmed: 'Volledig onderbouwd', possible: 'Gedeeltelijk onderbouwd', insufficient: 'Onvoldoende onderbouwd' };
const BASIS_TEXT = { offering: 'aanbod', reference: 'referentieproject', mention: 'alleen genoemd' } as const;

/** A cell as text a spreadsheet shows literally. */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  // Checked on the text as given: a formula start, also behind leading whitespace or a line break.
  const formula = /^[=+\-@\t\r]/.test(raw) || /^\s+[=+\-@]/.test(raw);
  let text = raw.replace(/\r\n|\r|\n/g, ' ').slice(0, 2000);
  if (formula) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const activities = (list: Activity[], describe: (activity: Activity) => string = a => a.label) =>
  list.filter(a => !a.related).map(a => `${describe(a)}${a.strength === 'strong' ? '' : ' (mogelijk)'}`).join(', ');

const COLUMNS: Array<[string, (facts: CompanyFacts) => unknown]> = [
  ['Naam', f => f.name ?? f.domain],
  ['Website', f => f.website],
  ['Domein', f => f.identity],
  ['Onderbouwing', f => (f.search ? STATUS_TEXT[f.search.status] : '')],
  ['Toelichting', f => (f.search ? explainMatches(f.search.matches) : '')],
  ['Zoekcriteria', f => f.search?.criteria ?? ''],
  ['Bedrijfstypen', f => (f.businessTypes ?? []).map(t => `${BUSINESS_TYPE_LABELS[t.type]}${t.strength === 'strong' ? '' : ' (mogelijk)'}`).join(', ')],
  ['Branches', f => activities(f.industries)],
  ['Producten', f => activities(f.products)],
  ['Diensten', f => activities(f.services)],
  ['Specialisaties', f => activities(f.specialisations)],
  ['Afnemerssectoren', f => activities(f.customerSectors, a => (a.basis ? `${a.label} (${BASIS_TEXT[a.basis]})` : a.label))],
  ['Vestigingen', f => f.locations.filter(l => l.addressType !== 'postal').map(l => [l.city, l.municipality && l.municipality !== l.city ? `gem. ${l.municipality}` : null, l.province ? provinceLabel(l.province) : null].filter(Boolean).join(', ')).join(' | ')],
  ['Werkgebied', f => f.serviceAreas.map(a => (a.scope === 'national' ? 'Heel Nederland' : a.scope === 'province' ? provinceLabel(a.value) ?? a.value : a.value)).join(', ')],
  ['Contactpagina', f => f.contactUrl ?? ''],
  ['KvK-nummer (vermeld op website, niet geverifieerd)', f => f.registration.statedKvkNumber ?? ''],
  ['Laatst gecontroleerd', f => f.lastCheckedAt.slice(0, 10)],
];

/** The CSV text for these companies (at most MAX_EXPORT_ROWS; the caller refuses more). */
export function companiesCsv(companies: CompanyFacts[]): string {
  const lines = [COLUMNS.map(([header]) => csvCell(header)).join(';')];
  for (const facts of companies.slice(0, MAX_EXPORT_ROWS)) lines.push(COLUMNS.map(([, value]) => csvCell(value(facts))).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
