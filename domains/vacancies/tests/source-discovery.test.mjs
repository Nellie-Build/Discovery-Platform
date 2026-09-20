import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBranchSearchQuery, buildJobBoardSearchTerm } from '../dist/source-discovery.js';

test('a branch alone builds a query with the fixed generic hints plus the branch, in order', () => {
  assert.equal(buildBranchSearchQuery({ branch: 'Security' }), 'Security');
});

test('region is appended after keywords, only when given', () => {
  assert.equal(
    buildBranchSearchQuery({ branch: 'Security', region: 'Nederland', keywords: 'beveiliger security officer' }),
    'Security beveiliger security officer Nederland',
  );
});

test('region is optional — omitted entirely from the query when not given', () => {
  assert.equal(
    buildBranchSearchQuery({ branch: 'Security', keywords: 'beveiliger security officer' }),
    'Security beveiliger security officer',
  );
});

test('keywords are optional — omitted entirely from the query when not given', () => {
  assert.equal(buildBranchSearchQuery({ branch: 'Security', region: 'Zuid-Holland' }), 'Security Zuid-Holland');
});

test('an empty/whitespace-only region or keywords is treated the same as omitted, never producing a trailing blank term', () => {
  assert.equal(buildBranchSearchQuery({ branch: 'Security', region: '   ', keywords: '' }), 'Security');
});

test('the user\'s own branch/region/keywords text is preserved verbatim — never replaced or reworded with an invented synonym', () => {
  const query = buildBranchSearchQuery({ branch: 'Cyber Security & Compliance', region: 'Zuid-Holland', keywords: 'SOC analist' });
  assert.ok(query.includes('Cyber Security & Compliance'));
  assert.ok(query.includes('SOC analist'));
  assert.ok(query.includes('Zuid-Holland'));
});

// ─── buildJobBoardSearchTerm — the job board never gets the web-search hints or region ─────────

test('the exact scenario from the brief: "Beveiliging" + "beveiliger security officer" becomes "Beveiliging beveiliger security officer" for the job board — branch first, then keywords, nothing else', () => {
  assert.equal(
    buildJobBoardSearchTerm({ branch: 'Beveiliging', keywords: 'beveiliger security officer' }),
    'Beveiliging beveiliger security officer',
  );
});

test('"Beveiliging" is never silently replaced by "Security" or any other synonym — the job board search term is exactly the user\'s own branch text', () => {
  const term = buildJobBoardSearchTerm({ branch: 'Beveiliging', keywords: null });
  assert.equal(term, 'Beveiliging');
  assert.ok(!term.includes('Security'));
});

test('the generic web-search discovery hints ("vacature", "vacatures", "jobs") never leak into the job board search term', () => {
  const term = buildJobBoardSearchTerm({ branch: 'Beveiliging', keywords: 'beveiliger security officer' });
  assert.ok(!term.includes('vacature'));
  assert.ok(!term.includes('vacatures'));
  // "jobs" itself must not appear as the fixed hint word either (distinct from it merely being
  // a substring of unrelated user-typed keywords, which never happens in this fixture).
  assert.ok(!term.split(' ').includes('jobs'));
});

test('region is never folded into the job board search term — it has its own dedicated location/country parameters instead (see sources/location.ts)', () => {
  const term = buildJobBoardSearchTerm({ branch: 'Beveiliging', keywords: 'beveiliger security officer' });
  assert.ok(!term.includes('Nederland'));
  assert.ok(!term.includes('Zuid-Holland'));
});

test('keywords are optional for the job board too', () => {
  assert.equal(buildJobBoardSearchTerm({ branch: 'Beveiliging' }), 'Beveiliging');
  assert.equal(buildJobBoardSearchTerm({ branch: 'Beveiliging', keywords: '' }), 'Beveiliging');
});
