import type { PriorityTier, CandidateEvidence, CandidateRank } from '@discovery-platform/core';

export function rankVacancyCandidate(evidence: CandidateEvidence): CandidateRank {
  const url = new URL(evidence.url);
  let path = url.pathname.toLowerCase();
  try { path = decodeURI(path); } catch { /* Malformed escapes are weak evidence, never a crawl failure. */ }
  const label = evidence.label.trim().toLowerCase();
  const reasons: string[] = [];
  let score = 10;
  let classification: CandidateRank['classification'] = 'general';
  const signal = (points: number, reason: string) => { score += points; reasons.push(reason); };
  const vacancyPath = /(?:^|\/)(?:vacatures?|vacanc(?:y|ies)|jobs?|careers?)(?:\/|$)/.test(path);
  const detail = /\/(?:vacatures?|vacanc(?:y|ies)|jobs?|careers?)\/[^/]+/.test(path)
    && !/\/(?:zoeken|search|categorie|category|categories|overzicht|all|page)(?:\/|$)/.test(path);
  if (vacancyPath) { signal(20, 'vacancy_link_tier'); classification = 'listing'; }
  if (detail) { signal(45, 'detail_path'); classification = 'detail'; }
  if (/\b(?:adviseur|medewerker|manager|engineer|developer|specialist|monteur|coordinator|verpleegkundige|beleidsmedewerker|projectleider|analist|consultant)\b/i.test(label)) {
    signal(25, 'job_title_anchor');
    if (classification === 'general') classification = 'detail';
  }
  if (classification === 'detail' && /[a-z].*[-_].*(?:\d{3,}|[a-z])/.test(path.split('/').filter(Boolean).at(-1) ?? '')) signal(5, 'unique_detail_slug');
  if (classification === 'detail' && evidence.source === 'sitemap') signal(10, 'sitemap_detail');
  if (classification === 'detail' && evidence.source === 'listing') signal(10, 'listing_detail_link');
  if (path === '/') signal(-15, 'homepage');
  if (/(?:^|[\/_-])(?:contact|privacy|voorwaarden|terms|nieuws|news|login|account|cookies|inloggen)(?:[\/_-]|$)/.test(path)) {
    signal(-90, 'non_vacancy_navigation'); classification = 'general';
  }
  if (/\/(?:categorie|category|categories|vakgebieden|organisaties)(?:\/|$)/.test(path)) signal(-25, 'category_overview');
  if ([...url.searchParams.keys()].some(key => /^(?:q|query|search|filter.*|facet.*)$/i.test(key))) signal(-30, 'search_or_filter');
  if ([...url.searchParams.keys()].some(key => /^(?:page|pagina|offset|start)$/i.test(key)) || /\/(?:page|pagina)\/\d+/.test(path)) {
    signal(-20, 'pagination'); classification = 'pagination';
  }
  return { score, reasons, classification };
}

/**
 * Pages most likely to be an actual job listing or listing overview — prioritized ahead of
 * generic marketing pages within the crawl budget. This is vacancies' own business knowledge —
 * an accommodation domain module would define its own equivalent tier for room/unit pages the
 * same way. @discovery-platform/core has no notion of what a "vacancy" or a "career page" is,
 * and never will (see its own dependency-boundary test).
 */
export const VACANCY_LINK_TIER: PriorityTier = {
  pattern: /vacatures?|vacancy|vacancies|\bjobs?\b|careers?|werken-bij/,
  priority: 1,
};

export const vacanciesCrawlerConfig = {
  rankCandidate: rankVacancyCandidate,
  linkPriorityExtraTiers: [VACANCY_LINK_TIER] as PriorityTier[],
};
