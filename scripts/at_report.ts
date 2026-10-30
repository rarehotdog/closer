// Builds docs/at_results.md from the single result file docs/at_results.json (written by
// tests/reporter.mjs). Run automatically at the end of `npm test`.
import { readFileSync, writeFileSync } from 'node:fs';

type R = { name: string; file: string; status: 'PASS' | 'FAIL' | 'SKIP'; reason: string };

const root = new URL('..', import.meta.url).pathname;
const { results } = JSON.parse(readFileSync(`${root}docs/at_results.json`, 'utf8')) as { results: R[] };

const at = results.filter((r) => /^AT-\d\d/.test(r.name));
const other = results.filter((r) => !/^AT-\d\d/.test(r.name));
const ARCHIVED = new Set(['AT-05', 'AT-24']);
const active = at.filter((r) => !ARCHIVED.has(r.name.slice(0, 5)));
const count = (xs: R[], s: R['status']) => xs.filter((r) => r.status === s).length;
const ids = new Set(active.map((r) => r.name.slice(0, 5)));

const lines: string[] = [];
lines.push('# Acceptance test results');
lines.push('');
lines.push('Generated from `docs/at_results.json` by `scripts/at_report.ts` (run by `npm test`). Mock mode only; zero real calls.');
lines.push('');
lines.push(`- Active AT ids present: ${ids.size} of 34 (AT-05 and AT-24 archived, numbers kept).`);
lines.push(`- AT test cases (variants counted separately): PASS ${count(active, 'PASS')} · FAIL ${count(active, 'FAIL')} · SKIP ${count(active, 'SKIP')} · total ${active.length}.`);
lines.push(`- Other tests (unit, fixture answer): PASS ${count(other, 'PASS')} · FAIL ${count(other, 'FAIL')} · SKIP ${count(other, 'SKIP')} · total ${other.length}.`);
lines.push('');
lines.push('| Test | Result | Note |');
lines.push('|---|---|---|');
for (const r of at) lines.push(`| ${r.name.replace(/\|/g, '/')} | ${r.status} | ${r.reason.replace(/\|/g, '/')} |`);
lines.push('');
lines.push('## Other tests');
lines.push('');
lines.push('| Test | Result | Note |');
lines.push('|---|---|---|');
for (const r of other) lines.push(`| ${r.name.replace(/\|/g, '/')} | ${r.status} | ${r.reason.replace(/\|/g, '/')} |`);
writeFileSync(`${root}docs/at_results.md`, `${lines.join('\n')}\n`);
console.log(lines.slice(4, 7).join('\n'));
