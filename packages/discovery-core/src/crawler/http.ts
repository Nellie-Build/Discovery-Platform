import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export type HttpTransport = (url: string, userAgent: string) => Promise<HttpResult>;

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch { return false; }
}

/** One GET only: no redirects, retries, cookies, proxy, or browser subrequests. */
export const fetchPublicUrl: HttpTransport = async (input, userAgent) => {
  const url = new URL(input);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error('Niet-publiek netwerkadres geweigerd.');
  }
  const pinned = addresses[0];
  return new Promise<HttpResult>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.8', 'accept-encoding': 'identity' },
      // Pin the validated address to avoid resolving a different address at connect time.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
      agent: false,
    }, response => {
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value ?? '']));
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          response.destroy(new Error('Response groter dan 2 MiB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('HTTP-response afgebroken.')));
    });
    const timer = setTimeout(() => request.destroy(new Error('HTTP-timeout na 20 seconden.')), 20_000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
};
