import type { PriorityTier, CandidateEvidence, CandidateRank } from '@discovery-platform/core';

/** Routes that are a listing, a search or a general page, never one individual posting. */
const GENERIC_SEGMENT = /^(?:home|index|search|zoeken|zoek|jobs?|vacatures?|vacanc(?:y|ies)|careers?|team|teams|contact|about|about-us|over|over-ons|open-sollicitatie|alle-vacatures|all-jobs|all|overzicht|overview|login|inloggen|account|privacy|cookies|nieuws|news|blog|events?|faq|page|categorie|category|categories|locaties|locations?)$/i;
/** A route word that names one posting when an identifier follows it ("/position/12345"). */
const RECORD_ROUTE = /^(?:positions?|posities?|positie|openings?|postings?|opportunit(?:y|ies)|requisitions?)$/i;
const JOB_ID_KEY = /^(?:job|vacancy|vacature|position|posting|opening|requisition)[-_]?id$/i;
const JOB_ID_SEGMENT = /^(?:job|vacancy|vacature|position|posting|opening|requisition)[-_]?id[:=](.+)$/i;
/** An identifier value: short alphanumeric token with at least one digit ("12345", "a7f3-19"). */
const isIdentifier = (value: string) => /^[\p{L}\p{N}._-]{2,}$/u.test(value) && /\d/.test(value);

/** A stable, explicit job identifier: a "jobId=123"-style parameter or a "jobID:123"-style path segment.
 * The key has to be the whole key/segment prefix, so ordinary words that contain "job" never match. */
function hasJobIdentifier(url: URL, path: string): boolean {
  for (const [key, value] of url.searchParams) if (JOB_ID_KEY.test(key) && isIdentifier(value)) return true;
  return path.split('/').some(segment => { const match = JOB_ID_SEGMENT.exec(segment); return match !== null && !match[1].includes('-') && isIdentifier(match[1]); });
}

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
  const segments = path.split('/').filter(Boolean);
  const notASearch = ![...url.searchParams.keys()].some(key => /^(?:q|query|search|filter.*|facet.*)$/i.test(key));
  if (hasJobIdentifier(url, path)) {
    // An explicit job id is strong on its own; on top of a path that already says "detail" it only confirms.
    signal(detail ? 15 : 45, 'job_identifier'); classification = 'detail';
  } else if (!detail && notASearch) {
    const routeAt = segments.findIndex(segment => RECORD_ROUTE.test(segment));
    const recordId = routeAt >= 0 ? segments[routeAt + 1] : undefined;
    const slug = segments.length === 2 && /^\p{L}$/u.test(segments[0]) ? segments[1] : undefined;
    const words = slug ? slug.split('-').filter(Boolean) : [];
    if (recordId !== undefined && /\d{3,}/.test(recordId) && !GENERIC_SEGMENT.test(recordId)) {
      signal(40, 'record_id_route'); classification = 'detail';
    } else if (slug !== undefined && slug.length >= 8 && !GENERIC_SEGMENT.test(slug) && !/^[\d-]+$/.test(slug) && /^[\p{L}\p{N}-]+$/u.test(slug)
      && (words.length >= 3 || (words.length === 2 && (evidence.source === 'sitemap' || evidence.source === 'listing')))) {
      // A one-letter route followed by a descriptive multi-word slug ("/o/senior-software-engineer"): one
      // record. "/o/", "/o/team" or "/o/senior" alone are not; two words need a sitemap or listing behind them.
      signal(35, 'short_detail_route'); classification = 'detail';
    }
  }
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
