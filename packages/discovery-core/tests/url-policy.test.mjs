import assert from 'node:assert/strict';
import { test } from 'node:test';
import { websiteScope, linkPriority } from '../dist/crawler/url-policy.js';

test('websiteScope derives the homepage and bare domain, rejecting non-HTTP(S) input', () => {
  const scope = websiteScope('www.Example.com/rooms?x=1#top');
  assert.equal(scope.homepage, 'https://www.example.com/');
  assert.equal(scope.domain, 'example.com');
  assert.throws(() => websiteScope('ftp://example.com'), /HTTP\(S\)/);
  assert.throws(() => websiteScope('https://user:pass@example.com'), /HTTP\(S\)/);
  assert.throws(() => websiteScope('http://localhost'), /publiek websitedomein/);
});

test('normalize keeps only same-domain, same-port HTTP(S) links and strips tracking noise', () => {
  const scope = websiteScope('https://example.com');
  assert.equal(scope.normalize('/contact', scope.homepage), 'https://example.com/contact');
  assert.equal(scope.normalize('https://www.example.com/about', scope.homepage), 'https://www.example.com/about');
  assert.equal(scope.normalize('https://other.com/contact', scope.homepage), null);
  assert.equal(scope.normalize('https://example.com:8443/contact', scope.homepage), null);
  assert.equal(scope.normalize('mailto:info@example.com', scope.homepage), null);
  assert.equal(scope.normalize('/rooms?utm_source=fb&fbclid=1&lang=nl#photos', scope.homepage), 'https://example.com/rooms?lang=nl');
  assert.equal(scope.normalize('/brochure.pdf', scope.homepage), null);
  assert.equal(scope.normalize('/brochure.pdf', scope.homepage, false), 'https://example.com/brochure.pdf');
});

test('linkPriority favors contact, about, reservation, then facilities/tariffs/gallery/faq — no domain-specific category baked in', () => {
  const url = path => `https://example.com${path}`;
  for (const path of ['/contact', '/contact-us', '/contactez-nous']) assert.equal(linkPriority(url(path)), 0);
  for (const path of ['/about', '/a-propos']) assert.equal(linkPriority(url(path)), 1);
  for (const path of ['/reservation', '/booking']) assert.equal(linkPriority(url(path)), 2);
  for (const path of ['/facilities', '/amenities', '/services', '/voorzieningen']) assert.equal(linkPriority(url(path)), 4);
  for (const path of ['/tarifs', '/prices', '/rates', '/prijzen']) assert.equal(linkPriority(url(path)), 5);
  for (const path of ['/gallery', '/galerie', '/photos']) assert.equal(linkPriority(url(path)), 6);
  for (const path of ['/faq', '/conditions', '/house-rules', '/huisregels']) assert.equal(linkPriority(url(path)), 7);
  // No category exists in this package for "room"/"apartment"-like pages — a page that would
  // matter to an accommodation domain is just as unremarkable to this package as any other.
  assert.equal(linkPriority(url('/rooms')), 10);
  assert.equal(linkPriority(url('/blog/some-post')), 10);
  assert.equal(linkPriority(url('/fr/page-2'), 'Contactez-nous'), 0);
  assert.equal(linkPriority(url('/fr/page-3'), 'À propos'), 1);
});

test('extraTiers lets a caller splice in its own page category, at whatever priority it chooses, without this package ever defining it', () => {
  const url = path => `https://example.com${path}`;
  const jobListingTier = { pattern: /vacature|vacancy|jobs?/, priority: 3 };
  for (const path of ['/vacatures', '/jobs', '/vacancy-list']) {
    assert.equal(linkPriority(url(path), '', [jobListingTier]), 3);
  }
  // Without the extra tier, the same URL is unremarkable.
  assert.equal(linkPriority(url('/vacatures')), 10);
  // The extra tier is checked ahead of the built-in "facilities" tier (4) and behind the three
  // universal tiers that precede it (contact/about/reservation).
  assert.equal(linkPriority(url('/contact-vacatures'), '', [jobListingTier]), 0);
});
