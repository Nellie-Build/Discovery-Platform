# basic-discovery (example)

A minimal, generic consumer of `@discovery-platform/core` — proof that the core package can be
used by a program with no domain-specific knowledge at all: no accommodations, scoring, claims,
database, React or Firebase. **Documentation/test fixture only, not a real product** (see
`docs/architecture.md` at the repository root for the wider design).

## What it does

Takes one website URL, crawls it with the generic crawler (`crawlWebsite` from
`@discovery-platform/core`), and returns:

- each visited page's `<title>` and a short excerpt of its visible text;
- whatever contact details (e-mail/phone/WhatsApp/Instagram/Facebook) the crawl found anywhere
  on the site.

That's it — `crawl-site.mjs` is ~35 lines, all of it either calling the core's public API or
supplying the one thing the core deliberately never assumes on its own: how to recognize a
valid phone number/e-mail address for a given caller (see `genericContactNormalizers`, which is
deliberately simple and country-agnostic — a real domain module would supply its own, stricter
normalizers).

## What it deliberately does not use

No accommodation/property extraction, no lead scoring, no deduplication, no claim/invitation
mechanism, no database, no React, no Firebase. `tests/crawl-site.test.mjs` checks this
mechanically, not just by convention.

## Run it

```sh
npm install
npm run crawl -- https://example.com
npm test
```
