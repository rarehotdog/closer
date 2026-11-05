// Photo -> cards through the scan route's pipeline, with the test fake standing in for Meta.
// No network: the fake transport answers every call; a key is never read here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanPhoto, type ScanDeps } from './scan.ts';
import { createFakeMetaTransport, FAKE_CLOSET_ANSWER, FAKE_SPARK_ANSWER } from './fakeMeta.ts';
import type { Transport } from './closer/adapters/transport.ts';
import { decodePng, encodePng } from './closer/engine/png.ts';

const dir = join(import.meta.dirname, 'test', 'fixtures');
const jpegBase64 = readFileSync(join(dir, 'outfit.jpg')).toString('base64');
const pngBase64 = readFileSync(join(dir, 'outfit.png')).toString('base64');
const deps = (transport: Transport): ScanDeps => ({ transport, source: 'mock', sleep: async () => {}, nowMs: () => 0, nowIso: () => '2026-11-05T00:00:00.000Z' });

test('PNG decompression is bounded by declared pixels and rejects mismatched data before any model call', async () => {
  const small = encodePng({ w: 1, h: 1, data: new Uint8Array(4).fill(255) });
  const large = encodePng({ w: 64, h: 64, data: new Uint8Array(64 * 64 * 4).fill(255) });
  // Each original chunk retains a valid CRC. Only the relationship between IHDR and IDAT is wrong.
  const oversized = Buffer.concat([small.subarray(0, 33), large.subarray(33)]);
  const truncated = Buffer.concat([large.subarray(0, 33), small.subarray(33)]);
  assert.throws(() => decodePng(oversized), { code: 'ERR_BUFFER_TOO_LARGE' });
  assert.throws(() => decodePng(truncated), /data size does not match dimensions/);
  let calls = 0;
  const transport: Transport = async () => { calls++; throw new Error('A rejected image must not reach a model'); };
  for (const malformed of [oversized, truncated]) {
    const result = await scanPhoto({ jpegBase64, pngBase64: malformed.toString('base64'), sentence: '' }, deps(transport));
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.status, 400); assert.equal(result.code, 'BAD_INPUT'); }
  }
  assert.equal(calls, 0);
});

test('SC-01 one photo -> one card per garment, cut out by its mask, colour measured from the pixels', async () => {
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: 'Keep this jacket. The rest feels too dressed-up.' }, deps(createFakeMetaTransport()));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.samMode, 'mask');
  assert.deepEqual(r.cards.map((c) => [c.type, c.slot]), [['jacket', 'outer'], ['trousers', 'bottom']]);
  assert.deepEqual(r.cards.map((c) => c.maskColor), ['navy', 'gray']);
  assert.deepEqual(r.cards.map((c) => c.colorChoices), [null, null]);
  assert.equal(r.cards[0].pinned, true);
  assert.equal(r.cards[1].offender, 'too_formal');
  for (const c of r.cards) {
    assert.match(c.cutout, /^data:image\/png;base64,/);
    assert.equal(c.cutoutKind, 'mask');
  }
  assert.equal(r.direction, 'less_formal');
  assert.deepEqual(r.calls.map((c) => c.model), ['muse-spark-1.3', 'sam-3.1']);
  assert.equal(r.w, 600);
  assert.equal(r.h, 900);
});

test('SC-02 Spark colour and mask pixels disagree -> the card asks instead of choosing', async () => {
  const sparkSaysBlack: Transport = async (req) => {
    const fake = createFakeMetaTransport();
    if ((req.body as { model?: string }).model !== 'muse-spark-1.3') return fake(req);
    const a = structuredClone(FAKE_SPARK_ANSWER);
    a.garments[0].color_family = 'black';
    return { status: 200, headers: {}, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(a) }] }] } };
  };
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '' }, deps(sparkSaysBlack));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.cards[0].colorChoices, ['black', 'navy']);
});

test('SC-03 SAM fails -> box crops, no measured colour, and a note says so', async () => {
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '' }, deps(createFakeMetaTransport({ samStatus: 400 })));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.samMode, 'box_crop');
  assert.ok(r.cards.every((c) => c.maskColor === null && c.cutoutKind === 'box_crop' && c.colorChoices === null));
  assert.ok(r.notes.some((n) => n.includes('box crops')));
});

test('SC-04 a mask that leaves its box beyond tolerance is refused by code -> box crops', async () => {
  const wide: Transport = async (req) => {
    const fake = createFakeMetaTransport();
    const res = await fake(req);
    if ((req.body as { model?: string }).model !== 'sam-3.1') return res;
    // Stretch record 1's box 80 px to the right of what was prompted.
    const j = res.json as { output: { content: { text: string }[] }[] };
    const t = j.output[0].content[0].text.replace(/1<\|box;x1=(\d+);y1=(\d+);x2=(\d+)/, (_m, a, b, c) => `1<|box;x1=${a};y1=${b};x2=${Math.min(599, Number(c) + 80)}`);
    j.output[0].content[0].text = t;
    return res;
  };
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '' }, deps(wide));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Only the refused mask falls back: card 1 is a box crop, card 2 keeps its mask and measured colour.
  assert.equal(r.samMode, 'mask');
  assert.deepEqual(r.cards.map((c) => c.cutoutKind), ['box_crop', 'mask']);
  assert.deepEqual(r.cards.map((c) => c.maskColor), [null, 'gray']);
  assert.ok(r.notes.some((n) => /^1 of 2 masks refused by the code check \(mask 1 /.test(n)));
});

test('SC-04b every mask refused -> the whole photo falls back to box crops', async () => {
  const allWide: Transport = async (req) => {
    const res = await createFakeMetaTransport()(req);
    if ((req.body as { model?: string }).model !== 'sam-3.1') return res;
    const j = res.json as { output: { content: { text: string }[] }[] };
    j.output[0].content[0].text = j.output[0].content[0].text.replace(/(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+)/g, (_m, id, a, b, c) => `${id}<|box;x1=${a};y1=${b};x2=${Math.min(599, Number(c) + 80)}`);
    return res;
  };
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '' }, deps(allWide));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.samMode, 'box_crop');
  assert.ok(r.cards.every((c) => c.cutoutKind === 'box_crop' && c.maskColor === null));
  assert.ok(r.notes.some((n) => n.startsWith('SAM masks refused by the code check')));
});

test('SC-05 Spark answers outside the schema rules -> refused, nothing turned into cards', async () => {
  const badBox: Transport = async () => ({ status: 200, headers: {}, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...FAKE_SPARK_ANSWER, garments: [{ box: [900, 10, 100, 20], type: 'jacket', color_family: 'navy', formality: 'high' }], pin: [], offenders: [] }) }] }] } });
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '' }, deps(badBox));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 422);
  assert.deepEqual(r.calls.map((c) => c.model), ['muse-spark-1.3']);
});

test('SC-06 inputs are checked before any call', async () => {
  let called = 0;
  const counting: Transport = async (req) => {
    called++;
    return createFakeMetaTransport()(req);
  };
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ pngBase64, sentence: '' }, /jpegBase64 is missing/],
    [{ jpegBase64: pngBase64, pngBase64, sentence: '' }, /not a JPEG/],
    [{ jpegBase64, pngBase64: jpegBase64, sentence: '' }, /not a PNG/],
    [{ jpegBase64, pngBase64, sentence: 'x'.repeat(201) }, /sentence over 200/],
  ];
  for (const [input, re] of cases) {
    const r = await scanPhoto(input as never, deps(counting));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.detail, re);
    }
  }
  assert.equal(called, 0);
});

test('SC-07 closet mode: many pieces, several in one slot, no kept piece or direction', async () => {
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '', mode: 'closet' }, deps(createFakeMetaTransport()));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.kind, 'closet');
  assert.equal(r.cards.length, 6);
  assert.equal(r.cards.filter((c) => c.slot === 'outer').length, 3);
  assert.ok(r.cards.every((c) => !c.pinned && c.offender === null));
  assert.equal(r.direction, 'none');
  assert.equal(r.moreNotListed, false);
  assert.equal(r.samMode, 'mask');
});

test('SC-08 the same many-jacket answer is refused in outfit mode (one garment per slot)', async () => {
  const closetAnswerAsOutfit: Transport = async (req) => {
    if ((req.body as { model?: string }).model !== 'muse-spark-1.3') return createFakeMetaTransport()(req);
    const a = { garments: FAKE_CLOSET_ANSWER.garments, pin: [], direction: 'none', offenders: [], reasonCandidates: [] };
    return { status: 200, headers: {}, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(a) }] }] } };
  };
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '' }, deps(closetAnswerAsOutfit));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail, /slot rule/);
});

test('SC-09 closet mode: Spark saying more garments exist adds a note; a bad mode is refused before any call', async () => {
  const more: Transport = async (req) => {
    if ((req.body as { model?: string }).model !== 'muse-spark-1.3') return createFakeMetaTransport()(req);
    return { status: 200, headers: {}, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...FAKE_CLOSET_ANSWER, more_not_listed: true }) }] }] } };
  };
  const r = await scanPhoto({ jpegBase64, pngBase64, sentence: '', mode: 'closet' }, deps(more));
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.notes.some((n) => n.includes('more garments than it listed')));
  const b = await scanPhoto({ jpegBase64, pngBase64, sentence: '', mode: 'wardrobe' }, deps(createFakeMetaTransport()));
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.status, 400);
});
