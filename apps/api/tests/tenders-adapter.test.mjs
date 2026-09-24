import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTenderNedSource, createTedSource } from '@discovery-platform/domain-tenders';
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
      return p ? json({
        publicatieId: Number(p.id), kenmerk: p.kenmerk, referentieNummer: p.reference === undefined ? `REF-${p.kenmerk}` : p.reference,
        cpvCodes: p.cpv === undefined ? [{ isHoofdOpdracht: true, code: '45000000-7', omschrijving: 'Bouwwerkzaamheden' }] : p.cpv,
        nutsCodes: p.nuts === undefined ? [{ code: 'NL33', omschrijving: 'Zuid-Holland' }] : p.nuts,
      }) : json({}, 404);
    }
    const from = url.searchParams.get('publicatieDatumVanaf');
    const to = url.searchParams.get('publicatieDatumTot');
    const page = Number(url.searchParams.get('page'));
    const size = Number(url.searchParams.get('size'));
    const inRange = publications.filter(p => p.date >= from && p.date <= to);
    const content = inRange.slice(page * size, (page + 1) * size).map(p => ({
      publicatieId: p.id, publicatieDatum: p.date, typePublicatie: { code: p.type, omschrijving: p.typeLabel }, aanbestedingNaam: p.name, opdrachtgeverNaam: p.authority,
      sluitingsDatum: p.deadline, kenmerk: p.kenmerk, opdrachtBeschrijving: p.description,
      procedure: p.procedure === undefined ? { code: 'OPE', omschrijving: 'Openbaar' } : p.procedure, typeOpdracht: { code: 'W', omschrijving: 'Werken' },
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

test('stable dedupe on kenmerk: a stored tender is never created again — a new publication of it updates it, nothing else is touched', async () => {
  const first = await adapterFor([pub(1, 500), pub(3, 501)]).adapter.runDiscovery(input());
  const stored = first.records.map((record, index) => ({ id: `rec-${index}`, domainData: record.domainData }));
  const { adapter } = adapterFor([pub(1, 500), pub(9, 500, { type: 'REC', typeLabel: 'Rectificatie' }), pub(3, 501), pub(4, 502)]);
  const outcome = await adapter.runDiscovery(input({ existingRecords: [...stored, { id: 'rec-v', domainData: { title: 'a vacancy', company: 'x' } }] }));
  assert.deepEqual(outcome.records.map(r => r.domainData.tenderIdentity), ['502'], 'only the new tender is created');
  assert.deepEqual(outcome.updatedRecords.map(r => [r.existingRecordId, r.domainData.publications.map(p => p.publicationId)]), [['rec-0', ['1', '9']]]);
  assert.deepEqual(outcome.updatedRecords[0].sources.map(s => s.sourceData.publicationId), ['9'], 'provenance only for the new publication');
  assert.deepEqual(outcome.observedRecords.map(r => r.existingRecordId), ['rec-1']);
  assert.equal(outcome.stats.duplicatesUnchanged, 1);
  assert.equal(outcome.stats.duplicatesAgainstExisting, 2);
  assert.equal(outcome.stats.tendersToUpdate, 1);
  assert.equal(outcome.stats.recordsAccepted, 1);
});

test('a stored record that is sparse (older shape) is completed by the update, not rejected', async () => {
  const { adapter } = adapterFor([pub(1, 500)]);
  const outcome = await adapter.runDiscovery(input({ existingRecords: [{ id: 'old', domainData: { sourceSystem: 'tenderned', tenderIdentity: '500', title: 'old' } }] }));
  assert.equal(outcome.records.length, 0);
  assert.equal(outcome.updatedRecords.length, 1);
  assert.equal(outcome.updatedRecords[0].domainData.title, 'Aanbesteding 500');
  assert.equal(outcome.updatedRecords[0].domainData.publications.length, 1);
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
  assert.match(tooLong.error, /at most 90 days/);
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
    assert.equal(again.body.recordsUpdated, 0);
    assert.equal(again.body.stats.duplicatesUnchanged, 2);
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

// ─── updates of stored tenders: a new publication of the same kenmerk updates the record, never duplicates it ───

/** A mutable in-memory TenderNed behind a real API app: publications can be added between runs. */
async function updateApp(initial = []) {
  const publications = [...initial];
  const fake = fakeFetch(publications);
  const adapter = createTendersAdapter({ sources: { tenderned: () => createTenderNedSource({ fetch: fake.fetch, clock: clock(), minIntervalMs: 0, maxRetries: 0 }) } });
  const app = await startTestApp({ apiKey: 'test-key', domainRegistry: { tenders: adapter } });
  await app.db.query("UPDATE modules SET enabled = true, status = 'active' WHERE id = 'tenders'");
  const workspace = (await app.request('POST', '/workspaces', { body: { name: 'W' } })).body;
  const project = (await app.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Tenders', domain: 'tenders' } })).body;
  const body = { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21' } };
  return {
    ...app, publications, project,
    run: async () => (await app.request('POST', `/projects/${project.id}/runs`, { body })).body,
    records: async () => (await app.request('GET', `/projects/${project.id}/records`)).body,
    /** Every row of the record tables, as data: the state a run must leave untouched when nothing changed. */
    snapshot: async () => JSON.stringify([
      (await app.db.query('SELECT * FROM discovery_records ORDER BY id')).rows,
      (await app.db.query('SELECT * FROM record_sources ORDER BY id')).rows,
      (await app.db.query('SELECT * FROM record_contacts ORDER BY id')).rows,
    ]),
  };
}
const ids = record => record.domain_data.publications.map(p => p.publicationId);

test('announcement -> correction: the correction is added to publications[] of the same record, and the latest publication describes it', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19', description: 'Oorspronkelijke beschrijving.' })]);
  try {
    const first = await t.run();
    assert.equal(first.recordsCreated, 1);
    assert.equal(first.recordsUpdated, 0);
    t.publications.push(pub(2, 500, { date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie', description: 'Gecorrigeerde beschrijving.' }));
    const second = await t.run();
    assert.equal(second.status, 'succeeded');
    assert.equal(second.recordsCreated, 0);
    assert.equal(second.recordsUpdated, 1);
    assert.equal(second.stats.recordsUpdated, 1);
    assert.equal(second.stats.duplicatesUnchanged, 0);
    const records = await t.records();
    assert.equal(records.length, 1, 'no second record for the same tender');
    const [record] = records;
    assert.deepEqual(ids(record), ['1', '2']);
    assert.deepEqual(record.domain_data.publications.map(p => p.noticeType), ['AAO', 'REC']);
    assert.equal(record.domain_data.publicationId, '2');
    assert.equal(record.domain_data.noticeType, 'REC');
    assert.equal(record.domain_data.noticeTypeLabel, 'Rectificatie');
    assert.equal(record.domain_data.publicationDate, '2026-09-21');
    assert.equal(record.domain_data.description, 'Gecorrigeerde beschrijving.');
    // The new publication is also recorded as provenance; the record keeps its first source.
    const { rows } = await t.db.query('SELECT source_url FROM record_sources ORDER BY discovered_at, source_url');
    assert.equal(rows.length, 2);
  } finally { await t.close(); }
});

test('a correction with a changed deadline (and procedure, CPV and NUTS) updates those fields', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19', deadline: '2026-11-02T08:00:00' })]);
  try {
    await t.run();
    t.publications.push(pub(2, 500, {
      date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie', deadline: '2026-11-16T08:00:00',
      procedure: { code: 'NOP', omschrijving: 'Niet-openbaar' },
      cpv: [{ isHoofdOpdracht: true, code: '45100000-8', omschrijving: 'Sloopwerkzaamheden' }], nuts: [{ code: 'NL34', omschrijving: 'Zeeland' }],
    }));
    const run = await t.run();
    assert.equal(run.recordsUpdated, 1);
    const [record] = await t.records();
    assert.equal(record.domain_data.submissionDeadline, '2026-11-16T08:00:00');
    assert.equal(record.domain_data.procedureType, 'Niet-openbaar');
    assert.deepEqual(record.domain_data.cpvCodes.map(c => c.code), ['45100000']);
    assert.deepEqual(record.domain_data.nutsCodes.map(n => n.code), ['NL34']);
    assert.equal(record.domain_data.location, 'Zeeland');
  } finally { await t.close(); }
});

test('a later publication that lacks a field the earlier one had keeps the earlier information', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19', description: 'Volledige beschrijving.', reference: 'P-500' })]);
  try {
    await t.run();
    t.publications.push(pub(2, 500, { date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie', deadline: null, description: null, cpv: [], nuts: [], reference: null, procedure: null }));
    const run = await t.run();
    assert.equal(run.recordsUpdated, 1);
    const [record] = await t.records();
    assert.equal(record.domain_data.noticeType, 'REC', 'what the later publication states is taken over');
    assert.equal(record.domain_data.submissionDeadline, '2026-11-02T08:00:00');
    assert.equal(record.domain_data.description, 'Volledige beschrijving.');
    assert.equal(record.domain_data.referenceNumber, 'P-500');
    assert.equal(record.domain_data.procedureType, 'Openbaar');
    assert.equal(record.domain_data.cpvCodes.length, 1);
    assert.equal(record.domain_data.location, 'Zuid-Holland');
    assert.deepEqual(ids(record), ['1', '2']);
  } finally { await t.close(); }
});

test('the same publication id again: nothing is added twice; a changed value of that same publication is taken over', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19', description: 'Eerste tekst.' })]);
  try {
    await t.run();
    const again = await t.run();
    assert.equal(again.recordsUpdated, 0);
    assert.equal(again.stats.duplicatesUnchanged, 1);
    t.publications[0].description = 'Bijgewerkte tekst van dezelfde publicatie.';
    const changed = await t.run();
    assert.equal(changed.recordsUpdated, 1);
    const [record] = await t.records();
    assert.deepEqual(ids(record), ['1'], 'the publication id is listed once');
    assert.equal(record.domain_data.description, 'Bijgewerkte tekst van dezelfde publicatie.');
    const { rows } = await t.db.query('SELECT id FROM record_sources');
    assert.equal(rows.length, 1, 'no provenance row for a publication that was already known');
  } finally { await t.close(); }
});

test('the same publication twice in one run (a page shift while paging) still gives one publication', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19' })]);
  try {
    t.publications.push({ ...t.publications[0] });
    const run = await t.run();
    assert.equal(run.recordsCreated, 1);
    assert.deepEqual(ids((await t.records())[0]), ['1']);
  } finally { await t.close(); }
});

test('an award after the announcement: the same record, now described by the award; the deadline stays', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19', description: 'Beschrijving van de opdracht.' })]);
  try {
    await t.run();
    t.publications.push(pub(3, 500, { date: '2026-09-21', type: 'AGO', typeLabel: 'Aankondiging gegunde opdracht', deadline: null, description: null }));
    const run = await t.run();
    assert.equal(run.recordsCreated, 0);
    assert.equal(run.recordsUpdated, 1);
    const records = await t.records();
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.domain_data.noticeType, 'AGO');
    assert.equal(record.domain_data.publicationId, '3');
    assert.deepEqual(record.domain_data.publications.map(p => p.noticeType), ['AAO', 'AGO']);
    assert.equal(record.domain_data.submissionDeadline, '2026-11-02T08:00:00');
    assert.equal(record.domain_data.description, 'Beschrijving van de opdracht.');
  } finally { await t.close(); }
});

test('an older publication seen late fills gaps but does not overwrite what a newer publication states', async () => {
  const t = await updateApp([pub(5, 500, { date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie', deadline: '2026-11-16T08:00:00', description: null })]);
  try {
    await t.run();
    t.publications.push(pub(2, 500, { date: '2026-09-19', deadline: '2026-11-02T08:00:00', description: 'Tekst van de aankondiging.' }));
    const run = await t.run();
    assert.equal(run.recordsUpdated, 1);
    const [record] = await t.records();
    assert.deepEqual(ids(record), ['2', '5']);
    assert.equal(record.domain_data.publicationId, '5');
    assert.equal(record.domain_data.noticeType, 'REC');
    assert.equal(record.domain_data.submissionDeadline, '2026-11-16T08:00:00');
    assert.equal(record.domain_data.description, 'Tekst van de aankondiging.');
  } finally { await t.close(); }
});

test('idempotence: the same run twice leaves the record tables exactly as they were the second time — also after an update', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19' }), pub(2, 501, { date: '2026-09-20' })]);
  try {
    const first = await t.run();
    assert.equal(first.recordsCreated, 2);
    const afterFirst = await t.snapshot();
    const second = await t.run();
    assert.equal(second.recordsCreated, 0);
    assert.equal(second.recordsUpdated, 0);
    assert.equal(second.stats.duplicatesUnchanged, 2);
    assert.equal(await t.snapshot(), afterFirst, 'discovery_records, record_sources and record_contacts are untouched (even updated_at)');

    t.publications.push(pub(9, 500, { date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie', deadline: '2026-12-01T08:00:00' }));
    const update = await t.run();
    assert.equal(update.recordsUpdated, 1);
    assert.equal(update.stats.duplicatesUnchanged, 1);
    const afterUpdate = await t.snapshot();
    assert.notEqual(afterUpdate, afterFirst);
    const repeat = await t.run();
    assert.equal(repeat.recordsCreated, 0);
    assert.equal(repeat.recordsUpdated, 0);
    assert.equal(repeat.stats.duplicatesUnchanged, 2);
    assert.equal(await t.snapshot(), afterUpdate);
  } finally { await t.close(); }
});

test('run statistics keep created, updated and unchanged apart', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19' }), pub(2, 501, { date: '2026-09-19' })]);
  try {
    await t.run();
    t.publications.push(pub(3, 500, { date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie' }), pub(4, 502, { date: '2026-09-21' }));
    const run = await t.run();
    assert.equal(run.recordsCreated, 1);
    assert.equal(run.recordsUpdated, 1);
    assert.equal(run.stats.recordsCreated, 1);
    assert.equal(run.stats.recordsUpdated, 1);
    assert.equal(run.stats.duplicatesUnchanged, 1);
    assert.equal((await t.records()).length, 3);
  } finally { await t.close(); }
});

test('an update never crosses projects: the same tender in another project is its own record', async () => {
  const t = await updateApp([pub(1, 500, { date: '2026-09-19' })]);
  try {
    await t.run();
    const other = (await t.request('POST', '/projects', { body: { workspaceId: t.project.workspace_id, name: 'Other', domain: 'tenders' } })).body;
    const otherRun = (await t.request('POST', `/projects/${other.id}/runs`, { body: { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21' } } })).body;
    assert.equal(otherRun.recordsCreated, 1);
    t.publications.push(pub(2, 500, { date: '2026-09-21', type: 'REC', typeLabel: 'Rectificatie', deadline: '2026-12-31T08:00:00' }));
    await t.run();
    const untouched = (await t.request('GET', `/projects/${other.id}/records`)).body;
    assert.deepEqual(ids(untouched[0]), ['1'], 'the other project keeps its own state until its own run');
  } finally { await t.close(); }
});

// ─── TED as a second source: same adapter, its own identity space, idempotent, never merged with TenderNed ──────


const tedNotice = (number, overrides = {}) => ({
  'publication-number': number, 'notice-identifier': `nid-${number}`, 'notice-version': 1, 'procedure-identifier': `proc-${number.split('-')[0]}`, 'notice-type': 'cn-standard',
  'publication-date': '2026-09-21+02:00', 'title-proc': { nld: `TED aanbesteding ${number}` }, 'buyer-name': { nld: ['Gemeente Voorbeeld'] }, 'buyer-country': 'NLD',
  'procedure-type': 'open', 'contract-nature': ['services'], 'classification-cpv': ['72000000'], 'place-of-performance': ['NL411', 'NLD'],
  'deadline-receipt-tender-date-lot': ['2026-10-29+01:00'], 'deadline-receipt-tender-time-lot': ['10:00:00+01:00'], 'estimated-value-proc': '250000', 'estimated-value-cur-proc': 'EUR',
  links: { html: { NLD: `https://ted.europa.eu/nl/notice/-/detail/${number}` } }, ...overrides,
});
function fakeTedFetch(notices) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const from = /publication-date>=(\d{4})(\d{2})(\d{2})/.exec(body.query).slice(1).join('-');
    const to = /publication-date<=(\d{4})(\d{2})(\d{2})/.exec(body.query).slice(1).join('-');
    const found = notices.filter(n => n['publication-date'].slice(0, 10) >= from && n['publication-date'].slice(0, 10) <= to).sort((a, b) => a['publication-number'].localeCompare(b['publication-number']));
    const window = found.slice((body.page - 1) * body.limit, body.page * body.limit).map(n => Object.fromEntries(Object.entries(n).filter(([key]) => body.fields.includes(key))));
    return json({ notices: window, totalNoticeCount: found.length, iterationNextToken: null, timedOut: false });
  };
}

async function tedApp(initial = []) {
  const notices = [...initial];
  const publications = [];
  const nedFake = fakeFetch(publications);
  const adapter = createTendersAdapter({ sources: {
    ted: () => createTedSource({ fetch: fakeTedFetch(notices), clock: clock(), minIntervalMs: 0, maxRetries: 0 }),
    tenderned: () => createTenderNedSource({ fetch: nedFake.fetch, clock: clock(), minIntervalMs: 0, maxRetries: 0 }),
  } });
  const app = await startTestApp({ apiKey: 'test-key', domainRegistry: { tenders: adapter } });
  await app.db.query("UPDATE modules SET enabled = true, status = 'active' WHERE id = 'tenders'");
  const workspace = (await app.request('POST', '/workspaces', { body: { name: 'W' } })).body;
  const project = (await app.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Tenders', domain: 'tenders' } })).body;
  const filters = { publishedFrom: '2026-09-19', publishedTo: '2026-09-21' };
  return {
    ...app, notices, publications, project,
    run: async (sourceId = 'ted') => (await app.request('POST', `/projects/${project.id}/runs`, { body: { sourceId, filters } })).body,
    records: async () => (await app.request('GET', `/projects/${project.id}/records`)).body,
    snapshot: async () => JSON.stringify([(await app.db.query('SELECT * FROM discovery_records ORDER BY id')).rows, (await app.db.query('SELECT * FROM record_sources ORDER BY id')).rows]),
  };
}

test('a TED run creates tender records from TED notices (source system "ted", TED identity, per-publication provenance)', async () => {
  const t = await tedApp([tedNotice('600001-2026'), tedNotice('600002-2026', { 'publication-date': '2026-09-20+02:00' })]);
  try {
    const run = await t.run();
    assert.equal(run.status, 'succeeded');
    assert.equal(run.recordsCreated, 2);
    assert.equal(run.stats.sourceId, 'ted');
    assert.equal(run.stats.country, 'NLD');
    const records = await t.records();
    const record = records.find(r => r.domain_data.publicationId === '600001-2026');
    assert.equal(record.domain_data.sourceSystem, 'ted');
    assert.equal(record.domain_data.tenderIdentity, 'proc-600001');
    assert.equal(record.domain_data.title, 'TED aanbesteding 600001-2026');
    assert.equal(record.domain_data.submissionDeadline, '2026-10-29T10:00:00');
    assert.deepEqual(record.domain_data.estimatedValue, { amount: 250000, currency: 'EUR' });
    const { rows } = await t.db.query('SELECT source_url, source_label, source_data FROM record_sources ORDER BY source_url');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source_label, 'ted');
    assert.equal(rows[0].source_url, 'https://ted.europa.eu/nl/notice/-/detail/600001-2026');
  } finally { await t.close(); }
});

test('idempotent: the same TED run twice leaves the record tables exactly as they were the second time', async () => {
  const t = await tedApp([tedNotice('600001-2026'), tedNotice('600002-2026')]);
  try {
    await t.run();
    const after = await t.snapshot();
    const again = await t.run();
    assert.equal(again.recordsCreated, 0);
    assert.equal(again.recordsUpdated, 0);
    assert.equal(again.stats.duplicatesUnchanged, 2);
    assert.equal(await t.snapshot(), after);
  } finally { await t.close(); }
});

test('an award notice of the same procedure updates the existing tender record (one record, two TED publications)', async () => {
  const t = await tedApp([tedNotice('600001-2026', { 'procedure-identifier': 'proc-A', 'publication-date': '2026-09-19+02:00' })]);
  try {
    await t.run();
    t.notices.push(tedNotice('650001-2026', { 'procedure-identifier': 'proc-A', 'notice-type': 'can-standard', 'deadline-receipt-tender-date-lot': undefined, 'deadline-receipt-tender-time-lot': undefined }));
    const run = await t.run();
    assert.equal(run.recordsCreated, 0);
    assert.equal(run.recordsUpdated, 1);
    const records = await t.records();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].domain_data.publications.map(p => [p.publicationId, p.noticeType]), [['600001-2026', 'cn-standard'], ['650001-2026', 'can-standard']]);
    assert.equal(records[0].domain_data.noticeType, 'can-standard');
    assert.equal(records[0].domain_data.submissionDeadline, '2026-10-29T10:00:00');
    const { rows } = await t.db.query('SELECT source_url FROM record_sources ORDER BY source_url');
    assert.deepEqual(rows.map(r => r.source_url), ['https://ted.europa.eu/nl/notice/-/detail/600001-2026', 'https://ted.europa.eu/nl/notice/-/detail/650001-2026']);
  } finally { await t.close(); }
});

test('TenderNed and TED records of what looks like the same tender stay separate: no blind cross-source dedupe', async () => {
  const t = await tedApp([tedNotice('600001-2026', { 'procedure-identifier': '500', 'title-proc': { nld: 'Aanbesteding 500' } })]);
  try {
    t.publications.push(pub(1, 500, { date: '2026-09-21' }));
    const ted = await t.run('ted');
    const nl = await t.run('tenderned');
    assert.equal(ted.recordsCreated, 1);
    assert.equal(nl.recordsCreated, 1, 'the identical kenmerk / procedure number does not match across sources');
    assert.equal(nl.recordsUpdated, 0);
    const records = await t.records();
    assert.deepEqual(records.map(r => r.domain_data.sourceSystem).sort(), ['ted', 'tenderned']);
    const again = await t.run('ted');
    assert.equal(again.stats.duplicatesUnchanged, 1);
    assert.equal((await t.records()).length, 2);
  } finally { await t.close(); }
});

test('a TED run validates its own filters: a bad country fails the run cleanly', async () => {
  const t = await tedApp([tedNotice('600001-2026')]);
  try {
    const run = (await t.request('POST', `/projects/${t.project.id}/runs`, { body: { sourceId: 'ted', filters: { country: 'NL' } } })).body;
    assert.equal(run.status, 'failed');
    assert.match(run.error, /ISO 3166-1 alpha-3/);
  } finally { await t.close(); }
});
