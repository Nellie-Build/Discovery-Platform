import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp } from './helpers/test-app.mjs';

const meta = (site, jobs) => ({ provider: 'ts-jobspy', site, status: jobs ? 'ok' : 'empty', candidates: jobs, durationMs: 5, error: null });
const candidate = (site, title, id, extra = {}) => ({ site, sourceUrl: `https://example.com/${id}`, needsEnrichment: false,
  facts: { title, description: `${title} beschrijving`, company: `Bedrijf ${id}`, location: 'Utrecht', email: `${id}@example.com`, ...extra } });

const BUCKETS = ['notProcessed', 'noUsableData', 'rejectedByRelevance', 'rejectedByDate', 'duplicatesInRun', 'alreadyKnown', 'cutByTarget', 'newRecords'];
/** The documented invariant: every discovered candidate ends in exactly one bucket. */
function assertAddsUp(bucket, label) {
  const sum = BUCKETS.reduce((total, key) => total + bucket[key], 0);
  assert.equal(bucket.discovered + bucket.multiRecordExtra, sum, `${label}: buckets must add up to discovered`);
  assert.equal(bucket.relevant, bucket.rejectedByDate + bucket.duplicatesInRun + bucket.alreadyKnown + bucket.cutByTarget + bucket.newRecords, `${label}: relevant is a subtotal`);
}

test('run breakdown accounts for every candidate, in total and per provider', async () => {
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let result;
  const app = await startTestApp({ pages: {}, apiKey: 'test-key', jobBoardProvider: { async findCandidates() { return result; } } });
  try {
    const workspace = (await app.request('POST', '/workspaces', { body: { name: 'Breakdown' } })).body;
    const project = (await app.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Breakdown', domain: 'vacancies' } })).body;
    const run = async (body = {}) => (await app.request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Security', region: 'Nederland', runConfig: { targetRecords: 50 }, filters: { postedWithinDays: 30 }, ...body } })).body;

    const indeed = [
      candidate('indeed', 'Security Officer', 'a', { postedDate: recent }),
      candidate('indeed', 'Security Officer', 'a', { postedDate: recent }), // same vacancy twice
      candidate('indeed', 'Docent Onderwijs', 'teacher'),                    // no relation to the search
      candidate('indeed', 'Security Guard', 'old', { postedDate: old }),     // outside the date filter
    ];
    const linkedin = [candidate('linkedin', 'Security Supervisor', 'b', { postedDate: recent })];
    result = { candidates: [...indeed, ...linkedin], meta: [meta('indeed', indeed.length), meta('linkedin', linkedin.length)] };
    const first = await run();
    const b = first.stats.breakdown;
    assert.ok(b, 'branch runs report a breakdown');
    assert.deepEqual({ d: b.discovered, rel: b.rejectedByRelevance, date: b.rejectedByDate, dup: b.duplicatesInRun, known: b.alreadyKnown, fresh: b.newRecords, relevant: b.relevant },
      { d: 5, rel: 1, date: 1, dup: 1, known: 0, fresh: 2, relevant: 4 });
    assert.equal(b.newRecords, first.recordsCreated);
    assert.equal(b.rejectedByRelevance, first.stats.candidatesRejectedByRelevance);
    assert.equal(b.relevant, first.stats.candidatesRelevant);
    assertAddsUp(b, 'total');
    for (const [site, bucket] of Object.entries(b.byProvider)) assertAddsUp(bucket, site);
    assert.equal(b.byProvider.indeed.discovered, 4);
    assert.equal(b.byProvider.indeed.newRecords, 1);
    assert.equal(b.byProvider.linkedin.newRecords, 1);
    assert.equal(b.byProvider.indeed.rejectedByRelevance, 1);

    // The same search again: what is now stored is "already known", not new.
    const second = await run();
    const again = second.stats.breakdown;
    assert.equal(again.newRecords, 0);
    assert.equal(again.alreadyKnown, 2);
    assert.equal(second.recordsCreated, 0);
    assertAddsUp(again, 'second run total');
    for (const [site, bucket] of Object.entries(again.byProvider)) assertAddsUp(bucket, `second ${site}`);

    // Candidates that are never processed because the target was reached first are their own bucket.
    result = { candidates: [candidate('indeed', 'Security Analist', 'c'), candidate('indeed', 'Security Engineer', 'd'), candidate('indeed', 'Security Manager', 'e')], meta: [meta('indeed', 3), meta('linkedin', 0)] };
    const capped = await run({ runConfig: { targetRecords: 1 } });
    const c = capped.stats.breakdown;
    assert.equal(c.newRecords, 1);
    assert.equal(c.notProcessed, 2);
    assertAddsUp(c, 'capped total');
    assertAddsUp(c.byProvider.indeed, 'capped indeed');

    // A run with nothing usable still reports a consistent, empty breakdown.
    result = { candidates: [], meta: [meta('indeed', 0), meta('linkedin', 0)] };
    const empty = (await run()).stats.breakdown;
    assert.equal(empty.discovered, 0);
    assertAddsUp(empty, 'empty');
  } finally { await app.close(); }
});
