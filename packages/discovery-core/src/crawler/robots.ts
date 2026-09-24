import { createRequire } from 'node:module';
import { fetchPublicUrl, type HttpTransport } from './http.js';

interface Robot { isAllowed(url: string, ua?: string): boolean | undefined }
// robots-parser ships an ambient module declaration that breaks NodeNext default-import typing; load the CJS export directly (as website-crawler.ts does).
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, robotstxt: string) => Robot;

export interface RobotsPolicy {
  /** Whether the user agent may fetch `url`. robots.txt is read once per origin (through the same SSRF-safe transport) and remembered. */
  check(url: string): Promise<{ allowed: boolean; reason: string | null }>;
}

export interface RobotsPolicyOptions {
  transport?: HttpTransport;
  userAgent?: string;
}

const DEFAULT_USER_AGENT = 'DiscoveryCoreBot/1.0';
const MAX_REDIRECTS = 3;
const UNREADABLE = 'robots.txt kon niet betrouwbaar worden gelezen; pagina geblokkeerd.';

/**
 * The same robots rules the website crawl applies, for callers that fetch single, already-known URLs (for example search
 * results) instead of crawling. Fail-closed exactly like the crawl: a robots.txt that cannot be read reliably (anything but
 * 200/404/410, a network error, a non-public address) blocks the origin. A missing robots.txt (404/410) allows everything.
 */
export function createRobotsPolicy(options: RobotsPolicyOptions = {}): RobotsPolicy {
  const transport = options.transport ?? fetchPublicUrl;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const byOrigin = new Map<string, Promise<{ parser: Robot; error: string | null }>>();

  async function load(origin: string): Promise<{ parser: Robot; error: string | null }> {
    let url = `${origin}/robots.txt`;
    let body = '';
    let error: string | null = null;
    try {
      let response = await transport(url, userAgent);
      for (let hop = 0; hop < MAX_REDIRECTS && response.status >= 300 && response.status < 400 && response.headers.location; hop++) {
        const next = new URL(response.headers.location, url);
        if (next.origin !== origin) break;
        url = next.href;
        response = await transport(url, userAgent);
      }
      if (![200, 404, 410].includes(response.status)) error = UNREADABLE;
      else if (response.status === 200) body = response.body.toString('utf8');
    } catch {
      error = UNREADABLE;
    }
    return { parser: robotsParser(`${origin}/robots.txt`, error ? 'User-agent: *\nDisallow: /' : body), error };
  }

  return {
    async check(url) {
      let origin: string;
      try { origin = new URL(url).origin; } catch { return { allowed: false, reason: 'Ongeldige URL.' }; }
      if (!byOrigin.has(origin)) byOrigin.set(origin, load(origin));
      const rule = await byOrigin.get(origin)!;
      if (rule.error) return { allowed: false, reason: rule.error };
      return rule.parser.isAllowed(url, userAgent) === false ? { allowed: false, reason: 'Geblokkeerd door robots.txt.' } : { allowed: true, reason: null };
    },
  };
}
