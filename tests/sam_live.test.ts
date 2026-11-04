// Live SAM response path (11/4): the official parser reads records by name, decodes the masks, and
// a box that overshoots its prompt within the tolerance is clamped instead of holding the decision.
// Synthetic Responses JSON through a fake transport; no network (helpers.ts blocks fetch). The mock
// transport's own format is covered by the acceptance tests and is left as it was.
import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSamBody, createSamPort, parseLiveSegmentation } from '../adapters/sam.ts';
import { ASK_OWNER_TOOL, PROPOSE_EDIT_TOOL } from '../adapters/spark2.ts';
import { SPARK1_SCHEMA } from '../adapters/spark1.ts';
import { intentSchema } from '../adapters/intent.ts';
import { SAM_MODEL } from '../adapters/responses.ts';
import { errorResponse, textResponse } from '../adapters/mock/transport.ts';
import type { Transport } from '../adapters/transport.ts';
import { buildBoxPrompt, decodeMockRle, encodeMockRle } from '../engine/coords.ts';
import { autoMaskTolerancePx, maskToleranceFromEnv, validateSam, validateSpark1, validateSpark2, type SamRecord } from '../engine/validate.ts';
import { buildSolverInput } from '../engine/solver.ts';
import { buildFacts } from '../engine/facts.ts';
import { ALL_RULES, type WardrobeFacts } from '../engine/rules.ts';
import { closetItems } from '../fixtures/closet.ts';
import { FXH_INTENT, O0 } from '../fixtures/fxh.ts';
import type { DecisionContext } from '../shared/wardrobe.ts';
import { harness, startHero } from './helpers.ts';

// The README's one_bit example (5 × 5, 10 set bits) and the docs' lossless example (27 × 60,
// 1,539 set bits) as they appear on the wire: data=H,W,<marker>payload.
const ONE_BIT_WIRE = '5,5,!!!!!(QO(0lu8?';
const ONE_BIT_BITS = '1001000110000001011110001';
const LOSSLESS_WIRE = "27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
// Two records: ids out of order, box fields in an order the mock never emits, confidence on both
// tokens, mask fields after the payload, a trailing newline.
const LIVE_TEXT = `<0f>2<|box;w=320;h=334;c=0.93;y2=6;x2=7;y1=2;x1=3|><|mask;c=0.91;data=${ONE_BIT_WIRE};y=0;x=0|>,1<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=${LOSSLESS_WIRE}|>\n`;
const IMG = 'data:image/png;base64,AA==';

const fakeTransport = (status: number, text: string): Transport => async () => {
  const r = status === 200 ? textResponse(SAM_MODEL, text, 'sam') : errorResponse(status);
  return { status: r.status, headers: r.headers ?? {}, json: r.json ?? null };
};
const liveDeps = (transport: Transport) => ({ transport, source: 'live' as const, sleep: async () => {}, nowMs: () => 0, nowIso: () => '2026-11-04T00:00:00Z' });
const ones = (bits: Uint8Array) => bits.reduce((a, b) => a + b, 0);

test('SL-01 live SAM text: the official parser reads fields by name, half-open bounds come back as inclusive boxes, masks are decoded', async () => {
  const { records, diagnostics } = await parseLiveSegmentation(LIVE_TEXT);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(records.map((r) => r.id), [2, 1], 'output order kept');
  const [a, b] = records;
  assert.deepEqual(a.box, { x1: 3, y1: 2, x2: 7, y2: 6 });
  assert.deepEqual([a.frameW, a.frameH], [320, 334]);
  assert.deepEqual({ x: a.raster!.x, y: a.raster!.y, w: a.raster!.w, h: a.raster!.h }, { x: 3, y: 2, w: 5, h: 5 });
  assert.equal(Array.from(a.raster!.bits).join(''), ONE_BIT_BITS);
  assert.deepEqual(b.box, { x1: 211, y1: 228, x2: 270, y2: 254 });
  assert.deepEqual([b.raster!.w, b.raster!.h, ones(b.raster!.bits)], [60, 27, 1539]);
  // The code re-check passes for the prompts these boxes answer; a reported frame other than the sent size fails it.
  const objects = [{ id: 1, box: { x1: 211, y1: 228, x2: 270, y2: 254 } }, { id: 2, box: { x1: 3, y1: 2, x2: 7, y2: 6 } }];
  const vs = validateSam(objects, records, 320, 334);
  assert.ok(vs.ok, !vs.ok ? vs.detail : '');
  assert.deepEqual(vs.ok && vs.notes, []);
  assert.equal(validateSam(objects, records, 640, 334).ok, false);
});

test('SL-02 live SAM port: records from a 2xx body; parser diagnostics become call-line notes; a dropped record fails the id check; mock text stays on the mock path', async () => {
  const r = await createSamPort(liveDeps(fakeTransport(200, LIVE_TEXT))).segment({ imageUrl: IMG, prompt: 'x' });
  assert.ok(r.ok, !r.ok ? r.detail : '');
  assert.deepEqual(r.ok && r.value.map((x) => x.id), [2, 1]);
  assert.deepEqual(r.ok && r.notes, []);
  // An unknown box field is kept with a warning; a line that is not an API line loses its records with an error.
  const noisy = `<0f>2<|box;x1=3;y1=2;x2=7;y2=6;w=320;h=334;z=1|><|mask;x=0;y=0;data=${ONE_BIT_WIRE}|>\n<0f>1<|box;x1=1;y1=1|>\n`;
  const r2 = await createSamPort(liveDeps(fakeTransport(200, noisy))).segment({ imageUrl: IMG, prompt: 'x' });
  assert.ok(r2.ok, !r2.ok ? r2.detail : '');
  assert.deepEqual(r2.ok && r2.value.map((x) => x.id), [2]);
  const notes = (r2.ok && r2.notes?.join(' ')) || '';
  assert.match(notes, /ignored_field \(warning\) ×1/);
  assert.match(notes, /malformed_record \(error\) ×1/);
  const vs = validateSam([{ id: 1, box: { x1: 0, y1: 0, x2: 9, y2: 9 } }, { id: 2, box: { x1: 3, y1: 2, x2: 7, y2: 6 } }], r2.ok ? r2.value : [], 320, 334);
  assert.match(!vs.ok ? vs.detail : '', /SAM ids \{2\} != requested \{1,2\}/);
  // A non-2xx answer names the key on 401 and keeps the fixed reason code.
  const r401 = await createSamPort(liveDeps(fakeTransport(401, ''))).segment({ imageUrl: IMG, prompt: 'x' });
  assert.equal(r401.ok, false);
  assert.equal(!r401.ok && r401.code, 'META_API_UNAVAILABLE');
  assert.match(!r401.ok ? r401.detail : '', /SAM HTTP 401: check the key/);
  // The mock transport's 'R' records are not API lines: with source 'mock' they take the positional path.
  const mockText = `<0f>1<|box;x1=0;y1=0;x2=1;y2=1;w=10;h=10|><|mask;x=0;y=0;data=2,2,R${encodeMockRle(new Uint8Array([1, 0, 0, 1]))}|>`;
  const rm = await createSamPort({ ...liveDeps(fakeTransport(200, mockText)), source: 'mock' }).segment({ imageUrl: IMG, prompt: 'x' });
  assert.ok(rm.ok, !rm.ok ? rm.detail : '');
  assert.deepEqual(rm.ok && Array.from(rm.value[0].raster!.bits), [1, 0, 0, 1]);
});

test('SL-03 SAM prompt text comes from the official builder (same tokens as before); metadata only with CLOSER_SAM_METADATA=1', () => {
  assert.equal(
    buildBoxPrompt([{ id: 1, box: { x1: 0, y1: 0, x2: 1, y2: 1 } }, { id: 2, box: { x1: 3, y1: 3, x2: 9, y2: 9 } }], 10, 10),
    '<0f>1<|box;x1=0;y1=0;x2=1;y2=1;w=10;h=10|>,2<|box;x1=3;y1=3;x2=9;y2=9;w=10;h=10|>',
  );
  assert.throws(() => buildBoxPrompt([{ id: 1, box: { x1: 0, y1: 0, x2: 10, y2: 1 } }], 10, 10), /outside/);
  assert.throws(() => buildBoxPrompt([{ id: 1, box: { x1: 0, y1: 0, x2: 1, y2: 1 } }, { id: 1, box: { x1: 2, y1: 2, x2: 3, y2: 3 } }], 10, 10), /repeated/);
  assert.throws(() => buildBoxPrompt([], 10, 10), /no objects/);
  const req = { imageUrl: IMG, prompt: 'x' };
  assert.equal('metadata' in buildSamBody(req), false);
  assert.deepEqual(buildSamBody(req, { metadata: true }).metadata, { mask_encoding: 'one_bit' });
});

test('SL-04 strict schemas carry no maxItems/minItems/minimum/maximum; the same bounds are enforced by code', () => {
  for (const [name, schema] of [['SPARK1_SCHEMA', SPARK1_SCHEMA], ['PROPOSE_EDIT_TOOL', PROPOSE_EDIT_TOOL], ['ASK_OWNER_TOOL', ASK_OWNER_TOOL], ['intentSchema', intentSchema(['J1'])]] as const) {
    assert.doesNotMatch(JSON.stringify(schema), /maxItems|minItems|minimum|maximum/, name);
  }
  // Spark 1: ≤ 16 garments, box = 4 integers 0–1000, pin and offender indices within the list (engine/validate.ts validateSpark1).
  const g = { box: [0, 0, 10, 10], type: 'jacket', color_family: 'navy', formality: 'high' };
  const base = { pin: [], direction: 'none', offenders: [], reasonCandidates: [] };
  const v17 = validateSpark1({ ...base, garments: Array.from({ length: 17 }, () => g) });
  assert.deepEqual(!v17.ok && v17.codes, ['TOO_MANY_ITEMS']);
  assert.match(!validateSpark1({ ...base, garments: [{ ...g, box: [0, 0, 10, 1001] }] }).ok ? 'box' : '', /box/);
  assert.equal(validateSpark1({ ...base, garments: [{ ...g, box: [0, 0, 10] }] }).ok, false);
  const vPin = validateSpark1({ ...base, garments: [g], pin: [-1] });
  assert.match(!vPin.ok ? vPin.detail : '', /pin/);
  const vOff = validateSpark1({ ...base, garments: [g], offenders: [{ index: 1, why: 'too_formal' }] });
  assert.match(!vOff.ok ? vOff.detail : '', /offender/);
  // Spark 2: one or two options (engine/validate.ts validateSpark2).
  const today = '2026-11-04';
  const closet = closetItems();
  const facts: WardrobeFacts = { items: new Map(closet.map((i) => [i.itemId, i])), availability: new Map(), lastWorn: new Map(), wearCount: new Map() };
  const ctx: DecisionContext = { baseline: O0, pinned: [...FXH_INTENT.pinned], direction: FXH_INTENT.direction, offenders: [...FXH_INTENT.offenders], hardRules: [], weather: null };
  const input = buildSolverInput(ctx, facts, today, ALL_RULES);
  const check = { ctx, facts, today, rules: ALL_RULES, input, factIds: buildFacts(ctx, facts, today).map((f) => f.id) };
  const propose = (options: unknown[]) => validateSpark2({ kind: 'function_call', name: 'propose_edit', arguments: JSON.stringify({ options }) }, check);
  const one = { changes: [{ slot: 'bottom', itemId: 'B2' }], reasonFactIds: ['dir:less_formal'], visual_match: [] };
  const none = propose([]);
  assert.match(!none.ok ? none.detail : '', /options must be 1–2/);
  const three = propose([one, one, one]);
  assert.match(!three.ok ? three.detail : '', /options must be 1–2/);
  assert.ok(propose([one]).ok);
});

test('SL-05 mask-in-box: default tolerance max(8 px, 5 %); an overshoot within it is clamped and noted, beyond it fails; env override', () => {
  assert.equal(autoMaskTolerancePx({ x1: 0, y1: 0, x2: 49, y2: 49 }), 8);
  assert.equal(autoMaskTolerancePx({ x1: 100, y1: 0, x2: 499, y2: 199 }), 20);
  assert.equal(maskToleranceFromEnv({}), undefined);
  assert.equal(maskToleranceFromEnv({ CLOSER_MASK_TOLERANCE_PX: '' }), undefined);
  assert.equal(maskToleranceFromEnv({ CLOSER_MASK_TOLERANCE_PX: ' 12 ' }), 12);
  assert.equal(maskToleranceFromEnv({ CLOSER_MASK_TOLERANCE_PX: '0' }), 0);
  for (const bad of ['-1', '2.5', 'abc']) assert.equal(maskToleranceFromEnv({ CLOSER_MASK_TOLERANCE_PX: bad }), undefined, bad);

  const prompt = { id: 1, box: { x1: 100, y1: 100, x2: 199, y2: 199 } }; // 100 × 100 → tolerance 8
  const returned = { x1: 98, y1: 100, x2: 202, y2: 199 }; // 2 px past the left edge, 3 px past the right edge
  const w = 105, h = 100;
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = (x + y) % 3 === 0 ? 1 : 0;
  const rec: SamRecord = { id: 1, box: returned, frameW: 400, frameH: 400, raster: { x: 98, y: 100, w, h, bits } };
  const vs = validateSam([prompt], [rec], 400, 400);
  assert.ok(vs.ok, !vs.ok ? vs.detail : '');
  if (vs.ok) {
    assert.deepEqual(vs.notes, ['mask 1 overshoot 3 px']);
    const r = vs.records[0];
    assert.deepEqual(r.box, prompt.box);
    assert.deepEqual({ x: r.raster!.x, y: r.raster!.y, w: r.raster!.w, h: r.raster!.h }, { x: 100, y: 100, w: 100, h: 100 });
    const expected = new Uint8Array(100 * 100);
    for (let y = 0; y < 100; y++) expected.set(bits.subarray(y * w + 2, y * w + 102), y * 100);
    assert.deepEqual(r.raster!.bits, expected, 'the raster is cropped to the prompt box');
  }
  assert.equal(rec.raster!.w, 105, 'the input record is not changed');
  const far = validateSam([prompt], [{ ...rec, box: { ...returned, x2: 208 }, raster: { ...rec.raster!, w: 111, bits: new Uint8Array(111 * 100) } }], 400, 400);
  assert.match(!far.ok ? far.detail : '', /mask 1 leaves its box by 9 px \(tolerance 8\)/);
  const strict = validateSam([prompt], [rec], 400, 400, 0);
  assert.match(!strict.ok ? strict.detail : '', /by 3 px \(tolerance 0\)/);
  assert.ok(validateSam([prompt], [rec], 400, 400, 3).ok);
  // The raster must match the returned box before any clamping.
  const bad = validateSam([prompt], [{ ...rec, raster: { ...rec.raster!, w: 100 } }], 400, 400);
  assert.match(!bad.ok ? bad.detail : '', /raster size != box size/);
});

test('SL-06 service: a SAM box 2 px outside its prompt box is clamped (DRAFT, noted on the call line); a 401 names the key', async () => {
  // Take the mock's own hero answer and push every returned box 2 px past its prompt box.
  const h0 = harness();
  let text = '';
  const expectedNotes: string[] = [];
  try {
    const op0 = await startHero(h0);
    assert.equal(op0.state, 'DRAFT');
    const { w, h } = op0.perception!;
    const parts: string[] = [];
    for (const c of op0.cards) {
      const m = c.mask!;
      const bits = decodeMockRle(m.rle, m.w * m.h);
      const x2 = c.box.x2 + 2, y2 = c.box.y2 + 2;
      assert.ok(x2 < w && y2 < h, 'room to overshoot inside the frame');
      const nw = x2 - m.x + 1, nh = y2 - m.y + 1;
      const padded = new Uint8Array(nw * nh);
      for (let y = 0; y < m.h; y++) padded.set(bits.subarray(y * m.w, (y + 1) * m.w), y * nw);
      parts.push(`${c.cardId}<|box;x1=${m.x};y1=${m.y};x2=${x2};y2=${y2};w=${w};h=${h}|><|mask;x=0;y=0;data=${nh},${nw},R${encodeMockRle(padded)}|>`);
      expectedNotes.push(`mask ${c.cardId} overshoot 2 px`);
    }
    text = `<0f>${parts.join(',')}`;
  } finally {
    h0.cleanup();
  }
  const h1 = harness({ script: { sam: () => textResponse(SAM_MODEL, text, 'sam') } });
  try {
    const op1 = await startHero(h1);
    assert.equal(op1.state, 'DRAFT', op1.detail);
    const samLine = op1.callLines.find((l) => l.includes(SAM_MODEL)) ?? '';
    for (const n of expectedNotes) assert.ok(samLine.includes(n), `${samLine} notes ${n}`);
    for (const c of op1.cards) {
      assert.equal(c.mask!.x + c.mask!.w - 1, c.box.x2, `card ${c.cardId} mask clamped to its box`);
      assert.equal(c.mask!.y + c.mask!.h - 1, c.box.y2, `card ${c.cardId} mask clamped to its box`);
    }
  } finally {
    h1.cleanup();
  }
  const h2 = harness({ script: { spark1: () => errorResponse(401) } });
  try {
    const op = await startHero(h2);
    assert.equal(op.state, 'HOLD');
    assert.deepEqual(op.reasonCodes, ['META_API_UNAVAILABLE']);
    assert.match(op.detail, /Spark 1 HTTP 401: check the key/);
    assert.equal(h2.calls().filter((c) => c.kind === 'spark1').length, 1, '401 is not retried');
  } finally {
    h2.cleanup();
  }
});
