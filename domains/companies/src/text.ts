/**
 * Text helpers shared by the vocabulary, the interpretation of a description and the page analysis. Browser-safe
 * (no Node built-ins): the Web App uses the same interpretation as the server.
 */

/** Lower case, no diacritics, one kind of apostrophe and dash, single spaces. */
export function normalizeText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’´`]/g, "'").replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A matcher for one (normalized) term: a whole word or phrase, with a Dutch/English plural or possessive ending. A single
 * long word (8+ letters) may also start a Dutch compound ("camerabeveiliging" in "camerabeveiligingssystemen"). A short
 * word (4 letters or fewer) gets no ending at all: "zorg" never matches the verb "zorgen", "bouw" never "bouwen".
 */
export function termPattern(term: string): RegExp {
  const normalized = normalizeText(term);
  const body = normalized.split(' ').map(escape).join('[\\s-]+');
  const compound = !normalized.includes(' ') && normalized.length >= 8 ? '[\\p{L}]*' : normalized.length <= 4 ? '' : "(?:s|en|es|'s|n)?";
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${compound}(?![\\p{L}\\p{N}])`, 'gu');
}

/** Sentences of a text, each at most `max` characters (a long run-on text is cut, never lost). */
export function sentences(text: string, max = 400): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?;])\s+|\n+|\s[•·|]\s/)) {
    const clean = part.replace(/\s+/g, ' ').trim();
    if (clean.length < 3) continue;
    for (let i = 0; i < clean.length; i += max) out.push(clean.slice(i, i + max));
  }
  return out;
}

/** A short, readable quote around the first match of `pattern` in `text`. */
export function quoteAround(text: string, index: number, length: number, radius = 110): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Unique, trimmed, non-empty strings, first spelling kept (case-insensitive). */
export function uniqueStrings(values: Iterable<string>, max = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.replace(/\s+/g, ' ').trim();
    const key = normalizeText(clean);
    if (!clean || seen.has(key) || out.length >= max) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}
