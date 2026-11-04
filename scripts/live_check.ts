// First live contact with the Meta Model API, run by the owner on their own machine.
//
//   node scripts/live_check.ts                       # dry run: prints the plan, sends nothing
//   MODEL_API_KEY=… node scripts/live_check.ts --live [--image ./outfit.jpg]
//
// Sends at most: 1 model list, 1 Spark intent call, and with --image 1 Spark photo call + 1 SAM call
// (retries on 429/5xx follow engine/retry.ts). Estimated cost ≈ $0.04 with an image, ≈ $0.004 without.
// Prints and saves only statuses, timings, counts and code checks: never the key, headers or raw text.
// Result file: .data/live_check.json (untracked). Share that file, not your terminal history.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRealTransport, DEFAULT_BASE_URL } from '../adapters/transport.ts';
import { createIntentPort } from '../adapters/intent.ts';
import { createSpark1Port } from '../adapters/spark1.ts';
import { createSamPort } from '../adapters/sam.ts';
import { EST_MICRO_USD, SAM_MODEL, SPARK_MODEL, type CallDeps } from '../adapters/responses.ts';
import { checkIntent, INTENT_CHIPS } from '../engine/intent.ts';
import { validateSpark1 } from '../engine/validate.ts';
import { buildBoxPrompt, normToPixelBox } from '../engine/coords.ts';
import { closetItems } from '../fixtures/closet.ts';
import type { CallDraft } from '../adapters/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const live = args.includes('--live');
const imagePath = args.includes('--image') ? args[args.indexOf('--image') + 1] : null;
const sentence = args.includes('--sentence') ? args[args.indexOf('--sentence') + 1] : INTENT_CHIPS[0];

type Step = { step: string; ok: boolean; http: number | null; latencyMs: number | null; usageReported: boolean | null; costMicroUsd: number | null; result: unknown };
const steps: Step[] = [];

function callSummary(calls: CallDraft[]) {
  const last = calls[calls.length - 1];
  return { http: last?.http ?? null, latencyMs: last?.latencyMs ?? null, usageReported: last ? last.usage !== null : null, costMicroUsd: calls.reduce((s, c) => s + c.costMicroUsd, 0), attempts: calls.length };
}

/** Width and height from a PNG or JPEG header (no decoder needed). */
function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

async function main() {
  const base = (process.env.META_API_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  const est = EST_MICRO_USD.intent + (imagePath ? EST_MICRO_USD.spark1 + EST_MICRO_USD.sam : 0);
  console.log(`Closer live check · base ${base} · models ${SPARK_MODEL}, ${SAM_MODEL} · est. ≤ $${(est / 1e6).toFixed(3)} (+ retries)`);
  console.log(`Plan: GET /models · Spark intent on "${sentence}"${imagePath ? ` · Spark photo + SAM on ${imagePath}` : ' · (no --image: photo and SAM skipped)'}`);
  if (!live) {
    console.log('Dry run. Nothing sent. Add --live (and MODEL_API_KEY in the environment) to run.');
    return;
  }
  const key = process.env.MODEL_API_KEY;
  if (!key || !key.trim()) {
    console.error('MODEL_API_KEY is not set in this shell. Nothing sent.');
    process.exit(2);
  }
  const deps: CallDeps = { transport: createRealTransport(process.env), source: 'live', sleep: (ms) => new Promise((r) => setTimeout(r, ms)), nowMs: () => performance.now(), nowIso: () => new Date().toISOString() };

  // 1. Model list
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    let ids: string[] = [];
    try {
      const j = (await r.json()) as { data?: { id?: string }[] };
      ids = (j.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    } catch {
      // not JSON
    }
    steps.push({ step: 'GET /models', ok: r.ok, http: r.status, latencyMs: Math.round(performance.now() - t0), usageReported: null, costMicroUsd: 0, result: { count: ids.length, hasSpark: ids.includes(SPARK_MODEL), hasSam: ids.includes(SAM_MODEL), relevant: ids.filter((x) => /muse|sam|spark/i.test(x)).slice(0, 20) } });
  } catch (e) {
    steps.push({ step: 'GET /models', ok: false, http: null, latencyMs: null, usageReported: null, costMicroUsd: 0, result: { error: e instanceof Error ? e.name : 'error' } });
  }

  // 2. Intent (text only)
  const items = closetItems().map((i) => ({ itemId: i.itemId, slot: i.slot, type: i.type, color: i.color }));
  const ri = await createIntentPort(deps).read(sentence, items);
  const ci = ri.ok ? checkIntent(ri.value, items) : null;
  steps.push({ step: 'Spark intent', ok: ri.ok && !!ci?.ok, ...callSummary(ri.calls), result: ri.ok ? { codeCheck: ci } : { code: ri.code, detail: ri.detail } });

  // 3. Photo → Spark boxes → SAM masks (only with --image)
  if (imagePath) {
    const buf = readFileSync(imagePath);
    const ext = extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const size = imageSize(buf);
    if (!size || Math.max(size.w, size.h) > 1600) {
      steps.push({ step: 'Spark photo', ok: false, http: null, latencyMs: null, usageReported: null, costMicroUsd: 0, result: { detail: size ? `long side ${Math.max(size.w, size.h)} px > 1600; resize first` : 'not a PNG or JPEG' } });
    } else {
      const imageUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const r1 = await createSpark1Port(deps).perceive({ imageUrl, sentence });
      const v1 = r1.ok ? validateSpark1(r1.value) : null;
      steps.push({ step: 'Spark photo', ok: r1.ok && !!v1?.ok, ...callSummary(r1.calls), result: r1.ok ? (v1?.ok ? { garments: v1.value.garments.length, pin: v1.value.pin.length, direction: v1.value.direction, offenders: v1.value.offenders.length } : { codes: (v1 as { codes: string[] }).codes }) : { code: r1.code, detail: r1.detail } });
      if (v1?.ok) {
        const objects = v1.value.garments.map((g, i) => ({ id: i + 1, box: normToPixelBox(g.box, size.w, size.h) }));
        const rs = await createSamPort(deps).segment({ imageUrl, prompt: buildBoxPrompt(objects, size.w, size.h) });
        steps.push({ step: 'SAM masks', ok: rs.ok, ...callSummary(rs.calls), result: rs.ok ? { requested: objects.length, records: rs.value.length, withMask: rs.value.filter((x) => x.raster !== null).length } : { code: rs.code, detail: rs.detail } });
      }
    }
  }

  const out = { at: new Date().toISOString(), base, models: { spark: SPARK_MODEL, sam: SAM_MODEL }, sentence, image: imagePath ? 'provided (not stored)' : null, steps, allOk: steps.every((s) => s.ok) };
  mkdirSync(join(ROOT, '.data'), { recursive: true });
  writeFileSync(join(ROOT, '.data', 'live_check.json'), JSON.stringify(out, null, 2));
  for (const s of steps) console.log(`${s.ok ? 'OK  ' : 'FAIL'} ${s.step.padEnd(14)} http ${s.http ?? '-'} · ${s.latencyMs ?? '-'} ms · usage ${s.usageReported === null ? '-' : s.usageReported ? 'yes' : 'no'} · ${JSON.stringify(s.result)}`);
  console.log(`Saved .data/live_check.json · ${out.allOk ? 'all steps OK' : 'some steps failed'}`);
}

main().catch((e) => {
  console.error(`live check stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
