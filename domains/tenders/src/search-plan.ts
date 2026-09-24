import { SourceError } from '@discovery-platform/core';
import { resolveCountry } from './tender-search.js';
import { parseCpvPrefixes, parsePrefixes, resolvePublicationRange } from './publication-range.js';
import { cpvLabel } from './presentation.js';

const OFFICIAL_FIRST = ['ted', 'tenderned', 'search'] as const;
export function planTenderSearch(filters: Record<string, unknown>, searchAvailable: boolean, today = new Date()) {
  const country = resolveCountry(filters.country);
  const period = resolvePublicationRange(filters, today);
  const cpvPrefixes = parseCpvPrefixes(filters.cpvPrefixes);
  const nutsPrefixes = parsePrefixes(filters.nutsPrefixes, 'nutsPrefixes', /^[A-Z]{2}[A-Z0-9]{0,3}$/);
  const keywords = [filters.keywords, filters.branch].find(v => typeof v === 'string' && v.trim()) as string | undefined;
  const webKeywords = keywords ?? cpvPrefixes.map(prefix => cpvLabel(prefix.padEnd(8, '0'))).filter(Boolean).join(' ');
  const wanted = filters.sources ?? OFFICIAL_FIRST;
  if (!Array.isArray(wanted) || wanted.some(id => !OFFICIAL_FIRST.includes(id))) throw new SourceError('Onbekende bron in sources.', 'invalid_filters');
  const steps: Array<{ sourceId: string; filters: Record<string, unknown> }> = [];
  const skipped: Array<{ sourceId: string; reason: string }> = [];
  for (const id of OFFICIAL_FIRST) {
    if (!wanted.includes(id)) continue;
    if (id === 'tenderned' && country.code !== 'NL') { skipped.push({ sourceId: id, reason: 'TenderNed publiceert alleen Nederlandse aanbestedingen.' }); continue; }
    if (id === 'search' && (!webKeywords || !searchAvailable)) { skipped.push({ sourceId: id, reason: !webKeywords ? 'Web-aanvulling vereist zoektermen of een CPV-categorie.' : 'Er is geen zoekprovider geconfigureerd.' }); continue; }
    steps.push({ sourceId: id, filters: id === 'search' ? { ...filters, ...period, keywords: webKeywords } : { ...period, cpvPrefixes, nutsPrefixes, keywords: keywords?.trim() ?? '', ...(id === 'ted' ? { country: country.alpha3 } : {}) } });
  }
  if (!steps.length) throw new SourceError('Geen enkele bron past bij deze zoekopdracht.', 'invalid_filters');
  return { steps, skipped, stats: { ...period, country: country.code, keywords: keywords?.trim() ?? null, branch: filters.branch ?? null, region: filters.region ?? null, cpvPrefixes, nutsPrefixes, strategy: 'api_first' } };
}
