// Whole-closet scan path (11/5): one photo of an open closet or garment rail registers up to 16
// visible garments across duplicate slots (several coats, jackets, sweaters, shirts, trousers),
// confirms them into the owner wardrobe, and feeds the ledger, Keep-or-let-go, Today, and Discover.
import { harness, ROOT } from './helpers.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '../engine/png.ts';
import { PhotoStore } from '../store/photos.ts';
import { encodeMockRle, normToPixelBox, type NormBox } from '../engine/coords.ts';
import { textResponse } from '../adapters/mock/transport.ts';
import { createMockPorts } from '../adapters/index.ts';
import { SAM_MODEL } from '../adapters/responses.ts';
import { buildSpark1Body, SPARK1_INSTRUCTIONS, SPARK1_SCAN_INSTRUCTIONS } from '../adapters/spark1.ts';
import { validateSpark1 } from '../engine/validate.ts';
import { CloserService } from '../engine/service.ts';
import { ExtrasStore } from '../store/extras.ts';
import { FeatureService } from '../engine/features.ts';

const dir = join(ROOT, '.data', 'test', `closet-scan-${process.pid}`);
after(() => rmSync(dir, { recursive: true, force: true }));

function fakeJpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function stripedClosetPng(w: number, h: number, cols: { box: NormBox; rgb: [number, number, number] }[]): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([236, 232, 224, 255], i * 4);
  for (const c of cols) {
    const p = normToPixelBox(c.box, w, h);
    for (let y = p.y1; y <= p.y2; y++) {
      for (let x = p.x1; x <= p.x2; x++) {
        data.set([c.rgb[0], c.rgb[1], c.rgb[2], 255], (y * w + x) * 4);
      }
    }
  }
  return encodePng({ w, h, data });
}

test('CS-01 outfit mode rejects duplicate slots while scan mode accepts up to 16 pieces across duplicate slots', () => {
  const raw = {
    garments: [
      { box: [40, 120, 180, 620], type: 'jacket', color_family: 'black', formality: 'high' },
      { box: [190, 120, 340, 640], type: 'coat', color_family: 'navy', formality: 'mid' },
      { box: [350, 130, 520, 660], type: 'coat', color_family: 'charcoal', formality: 'low' },
      { box: [530, 140, 680, 580], type: 'knit', color_family: 'beige', formality: 'mid' },
      { box: [690, 140, 840, 590], type: 'dress_shirt', color_family: 'white', formality: 'mid' },
    ],
    pin: [],
    direction: 'none',
    offenders: [],
    reasonCandidates: [],
  };
  const outfit = validateSpark1(raw);
  assert.equal(outfit.ok, false, 'outfit path keeps one-piece-per-slot');
  const scanned = validateSpark1(raw, { allowDuplicateSlots: true });
  assert.equal(scanned.ok, true, 'closet scan accepts multiple outerwear and tops');
  assert.equal(scanned.value.garments.length, 5);

  const b1 = buildSpark1Body({ imageUrl: 'data:image/jpeg;base64,AA==', sentence: 'x' });
  const b2 = buildSpark1Body({ imageUrl: 'data:image/jpeg;base64,AA==', sentence: 'x', scan: true });
  const sys = (b: Record<string, unknown>) => ((b.input as { content: { text: string }[] }[])[0].content[0].text);
  assert.equal(sys(b1), SPARK1_INSTRUCTIONS);
  assert.equal(sys(b2), SPARK1_SCAN_INSTRUCTIONS);
});

test('CS-02 uploaded closet photo scans 8 garments across duplicate slots, confirms them, and powers ledger, Keep-or-let-go, Today, and Discover', async () => {
  const W = 600, H = 800;
  const specs: { box: NormBox; type: string; color_family: string; formality: string; rgb: [number, number, number] }[] = [
    { box: [30, 100, 130, 560], type: 'jacket', color_family: 'black', formality: 'high', rgb: [20, 20, 22] },
    { box: [140, 100, 240, 560], type: 'jacket', color_family: 'navy', formality: 'mid', rgb: [30, 50, 90] },
    { box: [250, 100, 360, 590], type: 'coat', color_family: 'charcoal', formality: 'low', rgb: [64, 66, 70] },
    { box: [370, 100, 480, 580], type: 'coat', color_family: 'beige', formality: 'mid', rgb: [208, 188, 152] },
    { box: [490, 120, 590, 520], type: 'knit', color_family: 'beige', formality: 'mid', rgb: [208, 188, 152] },
    { box: [600, 120, 700, 520], type: 'dress_shirt', color_family: 'white', formality: 'mid', rgb: [248, 248, 246] },
    { box: [710, 120, 810, 540], type: 'knit', color_family: 'gray', formality: 'low', rgb: [148, 150, 152] },
    { box: [220, 650, 460, 960], type: 'trousers', color_family: 'charcoal', formality: 'mid', rgb: [64, 66, 70] },
  ];
  const store = new PhotoStore(dir);
  const up = store.save('owner', fakeJpeg(W, H), stripedClosetPng(W, H, specs), '2026-11-05T01:30:00Z');

  const h = harness({ seeds: [] });
  const { ports } = createMockPorts(
    h.lib,
    { sleep: async () => {}, nowMs: () => performance.now(), nowIso: () => h.clock.now.toISOString() },
    {
      spark1: () => textResponse('muse-spark-1.3', JSON.stringify({
        garments: specs.map(({ box, type, color_family, formality }) => ({ box, type, color_family, formality })),
        pin: [],
        direction: 'none',
        offenders: [],
        reasonCandidates: [],
      }), 'spark1'),
      sam: () => {
        const tokens = specs.map((s, i) => {
          const p = normToPixelBox(s.box, W, H);
          const mw = p.x2 - p.x1 + 1, mh = p.y2 - p.y1 + 1;
          const bits = new Uint8Array(mw * mh).fill(1);
          return `${i + 1}<|box;x1=${p.x1};y1=${p.y1};x2=${p.x2};y2=${p.y2};w=${W};h=${H}|><|mask;x=0;y=0;data=${mh},${mw},R${encodeMockRle(bits)}|>`;
        });
        return textResponse(SAM_MODEL, `<0f>${tokens.join(',')}`, 'sam');
      },
    },
  );
  const svc = new CloserService({
    ledger: h.ledger,
    ports,
    photos: { get: (id: string) => h.lib.get(id) ?? store.get(id) },
    mode: 'mock',
    clock: { now: () => h.clock.now, today: () => h.clock.today },
  });
  h.ledger.createWorkspace({ workspaceId: 'owner', kind: 'real', publicReadOnly: false, seedRef: 'empty', createdOn: h.clock.today }, { items: [], since: h.clock.today });

  const op = await svc.startPhoto('owner', { photoId: up.photoId, sentence: 'Register every clearly visible garment in this closet photo.', scan: true });
  assert.ok('operationId' in op && op.state === 'DRAFT', 'scan operation reaches DRAFT');
  assert.equal(op.cards.length, 8);
  assert.equal(op.scan, true);

  const answers: Record<string, { color: 'black' | 'navy' | 'charcoal' | 'beige' | 'white' | 'gray' }> = {};
  for (const c of op.cards) {
    if (c.question) answers[String(c.cardId)] = { color: c.sparkColor as 'black' };
  }
  const conf = svc.confirmCards('owner', {
    operationId: op.operationId,
    eventIds: op.cards.map((_, i) => `ev-scan-${i}`),
    actor: 'human',
    expectedRevision: h.ledger.getWorkspace('owner')!.ledgerRevision,
    answers,
  });
  assert.equal(conf.ok, true);

  const view = svc.view('owner');
  assert.equal(view.items.length, 8);
  assert.equal(view.items.every((it) => it.sample === false && it.origin === 'photo'), true, 'real uploaded closet pieces are never marked sample');
  assert.deepEqual(view.items.filter((it) => it.slot === 'outer').map((it) => it.itemId), ['J1', 'J2', 'J3', 'J4']);
  assert.deepEqual(view.items.filter((it) => it.slot === 'top').map((it) => it.itemId), ['T1', 'T2', 'T3']);
  assert.deepEqual(view.items.filter((it) => it.slot === 'bottom').map((it) => it.itemId), ['B1']);

  const extras = new ExtrasStore(':memory:');
  const feat = new FeatureService({ ledger: h.ledger, extras, today: () => h.clock.today, now: () => h.clock.now, revision: 'test' });
  const ev = feat.addEvidence('owner', { itemId: 'J3', platform: 'KREAM', priceType: 'ASK', amount: 240000, currency: 'KRW', retrievedAt: h.clock.today, matchLevel: 'SIMILAR' });
  assert.equal('evidenceId' in ev, true);

  const led = feat.closetLedger('owner', []);
  assert.equal(led.pieces, 8);
  assert.equal(led.tags.J3?.amount, 240000);
  assert.equal(led.tags.J3?.source, 'owner_entered');

  const dec = feat.decisionView('owner', { itemId: 'J3', horizonDays: 90 }, []);
  assert.equal('keep' in dec, true);
  if ('keep' in dec) {
    assert.equal(dec.keep.wearsCounted, 0);
  }

  const firstLook = feat.looks()[0];
  feat.setTarget('owner', { lookId: firstLook.lookId, on: true });
  const col = feat.collection('owner');
  assert.equal(col.looks.length, 1, 'Discover matches looks against the scanned closet');
  extras.close();
  h.cleanup();
});
