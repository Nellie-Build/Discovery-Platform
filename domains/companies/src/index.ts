/**
 * @discovery-platform/domain-companies — branch-, product- and service-oriented B2B company discovery. See
 * docs/companies-domain.md. Consumes @discovery-platform/core only.
 */
export * from './company-facts.js';
export {
  EMPTY_CRITERIA, LIST_OF, LIST_OF_KIND, LOGIC_LISTS, MATCH_STATUS_LABELS, CriteriaError, parseCriteria, hasSubject, summarizeCriteria, interpretDescription,
  criteriaWarnings, explainMatches, logicOf, type Logic, type LogicList, type CompanySearchCriteria, type Interpretation, type RecognizedPhrase,
} from './criteria.js';
export { CONCEPTS, COMPANY_ROLES, ROLE_LABELS, KIND_LABELS, CONCEPT_KINDS, BUSINESS_TYPES, BUSINESS_TYPE_LABELS, type BusinessType, conceptsOf, expandValue, findConcept, type Concept, type ConceptKind, type CompanyRole } from './vocabulary.js';
export { NETHERLANDS, COUNTRIES, findPlace, findProvince, provinceLabel, provinceById, NL_POSTCODE, type Province, type Place, type CountryGeography } from './geography.js';
export { analyzeCompanyPage, termSpecs, pageTypeOf, rankCompanyCandidate, COMPANY_LINK_TIER, CONTACT_NORMALIZERS, type PageAnalysis, type TermHit, type TermSpec, type OrganizationData, type CommerceSignals } from './page-analysis.js';
export { buildCompanyProfile, businessTypesOf, evaluateCompany, withSearch, looksLikeCompanySite, isPublicAuthority, type Evaluation, type ProfileContext } from './profile.js';
export { registrableDomain, companyIdentity, companyIdentityKey, storedCompanyIdentityKey, storedCompanyFacts, updateStoredCompany, companyProfileSignals, type CompanyUpdate } from './identity.js';
export { companiesCsv, csvCell, MAX_EXPORT_ROWS } from './export.js';
export { DEFAULT_SEARCH_QUERIES, MAX_SEARCH_QUERIES, buildCompanySearchQueries, excludedHostKind, type PlannedQuery, type ExcludedHostKind } from './search-plan.js';
export {
  createCompanySearchSource, createCompanyWebsiteSource, criteriaFrom, parseWebsiteUrl, continuationCursor, parseContinuationCursor, MAX_CONTINUATION_CANDIDATES, COMPANY_SEARCH_SOURCE_ID, COMPANY_WEBSITE_SOURCE_ID,
  type CompanyWebDeps, type CompanyRaw, type CompanySource, type CompanySourceStats,
} from './sources.js';
