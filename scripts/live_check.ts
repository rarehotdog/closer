// First live contact with the Meta Model API, run by the owner on their own machine.
//
//   node scripts/live_check.ts                       # dry run: prints the plan, sends nothing
//   MODEL_API_KEY=… node scripts/live_check.ts --live [--image ./outfit.jpg] [--dump-shape]
//
// Sends at most: 1 model list, 1 Spark intent call, 1 Spark 2 propose call, and with --image 1 Spark
// photo call + 1 SAM call (retries on 429/5xx follow engine/retry.ts). Estimated cost ≈ $0.04 with
// an image, ≈ $0.02 without. Every model answer goes through the same code checks the app runs
// (engine/validate.ts, engine/intent.ts): a step is OK only when its check passed, and "all steps OK"
// only when every step is. Prints and saves only statuses, timings, counts and code checks: never
// the key, headers or raw text. --dump-shape also writes the JSON key paths and value types of each
// response body (no values) to .data/live_check_shape.json, to compare the real shape with the adapters.
// Result file: .data/live_check.json (untracked). Share that file, not your terminal history.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRealTransport, DEFAULT_BASE_URL, type Transport } from '../adapters/transport.ts';
import { createIntentPort } from '../adapters/intent.ts';
import { createSpark1Port } from '../adapters/spark1.ts';
import { createSpark2Port } from '../adapters/spark2.ts';
import { createSamPort } from '../adapters/sam.ts';
import { EST_MICRO_USD, SAM_MODEL, SPARK_MODEL, type CallDeps } from '../adapters/responses.ts';
import type { CallDraft, Spark2Request } from '../adapters/types.ts';
import { checkIntent, INTENT_CHIPS } from '../engine/intent.ts';
import { maskToleranceFromEnv, validateSam, validateSpark1, validateSpark2 } from '../engine/validate.ts';
import { buildBoxPrompt, normToPixelBox } from '../engine/coords.ts';
import { buildSolverInput, chooseOptions } from '../engine/solver.ts';
import { buildFacts } from '../engine/facts.ts';
import { ALL_RULES, type WardrobeFacts } from '../engine/rules.ts';
import { closetItems } from '../fixtures/closet.ts';
import { FXH_INTENT, O0 } from '../fixtures/fxh.ts';
import { kstDateOf } from '../shared/dates.ts';
import type { DecisionContext } from '../shared/wardrobe.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const live = args.includes('--live');
const dumpShape = args.includes('--dump-shape');
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

/** Key paths and value types of a JSON body, never its values ("$.output[0].content[0].text: string(812)"). */
function shapeOf(v: unknown, path = '$', out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (Array.isArray(v)) {
    out.push(`${path}: array(${v.length})`);
    if (v.length > 0) shapeOf(v[0], `${path}[0]`, out, depth + 1);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) shapeOf(x, `${path}.${k}`, out, depth + 1);
  } else out.push(`${path}: ${v === null ? 'null' : typeof v === 'string' ? `string(${v.length})` : typeof v}`);
  return out;
}

/** Spark 2 input built the way the app builds it: the sample closet with the FX-H intent, no thumbnails. */
function spark2Fixture() {
  const today = kstDateOf(new Date());
  const closet = closetItems();
  const facts: WardrobeFacts = { items: new Map(closet.map((i) => [i.itemId, i])), availability: new Map(), lastWorn: new Map(), wearCount: new Map() };
  const ctx: DecisionContext = { baseline: O0, pinned: [...FXH_INTENT.pinned], direction: FXH_INTENT.direction, offenders: [...FXH_INTENT.offenders], hardRules: [], weather: null };
  const input = buildSolverInput(ctx, facts, today, ALL_RULES);
  const allFacts = buildFacts(ctx, facts, today);
  const factIds = allFacts.map((f) => f.id);
  const req: Spark2Request = {
    facts: {
      solver: input,
      factIds,
      factLines: allFacts,
      items: closet.map((it) => ({ itemId: it.itemId, slot: it.slot, type: it.type, color: it.color, formality: it.formality, availability: 'AVAILABLE', lastWorn: null })),
      pinned: ctx.pinned,
      offenders: ctx.offenders,
      direction: ctx.direction,
    },
    thumbnails: [],
    correction: null,
  };
  return { req, check: { ctx, facts, today, rules: ALL_RULES, input, factIds }, codeSolver: chooseOptions(input).options.map((o) => o.changes.map((c) => `${c.slot}:${c.from}→${c.to}`)) };
}

async function main() {
  const base = (process.env.META_API_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  const est = EST_MICRO_USD.intent + EST_MICRO_USD.spark2 + (imagePath ? EST_MICRO_USD.spark1 + EST_MICRO_USD.sam : 0);
  const tolerance = maskToleranceFromEnv(process.env);
  console.log(`Closer live check · base ${base} · models ${SPARK_MODEL}, ${SAM_MODEL} · est. ≤ $${(est / 1e6).toFixed(3)} (+ retries)`);
  console.log(`Plan: GET /models · Spark intent on "${sentence}" · Spark 2 propose on the sample closet (J1 kept, less formal)${imagePath ? ` · Spark photo + SAM on ${imagePath}` : ' · (no --image: photo and SAM skipped)'}`);
  console.log(`Checks: every answer re-checked by code (engine/validate.ts) · SAM mask tolerance ${tolerance ?? 'max(8 px, 5% of the box side)'} · SAM metadata ${process.env.CLOSER_SAM_METADATA === '1' ? 'on' : 'off'}${dumpShape ? ' · response shapes saved (keys and types only)' : ''}`);
  if (!live) {
    console.log('Dry run. Nothing sent. Add --live (and MODEL_API_KEY in the environment) to run.');
    return;
  }
  const key = process.env.MODEL_API_KEY;
  if (!key || !key.trim()) {
    console.error('MODEL_API_KEY is not set in this shell. Nothing sent.');
    process.exit(2);
  }
  const real = createRealTransport(process.env);
  const shapes: { model: string; http: number; shape: string[] }[] = [];
  const transport: Transport = async (req) => {
    const r = await real(req);
    if (dumpShape) shapes.push({ model: String(req.body.model ?? ''), http: r.status, shape: shapeOf(r.json) });
    return r;
  };
  const deps: CallDeps = { transport, source: 'live', sleep: (ms) => new Promise((r) => setTimeout(r, ms)), nowMs: () => performance.now(), nowIso: () => new Date().toISOString() };

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

  // 3. Spark 2 propose (function tool, text only): the sample closet with the FX-H intent
  const fx = spark2Fixture();
  const r2 = await createSpark2Port(deps).propose(fx.req);
  let ok2 = false;
  let result2: unknown;
  if (!r2.ok) result2 = { code: r2.code, detail: r2.detail };
  else {
    const v2 = validateSpark2(r2.value, fx.check);
    ok2 = v2.ok;
    const tool = r2.value.kind === 'function_call' ? r2.value.name : 'text (no tool call)';
    const codeCheck = !v2.ok
      ? { ok: false, codes: v2.codes, detail: v2.detail, perOption: v2.perOption }
      : v2.kind === 'ask'
        ? { ok: true, kind: 'ask', code: v2.code, itemIds: v2.itemIds }
        : { ok: true, kind: 'options', options: v2.options.map((o) => o.changedSlots.map((s) => `${s}:${fx.check.ctx.baseline[s]}→${o.outfit[s]}`)) };
    result2 = { tool, codeCheck, codeSolver: fx.codeSolver };
  }
  steps.push({ step: 'Spark 2 propose', ok: ok2, ...callSummary(r2.calls), result: result2 });

  // 4. Photo → Spark boxes → SAM masks (only with --image)
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
        const rs = await createSamPort({ ...deps, metadata: process.env.CLOSER_SAM_METADATA === '1' }).segment({ imageUrl, prompt: buildBoxPrompt(objects, size.w, size.h) });
        if (!rs.ok) steps.push({ step: 'SAM masks', ok: false, ...callSummary(rs.calls), result: { code: rs.code, detail: rs.detail } });
        else {
          const vs = validateSam(objects, rs.value, size.w, size.h, tolerance);
          // Per record: the largest distance between a returned box edge and its prompt box edge, in px.
          const edgePx = rs.value.map((r) => {
            const p = objects.find((o) => o.id === r.id)?.box;
            const d = p ? Math.max(Math.abs(r.box.x1 - p.x1), Math.abs(r.box.y1 - p.y1), Math.abs(r.box.x2 - p.x2), Math.abs(r.box.y2 - p.y2)) : null;
            return { id: r.id, maxEdgePx: d, frame: `${r.frameW}x${r.frameH}`, raster: r.raster ? `${r.raster.w}x${r.raster.h}` : null };
          });
          steps.push({
            step: 'SAM masks',
            ok: vs.ok,
            ...callSummary(rs.calls),
            result: {
              requested: objects.length,
              records: rs.value.length,
              withMask: rs.value.filter((x) => x.raster !== null).length,
              parser: rs.notes ?? [],
              edgePx,
              tolerancePx: tolerance ?? 'auto: max(8, 5% of the box side)',
              codeCheck: vs.ok ? { ok: true, notes: vs.notes } : { ok: false, codes: vs.codes, detail: vs.detail },
            },
          });
        }
      }
    }
  }

  const out = { at: new Date().toISOString(), base, models: { spark: SPARK_MODEL, sam: SAM_MODEL }, sentence, image: imagePath ? 'provided (not stored)' : null, steps, allOk: steps.every((s) => s.ok) };
  mkdirSync(join(ROOT, '.data'), { recursive: true });
  writeFileSync(join(ROOT, '.data', 'live_check.json'), JSON.stringify(out, null, 2));
  if (dumpShape) writeFileSync(join(ROOT, '.data', 'live_check_shape.json'), JSON.stringify({ at: out.at, shapes }, null, 2));
  for (const s of steps) console.log(`${s.ok ? 'OK  ' : 'FAIL'} ${s.step.padEnd(16)} http ${s.http ?? '-'} · ${s.latencyMs ?? '-'} ms · usage ${s.usageReported === null ? '-' : s.usageReported ? 'yes' : 'no'} · ${JSON.stringify(s.result)}`);
  console.log(`Saved .data/live_check.json${dumpShape ? ' and .data/live_check_shape.json' : ''} · ${out.allOk ? 'all steps OK (each passed its code check)' : 'some steps failed'}`);
  if (steps.some((s) => s.http === 401 || s.http === 403)) console.log('key rejected (HTTP 401/403): check MODEL_API_KEY (scripts/with-key.sh reads it from the Keychain)');
}

main().catch((e) => {
  console.error(`live check stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
