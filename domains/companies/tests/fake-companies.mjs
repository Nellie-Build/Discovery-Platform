// In-memory company websites for the companies domain: no network, no copy of any real site. Hosts use the reserved ".example" TLD.

const html = (title, body, { head = '', site = '', footer = '' } = {}) => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${title}</title>${site ? `<meta property="og:site_name" content="${site}">` : ''}${head}</head>
<body><header><nav><a href="/">Home</a> <a href="/over-ons">Over ons</a> <a href="/diensten">Diensten</a> <a href="/sectoren">Sectoren</a> <a href="/projecten">Projecten</a> <a href="/contact">Contact</a> <a href="/nieuws">Nieuws</a></nav></header>
<main>${body}</main><footer>${footer}</footer></body></html>`;

/** A security installer in Rotterdam that installs camera systems for care institutions in Zuid-Holland. */
export const VEILIG_ZUID = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/': { body: html('Veilig Zuid | Camerabewaking en toegangscontrole', `<h1>Beveiliging voor bedrijven en instellingen</h1>
    <p>Veilig Zuid is uw installateur voor camerabewaking, toegangscontrole en alarmsystemen.</p>`, {
      site: 'Veilig Zuid', footer: '© 2026 Veilig Zuid B.V. · Havenstraat 12, 3011 AB Rotterdam · KvK 12345678',
      head: '<meta name="description" content="Veilig Zuid ontwerpt, installeert en onderhoudt camerasystemen en toegangscontrole voor zakelijke klanten.">',
    }) },
  '/diensten': { body: html('Diensten | Veilig Zuid', `<h1>Onze diensten</h1><h2>Installatie van camerasystemen</h2>
    <p>Wij installeren camerasystemen en verzorgen het onderhoud van uw beveiligingsinstallatie.</p><h2>Toegangscontrole</h2><p>Elektronische toegangscontrole met kaartlezers.</p>`) },
  '/sectoren': { body: html('Sectoren | Veilig Zuid', `<h1>Sectoren</h1>
    <p>Wij leveren en installeren camerabewaking voor zorginstellingen en ziekenhuizen in Zuid-Holland. Ook scholen en gemeenten behoren tot onze opdrachtgevers.</p>`) },
  '/projecten': { body: html('Projecten | Veilig Zuid', `<h1>Projecten</h1><p>Camerabewaking voor woonzorgcentrum De Linde, Parklaan 3, 2312 AB Leiden.</p>`) },
  '/over-ons': { body: html('Over ons | Veilig Zuid', `<h1>Over Veilig Zuid</h1><p>Ons werkgebied is Zuid-Holland. Wij zijn installateur en werken samen met groothandels.</p>`) },
  '/contact': { body: html('Contact | Veilig Zuid', `<h1>Contact</h1><p>Havenstraat 12, 3011 AB Rotterdam</p>
    <p>Telefoon: <a href="tel:0101234567">010 123 4567</a> · E-mail: <a href="mailto:info@veilig-zuid.example">info@veilig-zuid.example</a></p>
    <p>Of mail onze monteur direct: <a href="mailto:jan.jansen@veilig-zuid.example">jan.jansen@veilig-zuid.example</a>, 06 12345678</p>`) },
  '/nieuws': { body: html('Nieuws | Veilig Zuid', '<h1>Nieuws</h1><p>Nieuwe website.</p>') },
};

/** A camera web shop in Utrecht that mentions a hospital in passing, never as a customer sector. */
export const CAMERA_SHOP = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/': { body: html('Camerashop | Beveiligingscamera kopen', `<h1>Beveiligingscamera's voor thuis</h1>
    <p>Bestel eenvoudig een beveiligingscamera. Wij leveren in heel Nederland.</p><p>Het ziekenhuis bij ons om de hoek heeft ook camera's.</p>
    <ul><li>Dome camera € 89,95 <a href="/winkelwagen?add=1">In winkelwagen</a></li><li>Bullet camera € 129,- <a href="/winkelwagen?add=2">In winkelwagen</a></li><li>Deurbelcamera € 59,95</li></ul>
    <p>Voor thuis en kleine ondernemers. Vandaag besteld, morgen in huis. Gratis verzending vanaf € 50.</p>`, { site: 'Camerashop', footer: 'Camerashop, Stationsplein 1, 3511 AB Utrecht' }) },
  '/contact': { body: html('Contact | Camerashop', '<h1>Contact</h1><p>Stationsplein 1, 3511 AB Utrecht</p><p>Mail: klantenservice@camerashop.example</p>') },
};

/** A construction company in Delft specialised in utility construction and school renovation; a project address in Leiden. */
export const BOUW_DELFT = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/': { body: html('Bouwbedrijf Delftse Bouw | Utiliteitsbouw en renovatie', `<h1>Utiliteitsbouw en renovatie van scholen</h1>
    <p>Delftse Bouw is een aannemer gespecialiseerd in utiliteitsbouw en de renovatie van scholen.</p>`, { footer: '© 2026 Delftse Bouw B.V., Mijnbouwstraat 5, 2628 RX Delft' }) },
  '/projecten': { body: html('Projecten | Delftse Bouw', '<h1>Projecten</h1><p>Renovatie basisschool De Ster, Schoolstraat 1, 2312 AB Leiden, opgeleverd in 2025.</p>') },
  '/contact': { body: html('Contact | Delftse Bouw', '<h1>Contact</h1><p>Mijnbouwstraat 5, 2628 RX Delft. Bel 015 765 4321.</p>') },
};

/** A news site with a camera article: not a company site (no address, contact page or organisation data). */
export const NEWS_SITE = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/': { body: '<!doctype html><html><head><title>Beveiligingsnieuws</title></head><body><h1>Nieuws over camerabewaking</h1><p>Steeds meer ziekenhuizen gebruiken camerabewaking.</p></body></html>' },
};

/** A construction company that only mentions "onderwijshuisvesting" (a broader term), never school renovation itself; address with the place before the postcode. */
export const ONDERWIJSBOUW = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/': { body: html('Bouwgroep Maas | Onderwijshuisvesting en utiliteit', `<h1>Onderwijshuisvesting</h1>
    <p>Bouwgroep Maas is een aannemer voor onderwijshuisvesting, zorgvastgoed en kantoren.</p>
    <p>Wij werken voor woningcorporaties en gemeenten.</p>`, { footer: '© Copyright - Bouwgroep Maas B.V. · Achterdijk 46 Vierpolders 3237LA · Openingstijden ma-vr' }) },
  '/contact': { body: html('Contact | Bouwgroep Maas', '<h1>Contact</h1><p>Achterdijk 46 | Vierpolders | 3237LA</p><p>Openingstijden: maandag t/m vrijdag</p>') },
};

/** A wholesaler selling security products to installers only: business wording, prices excl. btw, no cart. The menu names fire detection, the content never does. */
export const GROOTHANDEL = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/': { body: html('Secu Groothandel | Beveiligingsproducten voor installateurs', `<h1>Groothandel in beveiligingsproducten</h1>
    <p>Secu Groothandel levert beveiligingsproducten voor installateurs. Alleen voor zakelijke klanten; alle prijzen excl. btw.</p>
    <p>Vraag een offerte aan of word dealer.</p>`, { footer: 'Secu Groothandel B.V., Industrieweg 3, 5611 AB Eindhoven' }).replace('<a href="/nieuws">Nieuws</a>', '<a href="/branddetectie">Branddetectie</a>') },
};

export const DOWN = { '/robots.txt': { status: 500, body: 'down' }, '/': { status: 500, body: 'down' } };

export const SITES = {
  'www.veilig-zuid.example': VEILIG_ZUID,
  'camerashop.example': CAMERA_SHOP,
  'www.delftse-bouw.example': BOUW_DELFT,
  'beveiligingsnieuws.example': NEWS_SITE,
  'kapot.example': DOWN,
  'www.onderwijsbouw.example': ONDERWIJSBOUW,
  'secu-groothandel.example': GROOTHANDEL,
};

/** A transport over `{ host: { path: { body, status?, contentType? } } }`; records every request. */
export function webTransport(sites) {
  const calls = [];
  const transport = async url => {
    const parsed = new URL(url);
    calls.push(parsed.href);
    const site = sites[parsed.hostname] ?? sites[`www.${parsed.hostname}`] ?? sites[parsed.hostname.replace(/^www\./, '')];
    const entry = site?.[parsed.pathname] ?? site?.[parsed.pathname.replace(/\/$/, '')];
    if (!entry) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: entry.status ?? 200, headers: { 'content-type': entry.contentType ?? 'text/html; charset=utf-8' }, body: Buffer.from(entry.body ?? '') };
  };
  return { transport, calls };
}

export function fakeClock(start = Date.parse('2026-09-25T10:00:00Z')) {
  let now = start;
  return { now: () => now, sleep: async ms => { now += ms; } };
}

/** A search provider answering from `[needle, results]` pairs (first needle contained in the query wins), recording queries. */
export function fakeSearchProvider(answers, { fail = false } = {}) {
  const queries = [];
  return {
    queries,
    async search(input) {
      queries.push(input);
      if (fail) throw new Error('provider down');
      const hit = answers.find(([needle]) => input.query.toLowerCase().includes(needle));
      return (hit ? hit[1] : []).map(([url, title, snippet]) => ({ url, title: title ?? null, snippet: snippet ?? null, source: 'fake' }));
    },
  };
}

export const SECURITY_RESULTS = [
  ['https://www.veilig-zuid.example/diensten', 'Installatie camerasystemen | Veilig Zuid', 'Camerabewaking voor zorginstellingen in Zuid-Holland'],
  ['https://camerashop.example/', 'Camerashop', "Beveiligingscamera's kopen"],
  ['https://www.bedrijvenpagina.nl/beveiliging/veilig-zuid', 'Veilig Zuid - Bedrijvenpagina', 'Beveiliging Rotterdam'],
  ['https://www.linkedin.com/company/veilig-zuid', 'Veilig Zuid | LinkedIn', null],
  ['https://beveiligingsnieuws.example/', 'Nieuws over camerabewaking', 'ziekenhuizen gebruiken camerabewaking'],
  ['https://kapot.example/', 'Kapot Beveiliging', 'camerabewaking'],
];
