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

## Crawlee and Playwright (Apache-2.0) — reserved, not yet installed

Fase 2 of this modernization (introducing Crawlee as the crawler engine, with Playwright as an
opt-in fallback for JS-rendered pages) has not been implemented yet — see the project's own
architecture decisions for why it was deliberately deferred. This section is a placeholder for
their Apache-2.0 NOTICE text once that phase actually lands; it is not filled in prematurely for
a dependency that isn't installed.

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
