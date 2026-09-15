import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicAddress, fetchPublicUrl } from '../dist/crawler/http.js';

/**
 * The crawler's core SSRF defense: `fetchPublicUrl` resolves the target hostname, refuses to
 * even open a socket unless every resolved address is a genuine public unicast address, and
 * pins the exact address it validated for the actual connection (no DNS-rebinding window between
 * the check and the request) — see http.ts's own doc comments. This becomes load-bearing the
 * moment the system is reachable from the public internet (fase 2.3): a logged-in user supplies
 * an arbitrary "source URL" for a Discovery run, so this is the one thing standing between that
 * and an attacker probing localhost, the private network, or a cloud metadata endpoint.
 *
 * Every case below uses a literal IP address, never a hostname that needs a real DNS lookup —
 * Node resolves an IP literal locally with no network I/O, so these tests are fast and
 * deterministic and never depend on live network access, consistent with the rest of this
 * package's test suite.
 */

test('isPublicAddress accepts ordinary public IPv4/IPv6 unicast addresses', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
});

test('isPublicAddress rejects loopback (localhost)', () => {
  assert.equal(isPublicAddress('127.0.0.1'), false);
  assert.equal(isPublicAddress('127.0.0.53'), false);
  assert.equal(isPublicAddress('::1'), false);
});

test('isPublicAddress rejects every RFC1918 private range', () => {
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('172.16.0.1'), false);
  assert.equal(isPublicAddress('172.31.255.255'), false);
  assert.equal(isPublicAddress('192.168.1.1'), false);
});

test('isPublicAddress rejects link-local addresses, including the cloud metadata endpoint', () => {
  // 169.254.169.254 is the well-known instance-metadata address on GCP, AWS and Azure alike —
  // reaching it from inside the crawler would leak the runtime's own cloud credentials.
  assert.equal(isPublicAddress('169.254.169.254'), false);
  assert.equal(isPublicAddress('169.254.1.1'), false);
  assert.equal(isPublicAddress('fe80::1'), false);
});

test('isPublicAddress rejects IPv6 unique-local addresses (the IPv6 equivalent of RFC1918)', () => {
  assert.equal(isPublicAddress('fc00::1'), false);
  assert.equal(isPublicAddress('fd12:3456:789a::1'), false);
});

test('isPublicAddress rejects unspecified/reserved/multicast/broadcast addresses', () => {
  assert.equal(isPublicAddress('0.0.0.0'), false);
  assert.equal(isPublicAddress('255.255.255.255'), false);
  assert.equal(isPublicAddress('224.0.0.1'), false);
  assert.equal(isPublicAddress('::'), false);
});

test('isPublicAddress rejects an IPv4-mapped IPv6 address whose embedded IPv4 is private (no mapping bypass)', () => {
  assert.equal(isPublicAddress('::ffff:10.0.0.1'), false);
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
});

test('isPublicAddress rejects garbage input rather than throwing', () => {
  assert.equal(isPublicAddress('not-an-ip'), false);
  assert.equal(isPublicAddress(''), false);
});

test('fetchPublicUrl refuses a literal loopback URL before making any request', async () => {
  // IPv4 loopback only here — some CI runners (GitHub-hosted Ubuntu included) have no IPv6
  // route at all, so resolving the literal "::1" fails with a raw ENOTFOUND before
  // isPublicAddress ever runs, rather than through our own rejection. That's still a safe
  // outcome (no request is ever made either way) but not a portable thing to assert on; ::1's
  // rejection is already exercised, DNS-free, by isPublicAddress('::1') above.
  await assert.rejects(() => fetchPublicUrl('http://127.0.0.1/', 'test-agent'), /publiek netwerkadres/i);
});

test('fetchPublicUrl refuses a literal private RFC1918 URL before making any request', async () => {
  await assert.rejects(() => fetchPublicUrl('http://10.0.0.5/internal', 'test-agent'), /publiek netwerkadres/i);
  await assert.rejects(() => fetchPublicUrl('http://192.168.1.1/', 'test-agent'), /publiek netwerkadres/i);
});

test('fetchPublicUrl refuses the cloud metadata endpoint before making any request', async () => {
  await assert.rejects(
    () => fetchPublicUrl('http://169.254.169.254/computeMetadata/v1/', 'test-agent'),
    /publiek netwerkadres/i,
  );
});
