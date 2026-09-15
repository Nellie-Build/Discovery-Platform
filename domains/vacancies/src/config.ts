import type { PriorityTier } from '@discovery-platform/core';

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
  linkPriorityExtraTiers: [VACANCY_LINK_TIER] as PriorityTier[],
};
