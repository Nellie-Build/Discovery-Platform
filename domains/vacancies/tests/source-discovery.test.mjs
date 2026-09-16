import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBranchSearchQuery } from '../dist/source-discovery.js';

test('a branch alone builds a query with the fixed generic hints plus the branch, in order', () => {
  assert.equal(buildBranchSearchQuery({ branch: 'Security' }), 'vacature vacatures jobs Security');
});

test('region is appended after keywords, only when given', () => {
  assert.equal(
    buildBranchSearchQuery({ branch: 'Security', region: 'Nederland', keywords: 'beveiliger security officer' }),
    'vacature vacatures jobs Security beveiliger security officer Nederland',
  );
});

test('region is optional — omitted entirely from the query when not given', () => {
  assert.equal(
    buildBranchSearchQuery({ branch: 'Security', keywords: 'beveiliger security officer' }),
    'vacature vacatures jobs Security beveiliger security officer',
  );
});

test('keywords are optional — omitted entirely from the query when not given', () => {
  assert.equal(buildBranchSearchQuery({ branch: 'Security', region: 'Zuid-Holland' }), 'vacature vacatures jobs Security Zuid-Holland');
});

test('an empty/whitespace-only region or keywords is treated the same as omitted, never producing a trailing blank term', () => {
  assert.equal(buildBranchSearchQuery({ branch: 'Security', region: '   ', keywords: '' }), 'vacature vacatures jobs Security');
});

test('the user\'s own branch/region/keywords text is preserved verbatim — never replaced or reworded with an invented synonym', () => {
  const query = buildBranchSearchQuery({ branch: 'Cyber Security & Compliance', region: 'Zuid-Holland', keywords: 'SOC analist' });
  assert.ok(query.includes('Cyber Security & Compliance'));
  assert.ok(query.includes('SOC analist'));
  assert.ok(query.includes('Zuid-Holland'));
});
