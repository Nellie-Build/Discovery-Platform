// Explicit live check; never executed by unit tests. No credentials are printed or persisted.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const base = process.argv[2]?.replace(/\/$/, '');
if (!base || !/^https:\/\/discovery-platform-web[-\w.]+\.run\.app$/.test(base)) throw new Error('Provide the Discovery Platform test service URL.');
const output = process.argv[3] ?? 'branch-quality-live.json';
let cookie = '';
async function request(path, body) {
  const response = await fetch(`${base}/api/v1${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(290_000) });
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response.json();
}
await request('/health');
const account = await request('/auth/register', { email: `branch-verification-${randomUUID()}@example.com`, password: randomUUID() + randomUUID() });
const project = await request('/projects', { workspaceId: account.workspace.id, name: 'Security Agencies — branch verification', domain: 'vacancies' });
const results = [];
for (const criteria of [{ branch: 'Security', keywords: 'security officer beveiliging' }, { branch: 'Onderwijs' }]) {
  const input = { ...criteria, region: 'Nederland', runConfig: { targetRecords: 50, searchBreadth: 'standard' }, filters: {} };
  console.log(`Starting ${criteria.branch}, target=50`);
  const run = await request(`/projects/${project.id}/runs`, input);
  const records = await request(`/projects/${project.id}/records?runId=${run.id}`);
  const result = { input, runId: run.id, status: run.status, stats: run.stats,
    records: records.map(record => ({ id: record.id, title: record.display_name, company: record.domain_data.company,
      location: record.domain_data.location, description: record.domain_data.description, sourceUrl: record.domain_data.sourceUrl,
      relevance: record.classification.relevance, manualReview: null })) };
  results.push(result);
  await writeFile(output, JSON.stringify({ service: base, projectId: project.id, verifiedAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log(JSON.stringify({ branch: criteria.branch, status: run.status, stopReason: run.stats.stopReason, accepted: run.stats.recordsAccepted, sources: run.stats.sources }));
  if (!run.stats.criteria || typeof run.stats.sourcesSucceeded !== 'number') throw new Error('This deployment does not include branch quality diagnostics.');
}
// Manual classification of at least 20 Security records follows separately; this script never
// labels results automatically or changes relevance rules based on its output.
