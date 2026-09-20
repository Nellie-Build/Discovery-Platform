# Third-party notices

Discovery Platform is built on volwassen, permissief gelicentieerde open-source software rather
than herbouwen wat al goed bestaat. This file lists every third-party package whose license
requires a notice, and documents deliberate licensing decisions made along the way.

## ts-jobspy (MIT)

Used by: `domains/vacancies` (`domains/vacancies/src/sources/jobspy-source.ts`) — the job-board
source provider (Indeed, LinkedIn) behind `TsJobSpySourceProvider`. Installed as an ordinary npm
dependency, never vendored/copied into this repository.

```
MIT License

TypeScript rewrite (ts-jobspy):
Copyright (c) 2025-2026 Alpha Romer Coma (alpharomercoma@proton.me)

Original python-jobspy:
Copyright (c) 2023 Cullen Watson, Zachary Hampton

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Crawlee (Apache-2.0)

Used by: `packages/discovery-core` (`src/crawler/crawlee-crawler.ts`) — the opt-in `crawlee` crawl
engine (request queue, retries, concurrency). Installed as an ordinary npm dependency, never
vendored/copied into this repository; it is only loaded when the `crawlee` engine is selected
(`DISCOVERY_CRAWLER_ENGINE=crawlee`), and the default engine does not use it.

Only `@crawlee/basic` is a direct dependency (exact version 3.18.1). It brings in `@crawlee/core`,
`@crawlee/memory-storage`, `@crawlee/types` and `@crawlee/utils` (all Apache-2.0), plus 14
Apache-2.0 packages in total (among them the `@apify/*` utilities, `got-scraping`,
`header-generator` and `generative-bayesian-network`) and MIT/BSD/ISC/CC0/BlueOak-licensed helpers.
Every one of the 103 packages this added is permissive; none is GPL/AGPL/LGPL. No browser
dependency is installed: `@crawlee/playwright`, `@crawlee/puppeteer`, `playwright` and `puppeteer`
are not part of the dependency tree.

```
Copyright 2018 Apify Technologies s.r.o.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The full license text ships with each package (`node_modules/@crawlee/*/LICENSE.md`).

## Playwright — reserved, not installed

Playwright as an opt-in fallback for JS-rendered pages is a later phase and is not installed. This
section is a placeholder for its Apache-2.0 notice once that phase lands.

## Deliberately NOT used: idcac-playwright (GPL-3.0-only)

`@crawlee/playwright` (once introduced) lists `idcac-playwright` ("I Don't Care About Cookies"
for Playwright/Puppeteer, an automatic cookie-consent-banner dismisser) as an **optional** peer
dependency — Crawlee itself does not install it by default, specifically because of its license.
`idcac-playwright` is **GPL-3.0-only**, which does not meet this project's permissive-license-only
policy. Discovery Platform will never install this package; any future Playwright-based crawling
simply does without automatic cookie-banner dismissal. This is a deliberate exclusion, not an
oversight — recorded here so the decision doesn't need re-litigating later.

## License policy

- Only permissive licenses (MIT, Apache-2.0, BSD, ISC, and similar) are used for dependencies.
- No AGPL code. No copyleft (GPL/LGPL) code, including transitively — see the idcac-playwright
  exclusion above for a concrete example of enforcing this.
- No code is ever copied from another project's own source (Firecrawl, JobSpy, Crawlee, or
  anything else) into this repository — every third-party capability is consumed as an ordinary
  npm dependency, kept up to date via normal version bumps, never forked/vendored.
