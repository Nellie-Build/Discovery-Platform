#!/usr/bin/env node
// Usage: node run.mjs https://example.com
import { crawlBasic } from './crawl-site.mjs';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node run.mjs <https://example.com>');
  process.exitCode = 1;
} else {
  const result = await crawlBasic(url);
  console.log(JSON.stringify(result, null, 2));
}
