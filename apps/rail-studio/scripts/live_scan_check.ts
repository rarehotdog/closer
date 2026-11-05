// One real scan against the Meta Model API, to check a key and the whole photo -> cards path.
//   MODEL_API_KEY=... npx tsx scripts/live_scan_check.ts [photo.jpg photo.png] [outfit|closet]
// The JPEG goes to the models; the PNG copy (same picture, any size) is used for mask colours and
// cut-outs. Without paths it uses the code-drawn test outfit in server/test/fixtures. It prints
// statuses, timings, counts and the code-check notes only: never the key, the prompt or model text.
// Writes the same summary to .data/live_scan_check.json (not committed).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRealTransport } from '../server/closer/adapters/transport.ts';
import { scanPhoto } from '../server/scan.ts';

const args = process.argv.slice(2);
const mode = args.find((a) => a === 'outfit' || a === 'closet') ?? 'outfit';
const paths = args.filter((a) => a !== 'outfit' && a !== 'closet');
const fixtures = join(import.meta.dirname, '..', 'server', 'test', 'fixtures');
const jpegPath = paths[0] ?? join(fixtures, 'outfit.jpg');
const pngPath = paths[1] ?? join(fixtures, 'outfit.png');

const key = (process.env.MODEL_API_KEY ?? '').trim() || (process.env.META_API_KEY ?? '').trim();
if (!key) {
  console.error('No MODEL_API_KEY (or META_API_KEY) in this shell. Nothing was sent.');
  process.exit(2);
}

const transport = createRealTransport({ ...process.env, MODEL_API_KEY: key, CLOSER_FORBID_REAL: undefined });
const started = new Date().toISOString();
const r = await scanPhoto(
  { jpegBase64: readFileSync(jpegPath).toString('base64'), pngBase64: readFileSync(pngPath).toString('base64'), sentence: '', mode },
  { transport, source: 'live' },
);
const summary = {
  at: started,
  mode,
  photo: paths.length ? 'provided (not stored)' : 'server/test/fixtures/outfit.jpg (drawn by code)',
  ok: r.ok,
  calls: r.calls.map((c) => ({ model: c.model, http: c.http, latencyMs: c.latencyMs, costMicroUsd: c.costMicroUsd })),
  ...(r.ok
    ? { cards: r.cards.length, samMode: r.samMode, colourQuestions: r.cards.filter((c) => c.colorChoices).length, types: r.cards.map((c) => c.type), notes: r.notes }
    : { status: r.status, code: r.code, detail: r.detail }),
};
mkdirSync('.data', { recursive: true });
writeFileSync(join('.data', 'live_scan_check.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(r.ok ? 0 : 1);
