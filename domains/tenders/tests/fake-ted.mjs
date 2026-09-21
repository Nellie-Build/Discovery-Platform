/**
 * An in-memory TED Search API: POST /v3/notices/search with the expert-query shapes the source builds (country, publication
 * date range, CPV / NUTS wildcards), PAGE_NUMBER paging in ascending publication number, and the real answer shape.
 * No network.
 */
export function notice(overrides = {}) {
  const number = overrides['publication-number'] ?? '600001-2026';
  const id = number.split('-')[0];
  return {
    'publication-number': number, 'notice-identifier': `00000000-0000-4000-8000-${id.padStart(12, '0')}`, 'notice-version': 1,
    'procedure-identifier': `11111111-1111-4111-8111-${id.padStart(12, '0')}`, 'notice-type': 'cn-standard',
    'publication-date': '2026-09-21+02:00', 'dispatch-date': '2026-09-18+02:00',
    'title-proc': { nld: `Aanbesteding ${id}` }, 'title-lot': { nld: [`Perceel ${id}`] },
    'notice-title': { nld: `Nederland – Diensten – Aanbesteding ${id}` }, 'description-proc': { nld: `Beschrijving van ${id}.` },
    'buyer-name': { nld: ['Gemeente Voorbeeld'] }, 'buyer-country': 'NLD', 'procedure-type': 'open', 'contract-nature': ['services', 'services'],
    'classification-cpv': ['72000000', '72000000'], 'place-of-performance': ['NL411', 'NLD', 'NL411', 'NLD'],
    'deadline-receipt-tender-date-lot': ['2026-10-29+01:00'], 'deadline-receipt-tender-time-lot': ['10:00:00+01:00'],
    'estimated-value-proc': '250000', 'estimated-value-cur-proc': 'EUR', 'estimated-value-lot': ['250000'], 'estimated-value-cur-lot': ['EUR'],
    'identifier-lot': ['LOT-0001'],
    links: { html: { NLD: `https://ted.europa.eu/nl/notice/-/detail/${number}`, ENG: `https://ted.europa.eu/en/notice/-/detail/${number}` } },
    ...overrides,
  };
}

const ymd = value => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;

/** Applies the clauses buildTedQuery produces. Anything else is an error, like the real API's "syntax error". */
function matches(n, query) {
  const clauses = query.split(' AND ');
  return clauses.every(clause => {
    let m;
    if ((m = /^buyer-country=([A-Z]{3})$/.exec(clause))) return n['buyer-country'] === m[1];
    if ((m = /^publication-date>=(\d{8})$/.exec(clause))) return n['publication-date'].slice(0, 10) >= ymd(m[1]);
    if ((m = /^publication-date<=(\d{8})$/.exec(clause))) return n['publication-date'].slice(0, 10) <= ymd(m[1]);
    if ((m = /^\(?((?:classification-cpv|place-of-performance)=[A-Z0-9]+\*(?: OR (?:classification-cpv|place-of-performance)=[A-Z0-9]+\*)*)\)?$/.exec(clause))) {
      return m[1].split(' OR ').some(part => {
        const [field, prefix] = part.replace(/\*$/, '').split('=');
        return (n[field] ?? []).some(value => value.startsWith(prefix));
      });
    }
    throw new Error(`fake TED cannot parse clause: ${clause}`);
  });
}

/** `failures`: (callNumber, body) => Response | Error | undefined overrides one answer. */
export function fakeTed(notices, { failures, totalOverride } = {}) {
  const calls = [];
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, body });
    const override = failures?.(calls.length, body);
    if (override instanceof Error) throw override;
    if (override) return override;
    let found;
    try { found = notices.filter(n => matches(n, body.query)).sort((a, b) => a['publication-number'].localeCompare(b['publication-number'])); }
    catch (error) { return new Response(JSON.stringify({ message: String(error.message) }), { status: 400 }); }
    const window = found.slice((body.page - 1) * body.limit, body.page * body.limit).map(n => Object.fromEntries(Object.entries(n).filter(([key]) => body.fields.includes(key))));
    return new Response(JSON.stringify({ notices: window, totalNoticeCount: totalOverride ?? found.length, iterationNextToken: null, timedOut: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return { fetch: fetchImpl, calls };
}

export function fakeClock(startIso = '2026-09-21T12:00:00Z') {
  let now = Date.parse(startIso);
  const sleeps = [];
  return { now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, sleeps };
}
