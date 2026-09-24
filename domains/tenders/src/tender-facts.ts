/**
 * The tender record. One record is one *tender* (an aanbesteding), identified by the publisher's own
 * tender identity; the announcements, corrections and awards published about it are its *publications*.
 *
 * MVP rule for several publications of the same tender (see mergeTenderPublications): they are kept
 * together in ONE record. Each field takes the value of the latest publication that has one (a correction
 * usually restates the deadline or the description), `publicationId`/`noticeType` describe that latest
 * publication, and `publications` lists all of them. Corrections and awards are not separate records yet.
 */
export interface CpvCode {
  /** The CPV code without its check digit, e.g. "77000000". */
  code: string;
  description: string | null;
  main: boolean;
}

export interface NutsCode {
  code: string;
  description: string | null;
}

export interface TenderPublication {
  /** The publisher's id of this one publication (announcement, correction, award, ...). */
  publicationId: string;
  /** The publisher's notice type code, e.g. "AAO" (announcement) or "REC" (correction). */
  noticeType: string | null;
  noticeTypeLabel: string | null;
  /** YYYY-MM-DD. */
  publicationDate: string | null;
  submissionDeadline: string | null;
  sourceUrl: string;
}

/**
 * How a tender that was not published by an API source was found: on a website crawled directly, or as a
 * search result. Provenance only, never identity. Absent on TenderNed and TED tenders.
 */
export interface TenderDiscovery {
  via: 'website_crawl' | 'web_search';
  /** The host the tender page is on. */
  host: string;
  /** The search query that surfaced the page (web search only). */
  query: string | null;
  searchProvider: string | null;
  /** The page a crawl followed a link from, when the page was not the requested one. */
  discoveredFrom: string | null;
  /** The generic signals that made the page count as one concrete tender (deadline, reference, cpv, ...). */
  evidence: string[];
  /** How the run that found it was started: a website URL, a search, or the automatic mode. */
  mode?: 'website' | 'search' | 'auto';
  /** What kind of web source the host is (see source-role.ts); never derived from a hostname. */
  sourceRole?: SourceRole;
  roleConfidence?: 'high' | 'medium' | 'low';
  roleEvidence?: string[];
  /** The organisation that runs the site, when the page says so. Never the contracting authority by itself. */
  publisher?: string | null;
  /** Where `contractingAuthority` came from: structured data, an explicit label, or a labeled sentence. */
  authoritySource?: 'structured' | 'label' | 'prose_label' | null;
  /**
   * Only set when this discovery had a target country to check against (a `search`/`auto` run — a `website` run
   * crawls one given site and has none): 'confirmed' when the page's own evidence explicitly names that country,
   * 'unconfirmed' when the page states nothing reliable about where it is. A page that explicitly names a DIFFERENT
   * country is never a record at all (see tender-page.ts's PageCountryEvidence and web-sources.ts) — this field is
   * therefore never 'foreign': a caller never has to guard against a foreign result being labelled anything else.
   */
  locationConfidence?: 'confirmed' | 'unconfirmed';
  /**
   * A human-readable pointer to the specific procurement within the page, when the page inline-lists several (see
   * domains/tenders' splitTenderPageSections) — typically its own heading text. Null for an ordinary one-tender page.
   */
  pageSection?: string | null;
}

export type SourceRole = 'official_organization_site' | 'aggregator' | 'unknown_web_source';

export interface TenderFacts {
  /** Where the tender was found; part of its identity (an id is only unique within one publisher). */
  sourceSystem: string;
  /** The tender identity within `sourceSystem` (TenderNed: "kenmerk"). All publications of one tender share it. */
  tenderIdentity: string;
  /** The latest publication's id. */
  publicationId: string;
  title: string | null;
  contractingAuthority: string | null;
  /** The contracting authority's own reference for the tender, when published. */
  referenceNumber: string | null;
  noticeType: string | null;
  noticeTypeLabel: string | null;
  procedureType: string | null;
  contractType: string | null;
  cpvCodes: CpvCode[];
  nutsCodes: NutsCode[];
  /** A readable place derived from the NUTS descriptions, when there is one. */
  location: string | null;
  /** YYYY-MM-DD. */
  publicationDate: string | null;
  /** As published: a local Dutch date-time without offset (e.g. "2026-11-02T08:00:00"). */
  submissionDeadline: string | null;
  /** Only when the source states one (TenderNed's JSON does not today). */
  estimatedValue: { amount: number; currency: string } | null;
  description: string | null;
  sourceUrl: string;
  publications: TenderPublication[];
  /** Only for tenders found on a website (see TenderDiscovery). */
  discovery?: TenderDiscovery | null;
}
