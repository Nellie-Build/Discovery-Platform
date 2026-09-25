// Browser-only fixtures: all API traffic is intercepted. No database or search run is used.
// UI_TEST_TOOLS may point to an isolated directory containing node_modules/playwright.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(
  process.env.UI_TEST_TOOLS
    ? pathToFileURL(resolve(process.env.UI_TEST_TOOLS, 'node_modules/playwright/index.mjs')).href
    : 'playwright'
);
const out = resolve('apps/web/review');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'nl-NL' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const now = new Date().toISOString();
const modules = ['vacancies', 'tenders', 'companies'].map((id) => ({
  module_id: id,
  module_name: id[0].toUpperCase() + id.slice(1),
  enabled: true,
}));
const projects = [
  { id: 'p1', name: 'Video & communicatie', domain: 'tenders' },
  { id: 'p2', name: 'Marketing & communicatie — Nederland', domain: 'vacancies' },
  { id: 'p3', name: 'Zakelijke dienstverlening', domain: 'companies' },
].map((project) => ({
  ...project,
  workspace_id: 'w1',
  status: 'active',
  config: {},
  created_at: now,
  updated_at: now,
  deleted_at: null,
  deleted_by: null,
}));
const titles = [
  'Audiovisuele apparatuur raadzaal Leerdam',
  'Campagneontwikkeling en mediastrategie',
  'Audiovisuele middelen en Narrowcasting',
];
const numbers = ['643394-2026', '654717-2026', '655158-2026'];
const records = numbers.flatMap((number, index) =>
  ['tenderned', 'ted'].map((source) => {
    const id = `${source}-${index}`;
    const publicationId = source === 'ted' ? number : String(440454 + index);
    const sourceUrl =
      source === 'ted'
        ? `https://ted.europa.eu/nl/notice/-/detail/${number}`
        : `https://www.tenderned.nl/aankondigingen/overzicht/${publicationId}`;
    return {
      id,
      project_id: 'p1',
      domain: 'tenders',
      display_name: titles[index],
      status: 'new',
      score: 85,
      classification: {},
      created_at: now,
      updated_at: now,
      domain_data: {
        title: titles[index],
        sourceSystem: source,
        tenderIdentity: id,
        publicationId,
        sourceUrl,
        contractingAuthority: index === 0 ? 'Gemeente Vijfheerenlanden' : 'Publieke opdrachtgever',
        submissionDeadline: source === 'ted' ? null : '2026-10-22T23:59:00',
        procedureType: 'Openbaar',
        noticeType: 'cn-standard',
        noticeTypeLabel: 'Aankondiging opdracht',
        location: 'Nederland',
        cpvCodes: [{ code: '92111000', description: 'Productie van films en video’s', main: true }],
        nutsCodes: [],
        publications: [
          {
            publicationId,
            tedPublicationNumber: source === 'tenderned' ? number : undefined,
            sourceUrl,
            publicationDate: '2026-09-24',
          },
        ],
      },
    };
  }),
);
const runs = projects.map((project, index) => ({
  id: `run-${index}`,
  project_id: project.id,
  status: ['succeeded', 'partial', 'failed'][index],
  started_at: now,
  completed_at: now,
  created_at: now,
  error: null,
  stats: { recordsCreated: index === 0 ? 6 : 0, recordsUpdated: index === 0 ? 2 : 0 },
}));
const requested = [];
await page.route('**/api/v1/**', async (route) => {
  const request = route.request();
  assert.equal(request.method(), 'GET', 'The browser review must not mutate data or start runs');
  const url = new URL(request.url());
  const path = url.pathname.replace('/api/v1', '');
  requested.push(path + url.search);
  let data;
  if (path === '/auth/me')
    data = { id: 'review', email: 'review@example.test', is_admin: false, created_at: now, updated_at: now };
  else if (path === '/workspaces')
    data = [
      { id: 'w1', name: 'Review workspace · testgegevens', role: 'owner' },
      { id: 'w2', name: 'Alleen Tenders · testgegevens', role: 'member' },
    ];
  else if (path === '/workspaces/w1/modules') data = modules;
  else if (path === '/workspaces/w2/modules')
    data = modules.map((module) => ({ ...module, enabled: module.module_id === 'tenders' }));
  else if (path === '/projects') data = url.searchParams.get('workspaceId') === 'w2' ? [] : projects;
  else if (/^\/projects\/[^/]+\/records$/.test(path)) data = path.includes('/p1/') ? records : [];
  else if (/^\/projects\/[^/]+\/runs$/.test(path)) data = runs.filter((run) => path.includes(`/${run.project_id}/`));
  else if (/^\/projects\/[^/]+$/.test(path)) data = projects.find((project) => path.endsWith(`/${project.id}`));
  else if (/^\/records\/[^/]+$/.test(path))
    data = { ...records.find((record) => path.endsWith(`/${record.id}`)), sources: [], contacts: [] };
  else throw new Error(`Unexpected API request: ${path}`);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
});
const noOverflow = async () => {
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 10)
      .map((el) => ({ tag: el.tagName, className: el.getAttribute('class'), width: el.getBoundingClientRect().width })),
  }));
  if (overflow.scroll > overflow.width + 1) console.log(JSON.stringify(overflow, null, 2));
  assert.ok(overflow.scroll <= overflow.width + 1, 'Page must not overflow horizontally');
};
try {
  await page.goto(process.env.UI_PREVIEW_URL ?? 'http://127.0.0.1:5174');
  await page.getByRole('heading', { name: 'Welkom bij Discovery Platform' }).waitFor();
  await noOverflow();
  await page.screenshot({ path: `${out}/dashboard-desktop.png`, fullPage: true });
  assert.equal(await page.getByText('2 gekoppelde bronrecords', { exact: false }).count(), 3);
  await page.getByRole('link', { name: 'Open Tenders', exact: true }).click();
  await page.getByRole('heading', { name: 'Tenders', exact: true }).waitFor();
  assert.equal(await page.getByText('Marketing & communicatie — Nederland', { exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Video & communicatie', exact: false }).click();
  await page.getByRole('heading', { name: 'Video & communicatie', exact: true }).waitFor();
  await page.getByText('TenderNed + TED', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('TenderNed + TED', { exact: true }).count(), 3);
  await noOverflow();
  await page.screenshot({ path: `${out}/tender-results-desktop.png`, fullPage: true });
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('heading', { name: 'Welkom bij Discovery Platform' }).waitFor();
  await page.setViewportSize({ width: 768, height: 1024 });
  await noOverflow();
  await page.screenshot({ path: `${out}/dashboard-tablet.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: `${out}/dashboard-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Navigatie openen' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigatie', exact: true });
  await drawer.waitFor();
  await page.screenshot({ path: `${out}/navigation-mobile.png` });
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(
    await page.getByRole('button', { name: 'Navigatie openen' }).evaluate((el) => document.activeElement === el),
    true,
  );
  await page.getByRole('button', { name: 'Navigatie openen' }).click();
  await drawer.getByLabel('Current workspace').selectOption('w2');
  await drawer.waitFor({ state: 'hidden' });
  await page.getByText('Ruimte voor je eerste project', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open Companies', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Open Vacancies', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Open Tenders', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Nieuw project', exact: true }).click();
  const projectDialog = page.getByRole('dialog', { name: 'New project' });
  await projectDialog.waitFor();
  assert.equal(await projectDialog.getByLabel('Domain').inputValue(), 'tenders');
  await page.keyboard.press('Escape');
  await projectDialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        viewports: ['1440×1100', '768×1024', '390×844'],
        screenshots: out,
        apiMode: 'intercepted test fixtures only',
        apiRequests: requested.length,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
