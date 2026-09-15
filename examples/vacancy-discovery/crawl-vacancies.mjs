// A small, generic wiring example: website URL -> discovery-core's crawler -> domains/vacancies'
// extractor -> VacancyFacts[]. No database, no CMS, no deployment, no API server — this file
// exists purely to show one domain module being wired up entirely through
// @discovery-platform/core's own public API, with no private/deep imports into the core.
import { crawlWebsite } from '@discovery-platform/core';
import { vacanciesCrawlerConfig, extractVacancy } from '@discovery-platform/domain-vacancies';

// Deliberately simple and country-agnostic, exactly like examples/basic-discovery's own —
// domains/vacancies owns no phone-numbering-plan knowledge of its own.
const contactNormalizers = {
  normalizePhone(raw) {
    const digits = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    if (/^\+\d{8,15}$/.test(digits)) return digits;
    if (/^\d{8,15}$/.test(digits)) return '+' + digits;
    return null;
  },
  normalizeEmail(raw) {
    const email = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
  },
};

/** Crawls one website and returns every VacancyFacts record discovery-core's crawler and
 * domains/vacancies' own extractor found — a flat array, in the order the pages were visited. */
export async function crawlVacancies(url, options = {}) {
  const result = await crawlWebsite(url, {
    contactNormalizers,
    extract: extractVacancy,
    linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
    ...options,
  });
  return {
    status: result.status,
    pagesVisited: result.pagesVisited,
    // Each extractedPages entry already holds exactly one VacancyFacts record — the crawler
    // itself flattens a multi-fact-per-page extract() result into one entry per fact.
    vacancies: result.extractedPages.map(p => p.data),
  };
}
