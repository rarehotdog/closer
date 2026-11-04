// Real-photo path (added 11/2): official SAM mask decoder, PNG codec, uploaded photo store,
// mask cut-out thumbnails for Spark 2. No network, no real photos (synthetic pixels only).
import { harness, heroRegistered, ROOT } from './helpers.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { officialMaskDecoder } from '../adapters/samDecoder.ts';
import { decodePng, encodePng, jpegSize } from '../engine/png.ts';
import { PhotoStore, stripJpegMetadata } from '../store/photos.ts';
import { cutoutPng } from '../engine/thumbs.ts';
import { encodeMockRle } from '../engine/coords.ts';
import { buildSamBody } from '../adapters/sam.ts';

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

test('PH-08 the store strips APP1 (Exif, XMP), APP13 and comment segments before writing and keeps the picture bytes', () => {
  const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = seg(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1'));
  const exif = seg(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\x08 gps and camera fields', 'latin1'));
  const xmp = seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1'));
  const iptc = seg(0xed, Buffer.from('Photoshop 3.0\u00008BIM caption', 'latin1'));
  const com = seg(0xfe, Buffer.from('a comment', 'latin1'));
  const dqt = seg(0xdb, Buffer.alloc(65, 1));
  const sof = seg(0xc0, Buffer.from([0x08, 1600 >> 8, 1600 & 255, 1200 >> 8, 1200 & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  const scan = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd9])]); // entropy data with a stuffed byte, then EOI
  const dirty = Buffer.concat([soi, app0, exif, xmp, iptc, dqt, com, sof, scan]);
  const clean = stripJpegMetadata(dirty);
  assert.ok(clean.equals(Buffer.concat([soi, app0, dqt, sof, scan])), 'exactly the picture segments, in order');
  for (const needle of ['Exif\0\0', 'xmpmeta', 'Photoshop', 'a comment']) assert.ok(!clean.includes(Buffer.from(needle, 'latin1')), needle);
  assert.deepEqual(jpegSize(clean), { w: 1200, h: 1600 });
  assert.ok(stripJpegMetadata(clean).equals(clean), 'a clean file is returned unchanged');
  assert.ok(stripJpegMetadata(Buffer.from('not a jpeg')).equals(Buffer.from('not a jpeg')));
  // Through the store: what reaches the disk and the data URL the models get has no Exif segment.
  mkdirSync(dir, { recursive: true });
  const store = new PhotoStore(dir);
  const m = store.save('owner', dirty, solidPng(600, 800, [1, 2, 3]), '2026-11-04T00:00:00Z');
  const onDisk = store.jpegBytes(m.photoId)!;
  assert.ok(onDisk.equals(clean));
  assert.ok(!onDisk.includes(Buffer.from('Exif\0\0', 'latin1')));
  assert.ok(!Buffer.from(store.get(m.photoId)!.url.split(',')[1], 'base64').includes(Buffer.from('Exif\0\0', 'latin1')));
  assert.equal(store.delete('owner', m.photoId), true);
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
