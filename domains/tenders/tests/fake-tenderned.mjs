/**
 * An in-memory TenderNed: the paged publication list (with the real query parameters and JSON shape) plus a
 * detail document per publication. No network. `publications` are { id, kenmerk, date, type, name, authority, ... }.
 */
export function publication(overrides = {}) {
  const id = String(overrides.id ?? 440000);
  return {
    id, kenmerk: overrides.kenmerk ?? Number(id) + 100000, date: '2026-09-21', type: 'AAO', typeLabel: 'Aankondiging opdracht',
    name: `Aanbesteding ${id}`, authority: 'Gemeente Voorbeeld', deadline: '2026-11-02T08:00:00', description: `Beschrijving van ${id}.`,
    procedure: { code: 'OPE', omschrijving: 'Openbaar' }, contract: { code: 'D', omschrijving: 'Diensten' },
    cpv: [{ isHoofdOpdracht: true, code: '77000000-0', omschrijving: 'Diensten voor land-, bos- en tuinbouw' }],
    nuts: [{ code: 'NL22', omschrijving: 'Gelderland' }], reference: `P-${id}`, ...overrides, id,
  };
}
const listItem = p => ({
  publicatieId: p.id, publicatieDatum: p.date, typePublicatie: { code: p.type, omschrijving: p.typeLabel }, aanbestedingNaam: p.name,
  opdrachtgeverNaam: p.authority, sluitingsDatum: p.deadline, procedure: p.procedure, typeOpdracht: p.contract, europees: true,
  opdrachtBeschrijving: p.description, kenmerk: p.kenmerk, link: { href: `https://www.tenderned.nl/aankondigingen/overzicht/${p.id}`, title: 'self' },
});
const detailItem = p => ({
  publicatieId: Number(p.id), kenmerk: p.kenmerk, aanbestedingNaam: p.name, opdrachtgeverNaam: p.authority, publicatieDatum: `${p.date}T10:00:00.000000`,
  sluitingsDatum: p.deadline, cpvCodes: p.cpv, nutsCodes: p.nuts, referentieNummer: p.reference,
  procedureCode: p.procedure, typeOpdrachtCode: p.contract,
});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** `failures`: (url, callNumber) => Response | Error | undefined — return something to override the answer for that call. */
export function fakeTenderNed(publications, { failures } = {}) {
  const calls = [];
  async function fetchImpl(input) {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const override = failures?.(url, calls.length);
    if (override instanceof Error) throw override;
    if (override) return override;
    const detail = /\/publicaties\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const p = publications.find(x => x.id === detail[1]);
      return p ? json(detailItem(p)) : json({ message: 'not found' }, 404);
    }
    if (!url.pathname.endsWith('/publicaties')) return json({}, 404);
    const from = url.searchParams.get('publicatieDatumVanaf');
    const to = url.searchParams.get('publicatieDatumTot');
    const page = Number(url.searchParams.get('page') ?? 0);
    const size = Number(url.searchParams.get('size') ?? 20);
    if (size > 100) return new Response('[PARAMETER]', { status: 400 });
    const inRange = publications.filter(p => (!from || p.date >= from) && (!to || p.date <= to));
    const content = inRange.slice(page * size, page * size + size).map(listItem);
    const totalPages = Math.ceil(inRange.length / size);
    return json({ content, first: page === 0, last: page + 1 >= totalPages, totalElements: inRange.length, totalPages, size, number: page, numberOfElements: content.length });
  }
  return { fetch: fetchImpl, calls };
}

export function fakeClock(startIso = '2026-09-21T12:00:00Z') {
  let now = Date.parse(startIso);
  const sleeps = [];
  return { now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, sleeps };
}
