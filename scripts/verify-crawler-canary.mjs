// Explicit live check of a crawl engine on a deployed environment; never executed by unit tests.
// It is NOT part of the ordinary deployment smoke test: it depends on one external page (by default
// https://example.com/) and is meant for a deliberate engine canary, e.g. the deploy workflow run with
// crawler_engine=crawlee. Usage:
//   node scripts/verify-crawler-canary.mjs <service-url> <expected-engine> [probe-url]
// It registers a throwaway test account, runs one website discovery on the probe page and requires
// the crawl to have actually fetched something: crawlerEngine as expected, pagesVisited >= 1,
// requestsStarted >= 1 and a crawl status other than "failed". On failure it prints every crawler
// diagnostic the run recorded (phase, error, queue, runtime) and exits with 1.
import { randomUUID } from 'node:crypto';

const base = process.argv[2]?.replace(/\/$/, '');
const expectedEngine = process.argv[3];
const probeUrl = process.argv[4] ?? 'https://example.com/';
if (!base || !/^https:\/\/discovery-platform-web[-\w.]+\.run\.app$/.test(base)) throw new Error('Provide the Discovery Platform test service URL.');
if (!['legacy', 'crawlee'].includes(expectedEngine ?? '')) throw new Error('Provide the expected engine: legacy or crawlee.');

let cookie = '';
async function request(path, body) {
  const response = await fetch(`${base}/api/v1${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response.json();
}

await request('/health');
const account = await request('/auth/register', { email: `crawler-canary-${randomUUID()}@example.com`, password: randomUUID() + randomUUID() });
const project = await request('/projects', { workspaceId: account.workspace.id, name: `Crawler canary (${expectedEngine})`, domain: 'vacancies' });
const run = await request(`/projects/${project.id}/runs`, { sourceUrl: probeUrl, runConfig: { targetRecords: 5, searchBreadth: 'standard' } });
const stats = run.stats ?? {};

const checks = [
  ['crawlerEngine', stats.crawlerEngine === expectedEngine, `${stats.crawlerEngine} (expected ${expectedEngine})`],
  ['pagesVisited >= 1', stats.pagesVisited >= 1, stats.pagesVisited],
  ['requestsStarted >= 1', stats.requestsStarted >= 1, stats.requestsStarted],
  ['crawlStatus is not failed', stats.crawlStatus !== 'failed', stats.crawlStatus],
  ['run status is not failed', run.status !== 'failed', run.status],
];
for (const [name, ok, value] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${value}`);

if (checks.some(([, ok]) => !ok)) {
  const diagnostics = Object.fromEntries(Object.entries(stats).filter(([key]) => /^crawler|^crawlError$|^requests|^maxConcurrency|^queueRemaining$|^stopReason$|^crawlStatus$/.test(key)));
  console.log('\nRecorded crawler diagnostics:\n' + JSON.stringify({ runStatus: run.status, runError: run.error, ...diagnostics }, null, 2));
  process.exit(1);
}
console.log(`Crawler canary passed: ${expectedEngine} fetched ${stats.pagesVisited} page(s) from ${probeUrl}`);
