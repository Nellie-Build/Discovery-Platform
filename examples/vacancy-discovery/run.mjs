#!/usr/bin/env node
// Usage: node run.mjs https://example.com
import { crawlVacancies } from './crawl-vacancies.mjs';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node run.mjs <https://example.com>');
  process.exitCode = 1;
} else {
  const result = await crawlVacancies(url);
  console.log(JSON.stringify(result, null, 2));
}
