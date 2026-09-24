import type { SourceRole } from './tender-facts.js';

/**
 * What kind of web source a page is on, from general signals only (never a hostname list):
 *  - `official_organization_site`: the site of the organisation that buys (the publisher is the contracting authority, the
 *    domain is named after the publisher, the text speaks of "our" procurements);
 *  - `aggregator`: a site that collects tenders of others (it presents itself as a tender/procurement platform, or the
 *    contracting authority is another organisation than the publisher, or one host shows many different buyers);
 *  - `unknown_web_source`: not enough evidence. No aggressive guessing: this is the default.
 * Publisher (who runs the site) and contracting authority (who buys) are separate concepts and stay separate.
 */
export interface RoleInput {
  host: string;
  /** The organisation behind the page, from structured data or site metadata. */
  publisher: string | null;
  /** The name of the site itself (site metadata), which can differ from the publisher a page's structured data names. */
  siteName?: string | null;
  /** The contracting authority as the page states it. */
  authority: string | null;
  /** Text of the page chrome (header, footer, meta description): how the site describes itself. */
  selfDescription: string;
  /** The page text speaks of the organisation's own procurements ("onze aanbestedingen", "we invite suppliers"). */
  firstPersonProcurement: boolean;
}

export interface RoleAssessment { role: SourceRole; confidence: 'high' | 'medium' | 'low'; evidence: string[] }

const STOP_WORDS = new Set(['de', 'het', 'een', 'van', 'der', 'den', 'en', 'the', 'of', 'and', 'bv', 'nv', 'b', 'v', 'n', 'gemeente', 'provincie', 'waterschap', 'stichting', 'ministerie', 'vereniging', 'www']);
const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const nameTokens = (value: string | null | undefined): string[] => norm(value ?? '').split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !STOP_WORDS.has(word));

/** Two organisation names denote the same organisation when most of the significant words of the shorter one are in the other. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = nameTokens(a), right = nameTokens(b);
  if (left.length === 0 || right.length === 0) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.filter(word => long.includes(word)).length / short.length >= 0.6;
}

/** The site's domain label is built from the publisher's name ("hunzeenaas" for "Waterschap Hunze en Aa's"). */
export function hostMatchesPublisher(host: string, publisher: string | null): boolean {
  const tokens = nameTokens(publisher);
  if (tokens.length === 0) return false;
  const labels = host.toLowerCase().replace(/^www\./, '').split('.');
  const label = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  const compact = norm(label).replace(/[^a-z0-9]/g, '');
  return compact.length >= 4 && tokens.every(word => compact.includes(word));
}

/** A site or a page chrome that presents itself as a tender/procurement platform. */
export const PLATFORM_SELF_DESCRIPTION = /(?:aanbestedingsplatform|tenderplatform|tender\s+platform|procurement\s+(?:platform|portal)|tender\s*(?:monitor\w*|kalender|alert\w*|database|portaal)|tendermonitor\w*|aanbestedingsalert\w*|overheidsopdrachten|alle\s+(?:actuele\s+)?(?:aanbestedingen|tenders)|vind\s+(?:en\s+volg\s+)?(?:aanbestedingen|tenders)|marktplaats|find\s+(?:public\s+)?tenders)/i;
const PROCUREMENT_SITE_NAME = /(?:tender|aanbested|procurement|opdrachten)/i;

export function classifySourceRole(input: RoleInput): RoleAssessment {
  const official: string[] = [];
  const aggregator: string[] = [];
  let officialPoints = 0, aggregatorPoints = 0;
  const own = (points: number, reason: string) => { officialPoints += points; official.push(reason); };
  const other = (points: number, reason: string) => { aggregatorPoints += points; aggregator.push(reason); };

  const authorityIsPublisher = namesMatch(input.authority, input.publisher);
  if (input.authority && input.publisher) {
    if (authorityIsPublisher) own(3, 'authority_matches_publisher');
    else other(2, 'authority_differs_from_publisher');
  }
  if (PLATFORM_SELF_DESCRIPTION.test(input.selfDescription)) other(2, 'presents_itself_as_tender_platform');
  if ([input.publisher, input.siteName].some(name => name && PROCUREMENT_SITE_NAME.test(name))) other(2, 'publisher_named_as_tender_service');
  // Weak, self-referential signals (every site is named after itself and can say "we"): they only count when nothing points at an aggregator.
  if (aggregatorPoints === 0) {
    if (hostMatchesPublisher(input.host, input.publisher) || hostMatchesPublisher(input.host, input.siteName ?? null)) own(1, 'domain_named_after_publisher');
    if (input.firstPersonProcurement) own(1, 'first_person_procurement_text');
  }

  if (aggregatorPoints >= 2 && aggregatorPoints > officialPoints) return { role: 'aggregator', confidence: aggregatorPoints >= 4 ? 'high' : 'medium', evidence: aggregator };
  if (officialPoints >= 3 && aggregatorPoints === 0) return { role: 'official_organization_site', confidence: 'high', evidence: official };
  if (officialPoints >= 2 && aggregatorPoints === 0) return { role: 'official_organization_site', confidence: 'medium', evidence: official };
  return { role: 'unknown_web_source', confidence: 'low', evidence: [...official, ...aggregator] };
}

/**
 * One host's role from everything a run saw of it: any page that shows the host as an aggregator makes it one; else any
 * official page; else unknown. A host whose accepted tenders name three or more different contracting authorities is an
 * aggregator whatever its pages say: an organisation's own site does not buy for others.
 */
export function hostRole(pageRoles: RoleAssessment[], authorities: string[]): RoleAssessment {
  const distinct = new Set(authorities.map(name => nameTokens(name).join(' ')).filter(Boolean));
  if (distinct.size >= 3) return { role: 'aggregator', confidence: 'high', evidence: [`host_shows_${distinct.size}_different_contracting_authorities`] };
  const strongest = (role: SourceRole) => pageRoles.filter(page => page.role === role).sort((x, y) => (x.confidence === 'high' ? 0 : x.confidence === 'medium' ? 1 : 2) - (y.confidence === 'high' ? 0 : y.confidence === 'medium' ? 1 : 2))[0];
  return strongest('aggregator') ?? strongest('official_organization_site') ?? { role: 'unknown_web_source', confidence: 'low', evidence: [] };
}
