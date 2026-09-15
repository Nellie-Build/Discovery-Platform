# vacancy-discovery (example)

Wires `domains/vacancies` into `@discovery-platform/core`'s generic crawler: one website URL
in, `VacancyFacts[]` out. No database, no CMS, no deployment, no API server — documentation/test
purposes only, the vacancies counterpart to `examples/basic-discovery`.

```sh
npm install
npm run crawl -- https://example.com
npm test
```

`crawl-vacancies.mjs` is ~30 lines: it supplies its own generic (country-agnostic) contact
normalizers, then passes `domains/vacancies`' own `extractVacancy` and
`vacanciesCrawlerConfig.linkPriorityExtraTiers` straight through to `crawlWebsite`. No code is
shared with `examples/basic-discovery` beyond the core package itself — proving a second domain
plugs into the exact same crawler without touching the first domain's example at all.
