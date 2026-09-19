// Explicit live integration check, never imported by unit tests. Creates isolated test projects
// so onlyNewRecords remains enabled without earlier targets consuming later targets' records.
// Usage: node scripts/verify-adaptive-discovery.mjs <Discovery Platform service URL> [output.json]
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const base = process.argv[2]?.replace(/\/$/, '');
if (!base || !/^https:\/\/discovery-platform-web[-\w.]+\.run\.app$/.test(base)) throw new Error('Provide the Discovery Platform Cloud Run URL.');
let cookie = '';
async function request(path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(290_000),
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
await request('/health');
const account = await request('/auth/register', { email: `adaptive-verification-${randomUUID()}@example.com`, password: randomUUID() + randomUUID() });
const results = [];
for (const [site, sourceUrl, targetRecords] of [
  ['WBO', 'https://www.werkenbijdeoverheid.nl/', 10],
  ['WBO', 'https://www.werkenbijdeoverheid.nl/', 50],
  ['WBO', 'https://www.werkenbijdeoverheid.nl/', 100],
  ['SPIE', 'https://www.werkenbijspie.nl/vacatures', 10],
]) {
  const project = await request('/projects', { workspaceId: account.workspace.id, name: `Adaptive verification ${site} ${targetRecords}`, domain: 'vacancies' });
  console.log(`Starting ${site} target=${targetRecords} in Standard mode`);
  const run = await request(`/projects/${project.id}/runs`, { sourceUrl, runConfig: { targetRecords, searchBreadth: 'standard' } });
  const fields = ['budgetSource', 'maxPages', 'maxCandidates', 'maxDurationMs', 'urlsDiscovered', 'uniqueUrlsDiscovered', 'candidateUrlsFound', 'sitemapUrlsFound', 'listingUrlsFound', 'candidatesProcessed', 'pagesVisited', 'recordsAccepted', 'duplicates', 'durationMs', 'stopReason'];
  const result = { site, sourceUrl, targetRecords, runId: run.id, status: run.status, ...Object.fromEntries(fields.map(key => [key, run.stats?.[key]])) };
  results.push(result);
  console.log(JSON.stringify(result));
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify({ verifiedAt: new Date().toISOString(), service: base, baseline: { site: 'WBO', targetRecords: 50, pagesVisited: 102, recordsAccepted: 50 }, results }, null, 2) + '\n');
  if (result.budgetSource !== 'adaptive') throw new Error('Deployment does not report adaptive budgets.');
}
