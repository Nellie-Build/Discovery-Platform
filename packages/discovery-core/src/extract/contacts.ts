import type { CheerioAPI } from 'cheerio';
import { linkPriority } from '../crawler/url-policy.js';

export interface ExtractedContacts {
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  instagram: string | null;
  facebook: string | null;
}

export const EMPTY_CONTACTS: ExtractedContacts = { email: null, phone: null, whatsapp: null, instagram: null, facebook: null };

/**
 * Phone/e-mail parsing is deliberately not built into this package: what counts as a valid
 * phone number depends on which country's numbering plan the caller cares about (a domain
 * scoped to one country will parse a bare local number differently than one scoped to
 * elsewhere), and this package must stay ignorant of any specific country or region. Every
 * caller supplies its own normalizers — see examples/basic-discovery for a real one.
 */
export interface ContactNormalizers {
  normalizePhone: (raw: string) => string | null;
  normalizeEmail: (raw: string) => string | null;
}

/** Common template/placeholder addresses that are never a real business's own email. */
const PLACEHOLDER_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'domain.com', 'yourdomain.com', 'email.com', 'test.com', 'sentry.io', 'wixpress.com']);

const EMAIL_TEXT_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const PHONE_TEXT_RE = /(?:\+|00)?(?:\d[\s().-]?){8,14}\d/g;

const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'directory', 'about', 'developer', 'legal', 'privacy']);
const FACEBOOK_RESERVED = new Set(['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'login', 'l.php', 'tr', 'help', 'policy', 'privacy', 'legal', 'ads', 'business', 'watch', 'photo.php']);

function normalizeCandidateEmail(value: string, normalizeEmail: ContactNormalizers['normalizeEmail']): string | null {
  const email = normalizeEmail(value);
  if (!email) return null;
  const domain = email.split('@')[1];
  return PLACEHOLDER_EMAIL_DOMAINS.has(domain) ? null : email;
}

export function extractWhatsApp(href: string, normalizePhone: ContactNormalizers['normalizePhone']): string | null {
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let raw: string | null = null;
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      if (host === 'wa.me') raw = url.pathname.slice(1).split('/')[0];
      if (['api.whatsapp.com', 'web.whatsapp.com', 'whatsapp.com'].includes(host)) raw = url.searchParams.get('phone');
    } else if (url.protocol === 'whatsapp:' && host === 'send') raw = url.searchParams.get('phone');
    if (!raw || !/^\+?\d{6,15}$/.test(raw)) return null;
    return normalizePhone(raw.startsWith('+') ? raw : '+' + raw);
  } catch { return null; }
}
export function extractWhatsAppText(text: string, normalizePhone: ContactNormalizers['normalizePhone']): string | null {
  const values = new Set<string>();
  for (const match of text.matchAll(/\bwhatsapp\s*[:+?-]?\s*((?:\+|00)?(?:\d[ ().-]?){8,14}\d)/gi)) {
    const number = normalizePhone(match[1]); if (number) values.add(number);
  }
  return values.size === 1 ? [...values][0] : null;
}

function extractInstagram(href: string): string | null {
  const match = href.match(/\/\/(?:www\.)?instagram\.com\/([a-z0-9._]{1,30})(?:[/?#]|$)/i);
  if (!match) return null;
  const handle = match[1].toLowerCase();
  return INSTAGRAM_RESERVED.has(handle) ? null : `https://instagram.com/${handle}`;
}

function extractFacebook(href: string): string | null {
  const profile = href.match(/\/\/(?:www\.)?(?:facebook|fb)\.com\/profile\.php\?[^"'\s]*\bid=(\d+)/i);
  if (profile) return `https://facebook.com/profile.php?id=${profile[1]}`;
  const match = href.match(/\/\/(?:www\.)?(?:facebook|fb)\.com\/([a-zA-Z0-9.\-_]{2,80})(?:[/?#]|$)/i);
  if (!match) return null;
  const slug = match[1].toLowerCase();
  return FACEBOOK_RESERVED.has(slug) ? null : `https://facebook.com/${match[1]}`;
}

/** Prefer an email whose domain matches the crawled site itself over an unrelated one. */
function pickOwnEmail(candidates: string[], siteDomain: string): string | null {
  if (!candidates.length) return null;
  const own = candidates.find(email => {
    const domain = email.split('@')[1];
    return domain === siteDomain || domain.endsWith(`.${siteDomain}`);
  });
  return own ?? candidates[0];
}

/**
 * Extracts contact details from one already-parsed HTML page. Prefers explicit
 * mailto:/tel: links and known social-link URL shapes over plain-text scanning,
 * and ignores script/style content to avoid picking up analytics/JSON noise.
 */
export function extractContacts($: CheerioAPI, siteDomain: string, normalizers: ContactNormalizers): ExtractedContacts {
  const { normalizePhone, normalizeEmail } = normalizers;
  const emails: string[] = [];
  const phones: string[] = [];
  let whatsapp: string | null = null;
  let instagram: string | null = null;
  let facebook: string | null = null;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href) return;
    if (/^mailto:/i.test(href)) {
      const email = normalizeCandidateEmail(href, normalizeEmail);
      if (email) emails.push(email);
      return;
    }
    if (/^tel:/i.test(href)) {
      const phone = normalizePhone(href);
      if (phone) { phones.push(phone); if (/whatsapp/i.test($(el).text() + ' ' + ($(el).attr('aria-label') ?? ''))) whatsapp ??= phone; }
      return;
    }
    whatsapp ??= extractWhatsApp(href, normalizePhone);
    instagram ??= extractInstagram(href);
    facebook ??= extractFacebook(href);
  });

  const text = $('body').clone().find('script, style, noscript').remove().end().text();
  for (const match of text.matchAll(EMAIL_TEXT_RE)) {
    const email = normalizeCandidateEmail(match[0], normalizeEmail);
    if (email) emails.push(email);
  }
  for (const match of text.matchAll(PHONE_TEXT_RE)) {
    const phone = normalizePhone(match[0]);
    if (phone) phones.push(phone);
  }

  whatsapp ??= extractWhatsAppText(text, normalizePhone);
  return { email: pickOwnEmail(emails, siteDomain), phone: phones[0] ?? null, whatsapp, instagram, facebook };
}

/**
 * Combines per-page results from one crawl into a single answer per field, preferring
 * the page most likely to be authoritative for contact info (contact > about > reservation
 * > other, per the same priority used to choose which pages to crawl) over crawl order.
 */
export function mergeContacts(pages: { url: string; contacts: ExtractedContacts }[]): ExtractedContacts {
  const result = { ...EMPTY_CONTACTS };
  for (const field of Object.keys(result) as (keyof ExtractedContacts)[]) {
    let bestPriority = Infinity;
    for (const page of pages) {
      const value = page.contacts[field];
      if (!value) continue;
      const priority = linkPriority(page.url);
      if (priority < bestPriority) {
        bestPriority = priority;
        result[field] = value;
      }
    }
  }
  return result;
}
