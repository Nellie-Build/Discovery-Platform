import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFromSource, SourceError } from '../dist/index.js';

/** A source that pages over `total` numbered items, `limit` at a time; the cursor is the next offset. */
function numberedSource(total, { kind = 'api', pageOverride } = {}) {
  const calls = [];
  return {
    id: 'numbers', kind, calls,
    async fetchBatch({ cursor, filters, limit }) {
      calls.push({ cursor, filters, limit });
      const offset = cursor === null ? 0 : Number(cursor);
      const size = pageOverride ?? limit;
      const items = Array.from({ length: Math.max(0, Math.min(size, total - offset)) }, (_, i) => ({
        externalId: String(offset + i), sourceUrl: `https://example.test/${offset + i}`, fetchedAt: '2026-01-01T00:00:00.000Z', raw: { n: offset + i },
      }));
      const next = offset + items.length;
      return { items, nextCursor: next >= total ? null : String(next), exhausted: next >= total };
    },
  };
}

test('a source is just id + kind + fetchBatch; the walk hands the cursor, filters and limit through', async () => {
  const source = numberedSource(5);
  const result = await collectFromSource(source, { batchSize: 2, maxItems: 100, filters: { any: 'thing' } });
  assert.deepEqual(result.items.map(i => i.externalId), ['0', '1', '2', '3', '4']);
  assert.equal(result.exhausted, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.batches, 3);
  assert.equal(result.stopReason, 'exhausted');
  assert.deepEqual(source.calls.map(c => c.cursor), [null, '2', '4']);
  assert.ok(source.calls.every(c => c.limit === 2 && c.filters.any === 'thing'));
});

test('every source kind works the same way (api, feed, website)', async () => {
  for (const kind of ['api', 'feed', 'website']) {
    const result = await collectFromSource(numberedSource(3, { kind }), { batchSize: 10, maxItems: 10 });
    assert.equal(result.items.length, 3, kind);
  }
});

test('limits: items, batches and time each end the walk, with the cursor to resume from', async () => {
  const byItems = await collectFromSource(numberedSource(10), { batchSize: 3, maxItems: 5 });
  assert.equal(byItems.items.length, 5);
  assert.equal(byItems.stopReason, 'item_limit');
  assert.equal(byItems.nextCursor, '3', 'the cut-short batch is resumed, not skipped');
  const byBatches = await collectFromSource(numberedSource(10), { batchSize: 2, maxItems: 100, maxBatches: 2 });
  assert.equal(byBatches.stopReason, 'batch_limit');
  assert.equal(byBatches.nextCursor, '4');
  let now = 0;
  const source = numberedSource(100);
  const original = source.fetchBatch;
  source.fetchBatch = async request => { now += 600; return original(request); };
  const byTime = await collectFromSource(source, { batchSize: 1, maxItems: 100, maxDurationMs: 1000, now: () => now });
  assert.equal(byTime.stopReason, 'time_limit');
  assert.equal(byTime.batches, 2);
});

test('resuming from a returned cursor continues exactly where the previous walk stopped', async () => {
  const first = await collectFromSource(numberedSource(8), { batchSize: 3, maxItems: 3 });
  const second = await collectFromSource(numberedSource(8), { batchSize: 3, maxItems: 100, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map(i => i.externalId), ['0', '1', '2', '3', '4', '5', '6', '7']);
});

test('a walk that makes no progress ends instead of looping, and a source that ignores the limit is refused', async () => {
  const stuck = { id: 's', kind: 'api', async fetchBatch({ cursor }) { return { items: [], nextCursor: cursor, exhausted: false }; } };
  assert.equal((await collectFromSource(stuck, { batchSize: 5, maxItems: 5 })).stopReason, 'no_progress');
  await assert.rejects(() => collectFromSource(numberedSource(50, { pageOverride: 20 }), { batchSize: 5, maxItems: 100 }), error => error instanceof SourceError && error.code === 'invalid_response');
});

test('an empty batch that moves the cursor (a client-side filter dropped everything) is not the end', async () => {
  const pages = [{ items: [], nextCursor: 'a', exhausted: false }, { items: [{ externalId: '1', sourceUrl: 'https://example.test/1', fetchedAt: 'x', raw: 1 }], nextCursor: null, exhausted: true }];
  const source = { id: 'f', kind: 'feed', async fetchBatch() { return pages.shift(); } };
  const result = await collectFromSource(source, { batchSize: 5, maxItems: 5 });
  assert.equal(result.items.length, 1);
  assert.equal(result.stopReason, 'exhausted');
});

test('SourceError carries a stable code and whether a retry may help', () => {
  const error = new SourceError('down', 'http', true, 503);
  assert.equal(error.code, 'http');
  assert.equal(error.retryable, true);
  assert.equal(error.status, 503);
  assert.ok(error instanceof Error);
});
