// node:test reporter → one JSON result file (docs/at_results.json). The README/status tables are
// built from this single result file (plan §4-4).
export default async function* reporter(source) {
  const results = [];
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    if (d.details?.type === 'suite' || d.nesting > 0) continue;
    const skipped = d.skip !== undefined && d.skip !== false;
    const status = skipped ? 'SKIP' : ev.type === 'test:pass' ? 'PASS' : 'FAIL';
    const err = d.details?.error;
    results.push({
      name: d.name,
      file: (d.file ?? '').split('/').slice(-2).join('/'),
      status,
      reason: skipped ? (typeof d.skip === 'string' ? d.skip : '') : status === 'FAIL' ? String(err?.cause?.message ?? err?.message ?? err ?? '').split('\n')[0] : '',
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  yield `${JSON.stringify({ results }, null, 2)}\n`;
}
