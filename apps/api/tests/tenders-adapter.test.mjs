import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTenderNedSource } from '@discovery-platform/domain-tenders';
import { createTendersAdapter } from '../dist/domains/tenders-adapter.js';
import { startTestApp } from './helpers/test-app.mjs';

/**
 * The tenders adapter end to end against an in-memory TenderNed (real source code, fake fetch): one `source` run
 * turns publications into tender records, publications of one tender become one record, stored tenders are
 * never created twice, and the module is off until an admin enables it. No network.
 */
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pub = (id, kenmerk, extra = {}) => ({ id: String(id), kenmerk, date: '2026-09-21', type: 'AAO', typeLabel: 'Aankondiging opdracht', name: `Aanbesteding ${kenmerk}`, authority: 'Gemeente Voorbeeld', deadline: '2026-11-02T08:00:00', ...extra });
function fakeFetch(publications, { failAll } = {}) {
  const calls = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (failAll) return new Response('down', { status: 500 });
    const detail = /\/publicaties\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const p = publications.find(x => x.id === detail[1]);
      return p ? json({ publicatieId: Number(p.id), kenmerk: p.kenmerk, referentieNummer: `REF-${p.kenmerk}`, cpvCodes: [{ isHoofdOpdracht: true, code: '45000000-7', omschrijving: 'Bouwwerkzaamheden' }], nutsCodes: [{ code: 'NL33', omschrijving: 'Zuid-Holland' }] }) : json({}, 404);
    }
    const from = url.searchParams.get('publicatieDatumVanaf');
    const to = url.searchParams.get('publicatieDatumTot');
    const page = Number(url.searchParams.get('page'));
    const size = Number(url.searchParams.get('size'));
    const inRange = publications.filter(p => p.date >= from && p.date <= to);
    const content = inRange.slice(page * size, (page + 1) * size).map(p => ({
      publicatieId: p.id, publicatieDatum: p.date, typePublicatie: { code: p.type, omschrijving: p.typeLabel }, aanbestedingNaam: p.name, opdrachtgeverNaam: p.authority,
      sluitingsDatum: p.deadline, kenmerk: p.kenmerk, procedure: { code: 'OPE', omschrijving: 'Openbaar' }, typeOpdracht: { code: 'W', omschrijving: 'Werken' },
    }));
    const totalPages = Math.ceil(inRange.length / size);
    return json({ content, last: page + 1 >= totalPages, totalPages, number: page, size });
  };
  return { fetch: fetchImpl, calls };
}
const clock = () => { let now = Date.parse('2026-09-21T12:00:00Z'); return { now: () => now, sleep: async ms => { now += ms; } }; };
function adapterFor(publications, options) {
  const fake = fakeFetch(publications, options);
  return { fake, adapter: createTendersAdapter({ sources: { tenderned: () => createTenderNedSource({ fetch: fake.fetch, clock: clock(), minIntervalMs: 0, maxRetries: 0 }) } }) };
}
const runConfig = (over = {}) => ({ targetRecords: 50, searchBreadth: 'standard', budgetSource: 'adaptive', maxPages: 20, maxCandidates: 100, maxDurationMs: 60_000, maxEnrichments: 5, onlyNewRecords: true, ...over });
const input = (over = {}) => ({ mode: 'source', sourceId: 'tenderned', filters: { publishedFrom: '2026-09-21', publishedTo: '2026-09-21' }, runConfig: runConfig(), existingRecords: [], ...over });

test('a source run creates one record per tender, with tender facts, provenance and a completeness score', async () => {
  const { adapter } = adapterFor([pub(1, 500), pub(2, 501), pub(3, 502)]);
  const outcome = await adapter.runDiscovery(input());
  assert.equal(outcome.status, undefined);
  assert.equal(outcome.records.length, 3);
  const [first] = outcome.records;
  assert.equal(first.displayName, 'Aanbesteding 500');
  assert.equal(first.domainData.tenderIdentity, '500');
  assert.equal(first.domainData.sourceSystem, 'tenderned');
  assert.equal(first.domainData.referenceNumber, 'REF-500');
  assert.equal(first.domainData.cpvCodes[0].code, '45000000');
  assert.equal(first.domainData.location, 'Zuid-Holland');
  assert.ok(first.score > 0);
  assert.equal(first.sources[0].sourceType, 'api');
  assert.equal(first.sources[0].sourceLabel, 'tenderned');
  assert.equal(first.contacts.length, 0);
  assert.equal(outcome.stats.searchMode, 'source');
  assert.equal(outcome.stats.tendersFound, 3);
  assert.equal(outcome.stats.stopReason, 'no_more_candidates');
  assert.equal(outcome.stats.publishedFrom, '2026-09-21');
});

test('two publications with the same kenmerk become ONE record, listing both publications', async () => {
  const { adapter } = adapterFor([
    pub(1, 500), pub(2, 500, { date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie', deadline: '2026-11-16T08:00:00' }), pub(3, 501),
  ]);
  const outcome = await adapter.runDiscovery(input());
  assert.equal(outcome.records.length, 2);
  const tender = outcome.records.find(r => r.domainData.tenderIdentity === '500');
  assert.deepEqual(tender.domainData.publications.map(p => p.publicationId), ['1', '2']);
  assert.equal(tender.domainData.submissionDeadline, '2026-11-16T08:00:00');
  assert.deepEqual(tender.sources[0].sourceData.publicationIds, ['1', '2']);
  assert.equal(outcome.stats.publicationsFetched, 3);
  assert.equal(outcome.stats.publicationsMergedIntoOtherPublications, 1);
});

test('stable dedupe on kenmerk: a stored tender is not created again, even when a new publication of it appears', async () => {
  const { adapter } = adapterFor([pub(1, 500), pub(9, 500, { type: 'REC' }), pub(3, 501)]);
  const existing = [{ id: 'rec-1', domainData: { sourceSystem: 'tenderned', tenderIdentity: '500', title: 'old' } }, { id: 'rec-v', domainData: { title: 'a vacancy', company: 'x' } }];
  const outcome = await adapter.runDiscovery(input({ existingRecords: existing }));
  assert.deepEqual(outcome.records.map(r => r.domainData.tenderIdentity), ['501']);
  assert.equal(outcome.observedRecords.length, 1);
  assert.equal(outcome.observedRecords[0].existingRecordId, 'rec-1');
  assert.equal(outcome.stats.duplicatesAgainstExisting, 1);
  assert.equal(outcome.stats.recordsAccepted, 1);
});

test('the same kenmerk from another source system is a different tender', async () => {
  const { adapter } = adapterFor([pub(1, 500)]);
  const outcome = await adapter.runDiscovery(input({ existingRecords: [{ id: 'x', domainData: { sourceSystem: 'other', tenderIdentity: '500' } }] }));
  assert.equal(outcome.records.length, 1);
});

test('targetRecords and the candidate limit cut the run and are reported', async () => {
  const publications = Array.from({ length: 8 }, (_, i) => pub(i + 1, 600 + i));
  const cut = await adapterFor(publications).adapter.runDiscovery(input({ runConfig: runConfig({ targetRecords: 3 }) }));
  assert.equal(cut.records.length, 3);
  assert.equal(cut.stats.stopReason, 'target_reached');
  const limited = await adapterFor(publications).adapter.runDiscovery(input({ runConfig: runConfig({ maxCandidates: 5 }) }));
  assert.equal(limited.stats.stopReason, 'candidate_limit');
  assert.equal(limited.stats.publicationsFetched, 5);
  assert.equal(limited.stats.exhausted, false);
});

test('date filter and CPV filter reach the source; a range that is too long fails the run cleanly', async () => {
  const publications = [pub(1, 500, { date: '2026-09-20' }), pub(2, 501, { date: '2026-09-21' })];
  const { adapter, fake } = adapterFor(publications);
  const one = await adapter.runDiscovery(input({ filters: { publishedFrom: '2026-09-20', publishedTo: '2026-09-20' } }));
  assert.deepEqual(one.records.map(r => r.domainData.tenderIdentity), ['500']);
  assert.ok(fake.calls[0].includes('publicatieDatumVanaf=2026-09-20'));
  const none = await adapterFor(publications).adapter.runDiscovery(input({ filters: { publishedFrom: '2026-09-20', publishedTo: '2026-09-21', cpvPrefixes: ['77'] } }));
  assert.equal(none.records.length, 0);
  const tooLong = await adapterFor(publications).adapter.runDiscovery(input({ filters: { publishedFrom: '2026-01-01', publishedTo: '2026-09-21' } }));
  assert.equal(tooLong.status, 'failed');
  assert.match(tooLong.error, /at most 14 days/);
});

test('failures are reported, not thrown: an unknown source, a wrong mode and a source that is down', async () => {
  const { adapter } = adapterFor([pub(1, 500)]);
  const unknown = await adapter.runDiscovery(input({ sourceId: 'nope' }));
  assert.equal(unknown.status, 'failed');
  assert.match(unknown.error, /Onbekende bron/);
  const wrongMode = await adapter.runDiscovery({ mode: 'website', sourceUrl: 'https://example.test', filters: {}, runConfig: runConfig(), existingRecords: [] });
  assert.equal(wrongMode.status, 'failed');
  const down = await adapterFor([pub(1, 500)], { failAll: true }).adapter.runDiscovery(input());
  assert.equal(down.status, 'failed');
  assert.match(down.error, /^http: /);
  assert.equal(down.records.length, 0);
});

// ─── through the HTTP API: the module gate and the run route ────────────────────────────────────────

test('over HTTP: the tenders module is disabled by default; once enabled, one TenderNed run stores tender records and a second run stores nothing new', async () => {
  const { adapter } = adapterFor([pub(1, 500), pub(2, 500, { type: 'REC' }), pub(3, 501)]);
  const { request, close, db } = await startTestApp({ apiKey: 'test-key', domainRegistry: { tenders: adapter } });
  try {
    const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
    const blocked = await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Tenders', domain: 'tenders' } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'module_disabled');

    await db.query("UPDATE modules SET enabled = true, status = 'active' WHERE id = 'tenders'");
    const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Tenders', domain: 'tenders' } })).body;
    const body = { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-21', publishedTo: '2026-09-21' } };
    const run = await request('POST', `/projects/${project.id}/runs`, { body });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 2);
    assert.equal(run.body.stats.searchMode, 'source');

    const records = (await request('GET', `/projects/${project.id}/records`)).body;
    assert.equal(records.length, 2);
    assert.ok(records.every(r => r.domain === 'tenders'));
    const merged = records.find(r => r.domain_data.tenderIdentity === '500');
    assert.equal(merged.domain_data.publications.length, 2);
    assert.equal(merged.display_name, 'Aanbesteding 500');

    const again = await request('POST', `/projects/${project.id}/runs`, { body });
    assert.equal(again.body.status, 'succeeded');
    assert.equal(again.body.recordsCreated, 0);
    assert.equal(again.body.stats.duplicatesAgainstExisting, 2);
    assert.equal((await request('GET', `/projects/${project.id}/records`)).body.length, 2);

    const noSource = await request('POST', `/projects/${project.id}/runs`, { body: {} });
    assert.equal(noSource.status, 400);
    const badId = await request('POST', `/projects/${project.id}/runs`, { body: { sourceId: '../etc' } });
    assert.equal(badId.status, 400);
  } finally { await close(); }
});

test('over HTTP: a vacancies project asked for a source run fails the run cleanly instead of crashing', async () => {
  const { request, close } = await startTestApp({ pages: {}, apiKey: 'test-key' });
  try {
    const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
    const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'V', domain: 'vacancies' } })).body;
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceId: 'tenderned' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'failed');
  } finally { await close(); }
});
