import type { CandidateEvidence, CandidateRank, PriorityTier } from '@discovery-platform/core';

/**
 * Which links of an organisation's website are worth fetching for tenders, and what each looks like: a concrete tender
 * page (`detail`), an overview of tenders (`listing`), general purchasing information (`general`) or paging
 * (`pagination`). Generic path and link-text rules only; the crawler fetches the best-ranked candidates first.
 */
const TENDER_WORD = /(?:aanbested|tender|inkoop|offerte|opdracht|marktconsult|procurement|rfp|rfq|uitvraag|uitvragen|inschrijv)/;
const LISTING_SEGMENT = /^(?:aanbestedingen|openstaande-aanbestedingen|lopende-aanbestedingen|actuele-aanbestedingen|aanbestedingskalender|tenders?|tender-?overzicht|inkoopkalender|opdrachten|uitvragen|offerteaanvragen|marktconsultaties|procurement|current-tenders|open-tenders|aanbesteden)$/;
const GENERAL_SEGMENT = /^(?:inkoop|inkopen|inkoopbeleid|inkoopvoorwaarden|leveranciers?|zakendoen-met-ons|zaken-doen-met-ons|informatie-voor-leveranciers|voor-leveranciers|zakelijk|business|suppliers?|contact|over-ons|about)$/;
const NAVIGATION = /(?:^|[/_-])(?:contact|privacy|voorwaarden|terms|cookies|inloggen|login|account|sitemap|disclaimer|vacatures?|careers?)(?:[/_-]|$)/;
const SEARCH_PARAM = /^(?:q|query|search|zoek|filter.*|facet.*)$/i;
const PAGE_PARAM = /^(?:page|pagina|offset|start|p)$/i;

/** The link-tier the crawler uses to visit tender-looking pages ahead of generic pages (see `linkPriorityExtraTiers`). */
export const TENDER_LINK_TIER: PriorityTier = { pattern: /aanbested|tender|inkoop|offerte|opdracht|marktconsult|procurement|rfp|rfq|uitvraag|leveranciers/, priority: 1 };

export function rankTenderCandidate(evidence: CandidateEvidence): CandidateRank {
  const url = new URL(evidence.url);
  let path = url.pathname.toLowerCase();
  try { path = decodeURI(path); } catch { /* malformed escapes are weak evidence, never a failure */ }
  const label = evidence.label.trim().toLowerCase();
  const segments = path.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  const reasons: string[] = [];
  let score = 10;
  let classification: CandidateRank['classification'] = 'general';
  const signal = (points: number, reason: string) => { score += points; reasons.push(reason); };

  const listingAt = segments.findIndex(segment => LISTING_SEGMENT.test(segment));
  const afterListing = listingAt >= 0 ? segments.slice(listingAt + 1) : [];
  const isPaging = [...url.searchParams.keys()].some(key => PAGE_PARAM.test(key)) || /\/(?:page|pagina)\/\d+/.test(path);
  const isSearch = [...url.searchParams.keys()].some(key => SEARCH_PARAM.test(key));

  if (listingAt >= 0) { signal(25, 'tender_listing_path'); classification = 'listing'; }
  // A tender-listing segment followed by one more segment that names or numbers one item: a tender page.
  const item = afterListing[0];
  if (item !== undefined && !isPaging && !/^(?:page|pagina|categorie|category|archief|archive|zoeken|search|overzicht|filter)$/.test(item)
    && (/\d{3,}/.test(item) || (item.length >= 8 && /[a-z]/.test(item)))) {
    signal(40, 'tender_item_path'); classification = 'detail';
  } else if (listingAt < 0 && TENDER_WORD.test(last) && last.split('-').filter(Boolean).length >= 3 && !GENERAL_SEGMENT.test(last)) {
    // A descriptive slug that itself names a procurement ("aanbesteding-renovatie-school-x") anywhere on the site.
    signal(35, 'tender_slug'); classification = 'detail';
  }
  if (/\d{3,}/.test(last) && TENDER_WORD.test(path) && classification !== 'detail') { signal(20, 'tender_identifier'); classification = 'detail'; }
  if (TENDER_WORD.test(label) && label.length >= 12) { signal(20, 'tender_link_text'); if (classification === 'general') classification = 'detail'; }
  if (listingAt < 0 && segments.some(segment => GENERAL_SEGMENT.test(segment)) && classification === 'general') {
    // Purchasing information pages are worth a visit only as a way to an overview; they are never a tender themselves.
    signal(15, 'procurement_information_path');
  }
  if (path === '/') signal(-15, 'homepage');
  if (NAVIGATION.test(path)) { signal(-90, 'non_tender_navigation'); classification = 'general'; }
  if (isSearch) signal(-30, 'search_or_filter');
  if (isPaging) { signal(-20, 'pagination'); classification = 'pagination'; }
  return { score, reasons, classification };
}
