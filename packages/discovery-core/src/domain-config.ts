/**
 * The one seam between this package and whatever product uses it. Deliberately minimal for
 * now — only what phase 1 (making the crawler/contact-extraction pieces injectable) actually
 * needs. Do not add scoring/dedupe/classification/vision/output-mapping fields here until a
 * real, working phase actually needs them; a config shape designed for five domains before a
 * second one exists is exactly the kind of premature abstraction this project is trying to
 * avoid (see docs/discovery-platform.md at the repository root).
 *
 * `TFacts` is whatever shape a domain's own text/page extraction produces — this package
 * never looks inside it.
 */
export interface DomainConfig<TFacts = unknown> {
  /** Short, stable identifier — e.g. 'vacancies', 'housing'. Used only for logging/config
   * lookup by a consumer; this package itself never branches on it. */
  id: string;
  /** Optional: pull whatever facts this domain cares about out of a page's own visible text
   * (as opposed to structured data / vision / manual input) — see domains/vacancies's own
   * text-pattern extraction for a real example. Left undefined for a domain that only ever gets
   * facts from structured data or a vision provider. */
  extractText?: (text: string) => Partial<TFacts>;
  /** Optional: turn one raw extracted-facts object into its final, cleaned-up form (phone/e-mail
   * normalization, trimming, coherence checks between related fields, etc). */
  normalize?: (facts: Partial<TFacts>) => Partial<TFacts>;
}

/**
 * Documented, not yet implemented, extension points — deliberately not fields on
 * DomainConfig above. Each becomes real only once a domain module actually needs it, and each
 * would be built directly on top of this package's own scoring/dedupe/vision engines
 * (`../scoring/engine.ts`, `../dedupe/engine.ts`, `../vision/provider.ts`) — never inside them:
 *
 * - dedupeKeys: which signals (and weights) decide "this is probably the same real-world
 *   record" for this domain — see domains/vacancies's own dedupe signals for a real example.
 *   A domain matching *people* (e.g. candidates) would supply only strong, explicit identifiers
 *   here, never a loose name+location match — see docs/discovery-platform.md's note on why.
 * - classifiers: map free text to this domain's own category vocabulary.
 * - scoringRules: point weights + thresholds that turn facts into a record score/status — see
 *   domains/vacancies's own `vacancyCompletenessScore` for a real example.
 * - visionSchema: which fields a Vision provider may recognize from an uploaded image, and the
 *   instructions constraining it to "never invent a value" — see domains/vacancies's own Vision
 *   config for a real example.
 * - outputMapper: how a finished record becomes the shape a particular consumer application
 *   expects.
 * - claims: whether/how this domain wants an optional claim/invitation module (linking a
 *   discovered record to a real account) — not every domain needs self-service
 *   record-to-account linking.
 */
