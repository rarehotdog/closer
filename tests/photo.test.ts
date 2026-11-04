// Real-photo path (added 11/2): official SAM mask decoder, PNG codec, uploaded photo store,
// mask cut-out thumbnails for Spark 2. No network, no real photos (synthetic pixels only).
import { harness, heroRegistered, ROOT } from './helpers.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { officialMaskDecoder } from '../adapters/samDecoder.ts';
import { decodePng, encodePng, jpegSize } from '../engine/png.ts';
import { PhotoStore } from '../store/photos.ts';
import { cutoutPng } from '../engine/thumbs.ts';
import { encodeMockRle, normToPixelBox } from '../engine/coords.ts';
import { buildSamBody } from '../adapters/sam.ts';
import { createPhotoLibrary, PHOTO_H, PHOTO_W } from '../fixtures/photos.ts';
import { role } from '../fixtures/fxh.ts';

const dir = join(ROOT, '.data', 'test', `photos-${process.pid}`);
after(() => rmSync(dir, { recursive: true, force: true }));

/** Smallest JPEG header that carries a size (SOI + SOF0). Enough for the size check; never decoded. */
function fakeJpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}
function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return encodePng({ w, h, data });
}

test('PH-01 official decoder reads the docs\' own lossless example (27 × 60)', () => {
  const payload = "!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
  const bits = officialMaskDecoder({ h: 27, w: 60, enc: '~', payload });
  assert.equal(bits.length, 27 * 60);
  assert.equal(bits.reduce((a, b) => a + b, 0), 1539);
  assert.throws(() => officialMaskDecoder({ h: 1, w: 1, enc: '?', payload: '' }), /unknown mask encoding/);
});

test('PH-02 SAM request asks for one_bit masks', () => {
  assert.deepEqual(buildSamBody({ imageUrl: 'data:image/png;base64,AA==', prompt: 'x' }).metadata, { mask_encoding: 'one_bit' });
});

test('PH-03 PNG round trip and JPEG size header', () => {
  const data = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) & 255);
  const back = decodePng(encodePng({ w: 5, h: 3, data }));
  assert.equal(back.w, 5);
  assert.equal(back.h, 3);
  assert.deepEqual([...back.data], [...data]);
  assert.deepEqual(jpegSize(fakeJpeg(1200, 1600)), { w: 1200, h: 1600 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
});

test('PH-04 photo store keeps the two copies together and maps pixels to photo coordinates', () => {
  mkdirSync(dir, { recursive: true });
  const store = new PhotoStore(dir);
  const m = store.save('owner', fakeJpeg(1200, 1600), solidPng(600, 800, [10, 20, 30]), '2026-11-02T00:00:00Z');
  assert.match(m.photoId, /^up_[a-f0-9]{20}$/);
  const p = store.get(m.photoId)!;
  assert.equal(p.w, 1200);
  assert.equal(p.h, 1600);
  assert.deepEqual([...p.pixels.rgbAt(1199, 1599)], [10, 20, 30]);
  assert.match(p.url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(store.list('owner').map((x) => x.photoId), [m.photoId]);
  assert.deepEqual(store.list('someone-else'), []);
  assert.equal(store.delete('someone-else', m.photoId), false);
  assert.equal(store.delete('owner', m.photoId), true);
  assert.equal(store.get(m.photoId), null);
});

test('PH-05 photo store refuses what it cannot use safely', () => {
  const store = new PhotoStore(dir);
  assert.throws(() => store.save('owner', Buffer.from('nope'), solidPng(10, 10, [0, 0, 0]), 't'), /not a JPEG/);
  assert.throws(() => store.save('owner', fakeJpeg(2000, 1000), solidPng(800, 400, [0, 0, 0]), 't'), /long side over 1600/);
  assert.throws(() => store.save('owner', fakeJpeg(1200, 1600), solidPng(800, 800, [0, 0, 0]), 't'), /different shapes/);
  assert.equal(store.get('../../etc/passwd'), null);
});

test('PH-06 cut-out thumbnail: garment pixels inside the mask, transparent outside, long side ≤ 256', () => {
  const w = 400, h = 300;
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bits[y * w + x] = x < w / 2 ? 1 : 0;
  const pixels = { w: 1000, h: 1000, rgbAt: () => [200, 10, 10] as const };
  const png = decodePng(cutoutPng(pixels, { x: 50, y: 50, w, h, rle: encodeMockRle(bits) }));
  assert.equal(Math.max(png.w, png.h), 256);
  const at = (x: number, y: number) => [...png.data.subarray((y * png.w + x) * 4, (y * png.w + x) * 4 + 4)];
  assert.deepEqual(at(10, 10), [200, 10, 10, 255]);
  assert.deepEqual(at(png.w - 5, 10), [0, 0, 0, 0]);
});

test('PH-08 sample photos are PNG data URLs (the image API lists no SVG) whose bytes are the pixels code measures', () => {
  const lib = createPhotoLibrary();
  const photos = lib.list();
  assert.equal(photos.length, 3);
  const PREFIX = 'data:image/png;base64,';
  for (const p of photos) {
    assert.ok(p.url.startsWith(PREFIX), p.photoId);
    const png = decodePng(Buffer.from(p.url.slice(PREFIX.length), 'base64'));
    assert.deepEqual([png.w, png.h], [p.w, p.h]);
    assert.deepEqual([png.w, png.h], [PHOTO_W, PHOTO_H]);
    const at = (x: number, y: number) => [...png.data.subarray((y * png.w + x) * 4, (y * png.w + x) * 4 + 4)];
    // Each garment's centre carries its role colour; its top edge carries the darker outline.
    for (const g of p.garments) {
      const b = normToPixelBox(g.box, p.w, p.h);
      const cx = Math.floor((b.x1 + b.x2) / 2), cy = Math.floor((b.y1 + b.y2) / 2);
      assert.deepEqual(at(cx, cy), [...role(g.role).rgb, 255], `${p.photoId} ${g.role}`);
      assert.ok(at(cx, b.y1)[0] < role(g.role).rgb[0], `${p.photoId} ${g.role} outline`);
    }
    // The PNG and the pixel source agree, sampled on a 7 px grid (39,000 points per photo, edges and background included).
    let mismatches = 0;
    for (let y = 0; y < png.h; y += 7) for (let x = 0; x < png.w; x += 7) if (at(x, y).join() !== [...p.pixels.rgbAt(x, y), 255].join()) mismatches++;
    assert.equal(mismatches, 0, p.photoId);
    assert.equal(lib.byUrl(p.url), p);
  }
  // Encoded once per process: a second library carries the same strings.
  const again = createPhotoLibrary();
  for (const p of photos) assert.equal(again.get(p.photoId)!.url, p.url);
});

test('PH-07 Spark 2 gets cut-outs only for items registered from a photo', async () => {
  const hh = harness();
  try {
    const reg = await heroRegistered(hh);
    const state = hh.state();
    const fromPhoto = state.items.filter((i) => i.cutoutRef).map((i) => i.itemId);
    const seeded = state.items.filter((i) => !i.cutoutRef).map((i) => i.itemId);
    assert.ok(fromPhoto.length > 0, `registration op ${reg.operationId} produced items with cut-outs`);
    const th = hh.svc.thumbnailsFor([...seeded, ...fromPhoto], state);
    assert.deepEqual(th.map((t) => t.itemId).sort(), [...fromPhoto].sort().slice(0, 8));
    for (const t of th) {
      const png = decodePng(Buffer.from(t.imageUrl.split(',')[1], 'base64'));
      assert.ok(Math.max(png.w, png.h) <= 256);
    }
  } finally {
    hh.cleanup();
  }
});
