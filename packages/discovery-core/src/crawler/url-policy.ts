const binary = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|mp[34]|avi|woff2?|ttf|css|js|xml|txt)$/i;

export function websiteScope(website: string) {
  const start = new URL(website.includes('://') ? website.trim() : `https://${website.trim()}`);
  if (!['http:', 'https:'].includes(start.protocol) || start.username || start.password) throw new Error('Ongeldige HTTP(S)-website.');
  const host = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const domain = host(start);
  if (!domain.includes('.') || domain.includes(':')) throw new Error('Een publiek websitedomein is vereist.');
  start.pathname = '/'; start.search = ''; start.hash = '';
  function normalize(input: string, base = start.href, page = true): string | null {
    try {
      const url = new URL(input, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host(url) !== domain ||
          url.port !== start.port || (page && binary.test(url.pathname))) return null;
      url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      return url.href;
    } catch { return null; }
  }
  return { homepage: start.href, domain, normalize };
}

/** One extra priority tier a caller can splice into the ranking below — this is how a domain
 * module (e.g. "which pages describe the accommodation/listing itself") adds its own page
 * categories without this package ever needing to know what an accommodation, a job posting,
 * or a CV page looks like. */
export interface PriorityTier { pattern: RegExp; priority: number }

/**
 * Ranks a URL/link-label by how likely it is to be useful during a crawl — lower is more
 * useful. The tiers below (contact/about/reservation/facilities/pricing/gallery/faq) are
 * universal website-navigation categories, not specific to any one kind of business.
 * `extraTiers` are checked in the position given (spliced in after the first three
 * universal tiers, before "facilities") — a caller can add a domain-specific category (e.g.
 * "room/unit detail pages") at whatever priority it needs without this function ever
 * hardcoding that category itself.
 */
export function linkPriority(url: string, label = '', extraTiers: PriorityTier[] = []): number {
  const text = `${new URL(url).pathname} ${label}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const tiers: PriorityTier[] = [
    { pattern: /contact(?:-us|ez-nous)?/, priority: 0 },
    { pattern: /about|a[-_\s]?propos/, priority: 1 },
    { pattern: /reservation|booking|reserver/, priority: 2 },
    ...extraTiers,
    { pattern: /facilit(?:y|ies)|amenit(?:y|ies)|services?|voorzieningen|equipements?/, priority: 4 },
    { pattern: /tarifs?|prices?|pricing|rates?|prijzen/, priority: 5 },
    { pattern: /gallery|galerie|photos?|foto[s]?/, priority: 6 },
    { pattern: /\bfaq\b|conditions?|house[-_\s]?rules?|huisregels?|reglement/, priority: 7 },
  ];
  for (const tier of tiers) if (tier.pattern.test(text)) return tier.priority;
  return 10;
}
