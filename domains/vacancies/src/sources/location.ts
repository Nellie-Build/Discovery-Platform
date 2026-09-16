/**
 * Turns a free-text "Regio" input (Dutch or English, a country/region/city — the user's Regio
 * field is not split into separate country/region/city inputs) into ts-jobspy's own two distinct
 * search parameters: `location` (free text, understood by every job board) and `country` (an
 * explicit ts-jobspy CountryName value, used by Indeed/Glassdoor for domain selection — LinkedIn
 * ignores it entirely and relies on `location` alone).
 *
 * ts-jobspy has no notion of a Dutch country name at all (its own COUNTRY_CONFIG only recognizes
 * each country's own English name, plus a handful of English abbreviations like "uk"/"usa") — so
 * a bare "Nederland" was previously passed straight through as `location`, and `country` was left
 * unset, which ts-jobspy itself then silently defaults to "usa" (see getCountryFromString in its
 * own source: `options.country ?? "usa"`), searching Indeed's US domain regardless of what the
 * user actually asked for. This is the root cause of the live regression that motivated this file
 * (LinkedIn/Indeed results skewing to random US cities for a "Nederland" search).
 *
 * Only an *explicit* country name is ever mapped to `country` — a region or city (e.g.
 * "Zuid-Holland", "Den Haag", "Rotterdam", "Antwerpen", "Berlin") is never guessed to belong to
 * any particular country; it is passed through verbatim as `location` only, with `country` left
 * null. Extend COUNTRY_ALIASES explicitly to support a new country; this file never infers one.
 */

export interface NormalizedJobBoardLocation {
  /** Free-text location for every job board (ts-jobspy's own `location` option). */
  location: string | null;
  /** An explicit ts-jobspy CountryName value (lowercase), only when the input was itself
   * recognizably a whole country name — never inferred from a region or city. */
  country: string | null;
}

/** ts-jobspy's own canonical country names (its `CountryName` union — see its dist/index.d.ts),
 * each accepted here case-insensitively as-is (a user typing the English name already works).
 * A handful of ts-jobspy's own built-in English abbreviations ("uk", "usa", "uae") are included
 * too, matching what ts-jobspy itself already accepts. */
const CANONICAL_COUNTRY_NAMES: readonly string[] = [
  'argentina', 'australia', 'austria', 'bahrain', 'bangladesh', 'belgium', 'brazil', 'bulgaria',
  'canada', 'chile', 'china', 'colombia', 'costa rica', 'croatia', 'cyprus', 'czech republic',
  'denmark', 'ecuador', 'egypt', 'estonia', 'finland', 'france', 'germany', 'greece', 'hong kong',
  'hungary', 'india', 'indonesia', 'ireland', 'israel', 'italy', 'japan', 'kuwait', 'latvia',
  'lithuania', 'luxembourg', 'malaysia', 'malta', 'mexico', 'netherlands',
  'new zealand', 'nigeria', 'norway', 'oman', 'pakistan', 'panama', 'peru', 'philippines',
  'poland', 'portugal', 'qatar', 'romania', 'saudi arabia', 'singapore', 'slovakia', 'slovenia',
  'south africa', 'south korea', 'spain', 'sweden', 'switzerland', 'taiwan', 'thailand', 'turkey',
  'ukraine', 'united arab emirates', 'united kingdom', 'united states', 'uruguay', 'venezuela',
  'vietnam',
];

/** Explicit Dutch-language aliases for the countries this platform's own audience is most
 * likely to type — never a general-purpose translator, just a curated, explicit lookup. Add a
 * new entry here (never guess one) to support another language/spelling. */
const COUNTRY_ALIASES: Record<string, string> = {
  nederland: 'netherlands', holland: 'netherlands', 'the netherlands': 'netherlands',
  belgië: 'belgium', belgie: 'belgium',
  duitsland: 'germany', deutschland: 'germany',
  frankrijk: 'france', spanje: 'spain', italië: 'italy', italie: 'italy', portugal: 'portugal',
  denemarken: 'denmark', zweden: 'sweden', noorwegen: 'norway', finland: 'finland',
  zwitserland: 'switzerland', oostenrijk: 'austria', polen: 'poland',
  tsjechië: 'czech republic', tsjechie: 'czech republic', griekenland: 'greece',
  turkije: 'turkey', hongarije: 'hungary', roemenië: 'romania', roemenie: 'romania',
  bulgarije: 'bulgaria', kroatië: 'croatia', kroatie: 'croatia', slovenië: 'slovenia',
  slovenie: 'slovenia', slowakije: 'slovakia', luxemburg: 'luxembourg',
  oekraïne: 'ukraine', oekraine: 'ukraine', ierland: 'ireland',
  'verenigd koninkrijk': 'united kingdom', engeland: 'united kingdom',
  'verenigde staten': 'united states', amerika: 'united states',
  // ts-jobspy's own built-in English abbreviations, mapped to their full canonical name so the
  // `location` string stays readable (never a bare "Uk"/"Usa").
  uk: 'united kingdom', usa: 'united states', us: 'united states', uae: 'united arab emirates',
};

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, char => char.toUpperCase());
}

export function normalizeJobBoardLocation(region: string | null | undefined): NormalizedJobBoardLocation {
  if (!region || !region.trim()) return { location: null, country: null };
  const trimmed = region.trim();
  const key = trimmed.toLowerCase();
  const canonical = COUNTRY_ALIASES[key] ?? (CANONICAL_COUNTRY_NAMES.includes(key) ? key : null);
  if (canonical) {
    // A recognized country: its own canonical English name works as `location` for every job
    // board, and the lowercase form is what ts-jobspy's own `country` option expects.
    return { location: toTitleCase(canonical), country: canonical };
  }
  // Not a recognized country name — a region or city. Passed through verbatim as `location`
  // only; never guessed to belong to any particular country.
  return { location: trimmed, country: null };
}
