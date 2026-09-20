/**
 * The stable identity of a vacancy as its own URL states it: an explicit job identifier
 * ("jobId=123", "vacancy_id=…", a "jobID:123" path segment). One implementation for everything that
 * needs it: candidate ranking (`job_identifier`), candidate-level dedupe (`dedupeKey`) and record-level
 * dedupe (`stableJobIdentity`), so they can never disagree about what an identifier is.
 *
 * It is deliberately narrow. Only an explicit id key with an identifier value that contains a digit
 * counts; never a slug, a title, a language segment, a page number, a tracking parameter or "some number
 * in the URL". The identity is scoped to the origin, so id 123 on one site is never id 123 on another.
 * The URL itself is never rewritten: it stays the real, fetchable address.
 */
export interface VacancyUrlIdentity {
  /** Scheme and host (without a leading "www."), so the same id on another site never matches. */
  origin: string;
  /** The identifier key, normalised: "jobid", "vacancyid", "positionid", ... */
  type: string;
  value: string;
  /** `origin|type|value` — equal keys mean the same vacancy. */
  key: string;
}

const KEY_WORDS = '(?:job|vacancy|vacature|position|posting|opening|requisition)';
const JOB_ID_KEY = new RegExp(`^${KEY_WORDS}[-_]?id$`, 'i');
const JOB_ID_SEGMENT = new RegExp(`^(${KEY_WORDS}[-_]?id)[:=](.+)$`, 'i');

/** A short alphanumeric token with at least one digit ("12345", "a7f3"). */
const isIdentifier = (value: string) => /^[\p{L}\p{N}._-]{2,}$/u.test(value) && /\d/.test(value);

function decode(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/** The explicit job identity in a URL, or null when it has none. The first match wins: query
 * parameters (in order), then path segments (in order). */
export function extractVacancyUrlIdentity(input: string | URL): VacancyUrlIdentity | null {
  let url: URL;
  try { url = typeof input === 'string' ? new URL(input) : input; } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const origin = `${url.protocol}//${url.host.replace(/^www\./i, '').toLowerCase()}`;
  const make = (rawType: string, value: string): VacancyUrlIdentity => {
    const type = rawType.toLowerCase().replace(/[-_]/g, '');
    return { origin, type, value, key: `${origin}|${type}|${value}` };
  };
  for (const [key, value] of url.searchParams) if (JOB_ID_KEY.test(key) && isIdentifier(value)) return make(key, value);
  for (const segment of url.pathname.split('/')) {
    const match = JOB_ID_SEGMENT.exec(decode(segment));
    if (match && !match[2].includes('-') && isIdentifier(match[2])) return make(match[1], match[2]);
  }
  return null;
}
