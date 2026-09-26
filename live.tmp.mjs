import { readFileSync, writeFileSync } from 'node:fs';
import { interpretDescription } from '@discovery-platform/domain-companies';
const [, project] = readFileSync('E:/Discovery-Cache/companies-ids.txt', 'utf8').trim().split(' ');
const A = 'http://127.0.0.1:3002/api/v1';
const H = { Origin: 'http://localhost:5173', 'content-type': 'application/json' };
const description = 'bouwbedrijven gespecialiseerd in renovatie van scholen';
const c = interpretDescription(description).criteria;
const filters = { ...c, description, maxQueries: 2, maxCompanies: 3, pagesPerCompany: 4 };
for (const key of Object.keys(filters)) if (filters[key] === null || (Array.isArray(filters[key]) && !filters[key].length)) delete filters[key];
const post = body => fetch(`${A}/projects/${project}/runs`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(r => r.json());
const first = await post({ sourceId: 'search', filters, runConfig: { targetRecords: 3 } });
const second = first.stats?.continuation ? await post({ continueFromRunId: first.id }) : null;
const out = [];
for (const run of [first, second].filter(Boolean)) {
  const records = await (await fetch(`${A}/projects/${project}/records?runId=${run.id}`, { headers: H })).json();
  out.push({ run, records });
}
writeFileSync('E:/Discovery-Cache/live-quality.json', JSON.stringify(out, null, 1));
for (const { run, records } of out) {
  const s = run.stats;
  console.log(`\n== batch ${s.batch ?? 1} ${run.status} new=${run.recordsCreated} upd=${s.recordsUpdated} unch=${s.duplicatesUnchanged} queries=${(s.queries || []).length} candidates=${s.companyCandidates} researched=${s.companiesResearched} waiting=${s.candidatesNotResearched} failed=${JSON.stringify(s.sitesFailed)}`);
  for (const r of records) {
    const d = r.domain_data; const m = d.search?.matches.find(x => x.kind === 'specialisation');
    console.log(`  * ${d.search?.status} | ${r.display_name} | ${d.domain} | types: ${(d.businessTypes || []).map(t => t.type + ':' + t.strength).join(',') || '-'} | school: ${m?.status} ${m?.found ?? ''} ${m?.note ?? ''}`);
  }
}
