// Generic in-memory websites for the tender web sources: no network, no copy of any real site. Hosts are the reserved ".example" TLD.

export const page = (title, body, head = '') => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta property="og:site_name" content="Gemeente Voorbeeld"><title>${title} | Gemeente Voorbeeld</title>${head}</head><body><header><nav><a href="/">Home</a> <a href="/aanbestedingen">Aanbestedingen</a> <a href="/contact">Contact</a></nav></header><main>${body}</main><footer>Gemeente Voorbeeld</footer></body></html>`;

export const DETAIL_BOUW = page('Aanbesteding renovatie basisschool De Ster', `
  <h1>Aanbesteding renovatie basisschool De Ster</h1>
  <p>De gemeente schrijft de renovatie van basisschool De Ster in Delft aan als openbare aanbesteding uit. Het gaat om vervanging van kozijnen, vloeren en installaties.</p>
  <dl><dt>Opdrachtgever</dt><dd>Gemeente Voorbeeld</dd><dt>Kenmerk</dt><dd>GV-2026-041</dd><dt>Procedure</dt><dd>Openbare procedure</dd>
  <dt>CPV-code</dt><dd>45214200-2</dd><dt>Sluitingsdatum</dt><dd>12 november 2026 om 12:00 uur</dd><dt>Gepubliceerd op</dt><dd>1 oktober 2026</dd><dt>Plaats</dt><dd>Delft</dd></dl>
  <p><a href="/documenten/gv-2026-041-nota-van-inlichtingen.pdf">Aanbestedingsdocumenten (pdf)</a></p>`);

export const DETAIL_RFP = page('Request for Proposal: security services', `
  <h1>Request for Proposal: security services</h1>
  <p>The municipality invites suppliers to submit a proposal for security services for its office buildings. Read the tender documents before you respond.</p>
  <table><tr><th>Contracting authority</th><td>Gemeente Voorbeeld</td></tr><tr><th>Reference</th><td>RFP-2026-07</td></tr><tr><th>Closing date</th><td>3 November 2026 at 14:00</td></tr></table>
  <p>CPV: 79710000</p><a href="/files/rfp-2026-07.pdf">Download the RFP</a>`);

export const DETAIL_OFFERTE = page('Offerteaanvraag schilderwerk sporthal', `
  <h1>Offerteaanvraag schilderwerk sporthal</h1>
  <p>Wij vragen u een offerte uit te brengen voor het schilderwerk van de sporthal aan de Sportlaan. Uiterlijk indienen: 20-11-2026 vóór 10.00 uur.</p>
  <p><a href="/bestanden/programma-van-eisen.pdf">Programma van eisen</a></p>`);

export const OVERVIEW = page('Aanbestedingen', `
  <h1>Aanbestedingen</h1><p>Overzicht van onze lopende aanbestedingen.</p>
  <ul>
    <li><a href="/aanbestedingen/renovatie-basisschool-de-ster">Aanbesteding renovatie basisschool De Ster</a> sluitingsdatum 12 november 2026</li>
    <li><a href="/aanbestedingen/security-services">Request for Proposal: security services</a> sluitingsdatum 3 november 2026</li>
    <li><a href="/aanbestedingen/schilderwerk-sporthal">Offerteaanvraag schilderwerk sporthal</a> sluitingsdatum 20 november 2026</li>
    <li><a href="/aanbestedingen/onderhoud-groen">Aanbesteding onderhoud openbaar groen</a> sluitingsdatum 30 november 2026</li>
    <li><a href="/aanbestedingen/page/2">Volgende pagina</a></li>
  </ul>`);

export const GENERAL = page('Informatie voor leveranciers', `
  <h1>Informatie voor leveranciers</h1>
  <p>Zo koopt onze organisatie in. Wij werken met een inkoopbeleid en algemene inkoopvoorwaarden. Registreren als leverancier kan via ons portaal. Actuele aanbestedingen vindt u op de <a href="/aanbestedingen">aanbestedingenpagina</a>.</p>`);

export const GENERAL_WITH_DOCS = page('Inkoopbeleid', `
  <h1>Inkoopbeleid</h1>
  <p>Ons inkoopbeleid beschrijft hoe wij aanbestedingen doen. Bekijk de <a href="/files/inkoopbeleid-2026.pdf">inkoopbeleid (pdf)</a> en de <a href="/files/voorwaarden.pdf">voorwaarden (pdf)</a>. Vragen over inkoop? Neem contact op.</p>`);

export const EVENT_NOT_TENDER = page('Workshop duurzaam bouwen', `
  <h1>Workshop duurzaam bouwen</h1>
  <p>Inschrijven voor de workshop kan tot 10 november 2026. Download het programma (pdf) voor alle details.</p><a href="/files/programma.pdf">Programma</a>`);

export const NEWS = page('Nieuws', '<h1>Nieuws</h1><p>De gemeente heeft een nieuwe website.</p>');

export const SITE = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
  '/': { body: page('Home', '<h1>Welkom bij Gemeente Voorbeeld</h1><p><a href="/aanbestedingen">Aanbestedingen</a> <a href="/inkoop/leveranciers">Informatie voor leveranciers</a> <a href="/nieuws">Nieuws</a></p>') },
  '/aanbestedingen': { body: OVERVIEW },
  '/aanbestedingen/renovatie-basisschool-de-ster': { body: DETAIL_BOUW },
  '/aanbestedingen/security-services': { body: DETAIL_RFP },
  '/aanbestedingen/schilderwerk-sporthal': { body: DETAIL_OFFERTE },
  '/aanbestedingen/onderhoud-groen': { body: page('Aanbesteding onderhoud openbaar groen', '<h1>Aanbesteding onderhoud openbaar groen</h1><p>Aanbesteding voor het onderhoud van openbaar groen in de gemeente.</p><dl><dt>Kenmerk</dt><dd>GV-2026-052</dd><dt>Sluitingsdatum</dt><dd>30 november 2026</dd></dl>') },
  '/inkoop/leveranciers': { body: GENERAL },
  '/inkoop/inkoopbeleid': { body: GENERAL_WITH_DOCS },
  '/nieuws': { body: NEWS },
  '/nieuws/workshop': { body: EVENT_NOT_TENDER },
};

/** A transport over `{ host: { path: { body, status?, contentType? } } }`; counts every request per URL. */
export function webTransport(sites) {
  const calls = [];
  const transport = async url => {
    const parsed = new URL(url);
    calls.push(parsed.href);
    const site = sites[parsed.hostname] ?? sites[parsed.hostname.replace(/^www\./, '')];
    const entry = site?.[parsed.pathname];
    if (!entry) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: entry.status ?? 200, headers: { 'content-type': entry.contentType ?? 'text/html; charset=utf-8' }, body: Buffer.from(entry.body ?? '') };
  };
  return { transport, calls };
}

export function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, sleep: async ms => { now += ms; } };
}

/** A search provider that answers from a fixed map query-substring -> results, recording every query it received. */
export function fakeSearchProvider(answers) {
  const queries = [];
  return {
    queries,
    async search(input) {
      queries.push(input);
      const hit = answers.find(([needle]) => input.query.toLowerCase().includes(needle));
      return (hit ? hit[1] : []).map(([url, title, snippet]) => ({ url, title: title ?? null, snippet: snippet ?? null, source: 'fake' }));
    },
  };
}

/** A site that collects the tenders of many buyers: it presents itself as a tender platform and every page names another buyer. Reserved ".example" host. */
export const platformPage = (title, buyer, reference) => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta property="og:site_name" content="Tenderplatform Nederland"><title>${title} | Tenderplatform Nederland</title></head><body><header><a href="/">Tenderplatform Nederland</a> <span>Alle actuele aanbestedingen op één plek</span></header><main>
  <h1>${title}</h1><p>Aanbesteding gepubliceerd op het platform. Bekijk de aanbestedingsdocumenten.</p>
  <dl><dt>Opdrachtgever</dt><dd>${buyer}</dd><dt>Kenmerk</dt><dd>${reference}</dd><dt>Sluitingsdatum</dt><dd>15 december 2026</dd></dl><a href="/files/${reference}.pdf">Documenten</a></main><footer>Tenderplatform Nederland</footer></body></html>`;
export const PLATFORM_HOST = 'tender-platform.example';
export const PLATFORM_SITE = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/tenders/schoonmaak-kantoren': { body: platformPage('Aanbesteding schoonmaak kantoren', 'Gemeente Alpha', 'PL-2026-001') },
  '/tenders/groenonderhoud-park': { body: platformPage('Aanbesteding groenonderhoud park', 'Waterschap Beta', 'PL-2026-002') },
  '/tenders/vervanging-verlichting': { body: platformPage('Aanbesteding vervanging verlichting', 'Provincie Gamma', 'PL-2026-003') },
};
