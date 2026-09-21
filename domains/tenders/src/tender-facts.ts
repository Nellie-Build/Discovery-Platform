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
}
