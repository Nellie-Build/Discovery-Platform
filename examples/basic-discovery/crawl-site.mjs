// A totally generic consumer of @discovery-platform/core — this file has no domain-specific
// knowledge at all: no rental unit, property type, lead ranking, invitation flow, database,
// React or Firebase. It only imports the package's public API (see packages/discovery-core/
// src/index.js) and asks for the two things any website-crawling program plausibly wants: each
// page's own title/visible text, and whatever contact details the crawl found across the site.
import { crawlWebsite } from '@discovery-platform/core';

// Deliberately simple — this package never assumes a country/numbering-plan default, so a
// caller must always supply its own normalizers; a real domain module would supply a stricter one.
export const genericContactNormalizers = {
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

/** The one thing this example asks the crawler to recognize per page: its title and a short
 * excerpt of its visible text. No structured-data parsing, no domain-specific fields. */
export function extractTitleAndText(page) {
  const title = page.$('title').first().text().trim() || null;
  const text = page.$('body').clone().find('script, style, noscript').remove().end().text().replace(/\s+/g, ' ').trim();
  return { title, text: text.slice(0, 500) || null };
}

/**
 * Crawls one website and returns a small, generic summary: per-page title/text, and the
 * contact details found anywhere on the site. Exactly what packages/discovery-core/src/
 * crawler/website-crawler.ts already does for any caller — this file adds nothing of its own
 * beyond the two small functions above.
 */
export async function crawlBasic(url, options = {}) {
  const result = await crawlWebsite(url, {
    contactNormalizers: genericContactNormalizers,
    extract: extractTitleAndText,
    ...options,
  });
  return {
    status: result.status,
    pagesVisited: result.pagesVisited,
    contacts: result.contacts,
    pages: result.extractedPages.map(p => ({ url: p.url, ...p.data })),
  };
}
