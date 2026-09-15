import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'cheerio';
import { extractContacts, mergeContacts } from '../dist/extract/contacts.js';

// Deliberately generic (non-Moroccan) normalizers, to prove the extraction mechanics work for
// any domain/region a caller supplies — this package itself has no numbering-plan knowledge.
const normalizePhone = raw => {
  const digits = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{8,15}$/.test(digits)) return '+' + digits;
  return null;
};
const normalizeEmail = raw => {
  const email = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
};
const normalizers = { normalizePhone, normalizeEmail };
const extract = (html, domain) => extractContacts(load(html), domain, normalizers);

test('extracts and normalizes mailto: and tel: links', () => {
  const html = `<html><body>
    <a href="mailto:Info@Test-Business.COM">Email us</a>
    <a href="tel:+1 555 123 4567">Call us</a>
  </body></html>`;
  const result = extract(html, 'test-business.com');
  assert.equal(result.email, 'info@test-business.com');
  assert.equal(result.phone, '+15551234567');
});

test('normalizes a bare-digit number (no leading +) from a tel: link, via the injected normalizer', () => {
  const html = '<html><body><a href="tel:15551234567">Call</a></body></html>';
  assert.equal(extract(html, 'example.com').phone, '+15551234567');
});

test('recognizes wa.me, api.whatsapp.com and whatsapp:// deep links as WhatsApp numbers', () => {
  for (const href of [
    'https://wa.me/15551234567',
    'https://wa.me/15551234567?text=Hallo',
    'https://api.whatsapp.com/send?phone=15551234567&text=Hi',
    'whatsapp://send?phone=15551234567',
  ]) {
    const html = `<html><body><a href="${href}">WhatsApp</a></body></html>`;
    assert.equal(extract(html, 'example.com').whatsapp, '+15551234567', href);
  }
});

test('recognizes Instagram and Facebook profile links while ignoring share/utility paths', () => {
  const html = `<html><body>
    <a href="https://www.instagram.com/some_business/">Instagram</a>
    <a href="https://www.facebook.com/SomeBusinessPage">Facebook</a>
    <a href="https://www.instagram.com/explore/tags/x/">Tag</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=https://example.com">Share</a>
  </body></html>`;
  const result = extract(html, 'example.com');
  assert.equal(result.instagram, 'https://instagram.com/some_business');
  assert.equal(result.facebook, 'https://facebook.com/SomeBusinessPage');
});

test('falls back to plain-text scanning when there is no mailto:/tel: link', () => {
  const html = '<html><body><p>Reach us at info@test-business.com or call 15551234567.</p></body></html>';
  const result = extract(html, 'test-business.com');
  assert.equal(result.email, 'info@test-business.com');
  assert.equal(result.phone, '+15551234567');
});

test('ignores obvious placeholder/template emails', () => {
  const html = '<html><body><a href="mailto:info@example.com">Email</a></body></html>';
  assert.equal(extract(html, 'somesite.com').email, null);
});

test("prefers an email on the site's own domain over an unrelated one", () => {
  const html = `<html><body>
    <a href="mailto:webmaster@somehostingcompany.com">Hosting</a>
    <a href="mailto:info@somesite.com">Site</a>
  </body></html>`;
  assert.equal(extract(html, 'somesite.com').email, 'info@somesite.com');
});

test('ignores emails and phone-like numbers embedded in script content', () => {
  const html = `<html><head></head><body>
    <script>var trackingId = "15551234567"; var fake = "noreply@analytics-vendor.example";</script>
    <a href="mailto:info@somesite.com">Email</a>
  </body></html>`;
  const result = extract(html, 'somesite.com');
  assert.equal(result.email, 'info@somesite.com');
  assert.equal(result.phone, null);
});

test('a page with no contact details returns all nulls', () => {
  const html = '<html><body><p>Welcome to our site.</p></body></html>';
  assert.deepEqual(extract(html, 'example.com'), { email: null, phone: null, whatsapp: null, instagram: null, facebook: null });
});

test('mergeContacts prefers the contact page over the homepage for the same field', () => {
  const merged = mergeContacts([
    { url: 'https://example.com/', contacts: { email: 'home@example.com', phone: null, whatsapp: null, instagram: null, facebook: null } },
    { url: 'https://example.com/contact', contacts: { email: 'contact@example.com', phone: '+15551234567', whatsapp: null, instagram: null, facebook: null } },
  ]);
  assert.equal(merged.email, 'contact@example.com');
  assert.equal(merged.phone, '+15551234567');
});

test('mergeContacts falls back to any page with a value when no priority page has one', () => {
  const merged = mergeContacts([
    { url: 'https://example.com/', contacts: { email: null, phone: null, whatsapp: null, instagram: 'https://instagram.com/x', facebook: null } },
    { url: 'https://example.com/gallery', contacts: { email: null, phone: null, whatsapp: null, instagram: null, facebook: null } },
  ]);
  assert.equal(merged.instagram, 'https://instagram.com/x');
});
