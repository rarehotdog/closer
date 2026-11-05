// The rail (11/5): the 3D closet's first view hangs every piece on one rail. These tests pin what may appear
// on it: a tag only for a price row the closet ledger already holds, the amount as held, a Sample mark on
// sample rows, nothing for pieces without a price, and every piece placed once.
import './helpers.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain browser module without type declarations; the same file the rail screen imports
import * as railJs from '../web/public/rail.js';
import { closetLedger } from '../engine/ledger.ts';
import { closetItems, sampleEvidence } from '../fixtures/closet.ts';
import { ROOT } from './helpers.ts';

type Tag = { amount: number; currency: string; sample: boolean; traded: boolean; platform: string };
type Spot = { itemId: string; slot: string; type: string; x: number; tag: Tag | null };
type Layout = { hanging: Spot[]; shoes: Spot[]; railLength: number };
const { RAIL, railLayout, tagOf, tagWords, rotationHeatOf } = railJs as {
  RAIL: { spacing: number; shoeSpacing: number; railY: number; margin: number };
  railLayout: (pieces: unknown, tags: unknown, opts?: unknown) => Layout & { hanging: (Spot & { heat?: { tier: string; wears: number }; spotlight?: boolean })[] };
  tagOf: (row: unknown) => Tag | null;
  tagWords: (tag: Tag | null, money: (n: number, c: string) => string) => { amount: string; mark: string } | null;
  rotationHeatOf: (meta: unknown) => { tier: string; wears: number; shortLabel: string; detailLabel: string };
};

const money = (n: number, c: string) => `${c} ${n}`;
const piece = (itemId: string, slot: string, type = 'tee') => ({ itemId, slot, type });

describe('R rail: placement and tags', () => {
  it('R-01 outerwear, then tops, then bottoms hang in one row in the order given; shoes stand apart; every piece once', () => {
    const L = railLayout([piece('T1', 'top'), piece('S1', 'shoes'), piece('J1', 'outer'), piece('B1', 'bottom'), piece('J2', 'outer'), piece('T2', 'top'), piece('S2', 'shoes')], null);
    assert.deepEqual(L.hanging.map((h) => h.itemId), ['J1', 'J2', 'T1', 'T2', 'B1']);
    assert.deepEqual(L.shoes.map((s) => s.itemId), ['S1', 'S2']);
    const xs = L.hanging.map((h) => h.x);
    for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - RAIL.spacing) < 1e-9, 'hooks are evenly spaced');
    assert.ok(Math.abs(xs[0] + xs[xs.length - 1]) < 1e-9, 'the row is centred on the rail');
    assert.ok(L.railLength >= xs[xs.length - 1] - xs[0] + 2 * RAIL.margin - 1e-9, 'the rail reaches past the first and last hook');
    assert.equal(railLayout([], null).hanging.length, 0);
    assert.equal(railLayout(null as never, null).shoes.length, 0);
  });

  it('R-02 a tag only where the ledger holds a usable price row; none for a missing, zero, negative, non-finite or unknown-currency row', () => {
    const tags = {
      A: { amount: 120000, currency: 'KRW', source: 'sample', priceType: 'ASK', platform: 'KARROT', platformName: 'Karrot (당근)' },
      B: { amount: 68, currency: 'USD', source: 'owner_entered', priceType: 'TRADE', platform: 'EBAY', platformName: 'eBay' },
      C: { amount: 0, currency: 'KRW', source: 'owner_entered' },
      D: { amount: -5, currency: 'KRW', source: 'owner_entered' },
      E: { amount: Number.NaN, currency: 'KRW', source: 'owner_entered' },
      F: { amount: 10, currency: 'JPY', source: 'owner_entered' },
    };
    const L = railLayout(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => piece(id, 'top')), tags);
    const by = Object.fromEntries(L.hanging.map((h) => [h.itemId, h.tag]));
    assert.deepEqual(by.A, { amount: 120000, currency: 'KRW', sample: true, traded: false, platform: 'Karrot' });
    assert.deepEqual(by.B, { amount: 68, currency: 'USD', sample: false, traded: true, platform: 'eBay' });
    for (const id of ['C', 'D', 'E', 'F', 'G']) assert.equal(by[id], null, `${id} carries no tag`);
    assert.equal(tagOf(undefined), null);
  });

  it('R-03 the words on a tag are the amount as held and a Sample mark for sample rows; nothing is computed', () => {
    assert.deepEqual(tagWords(tagOf({ amount: 58000, currency: 'KRW', source: 'sample' }), money), { amount: 'KRW 58000', mark: 'SAMPLE' });
    assert.deepEqual(tagWords(tagOf({ amount: 90, currency: 'EUR', source: 'owner_entered' }), money), { amount: 'EUR 90', mark: '' });
    assert.equal(tagWords(null, money), null);
  });

  it('R-04 on the sample closet the rail tags are exactly the ledger tags: same pieces, same amounts and currencies, Sample marked', () => {
    const items = closetItems();
    const L = closetLedger({ items, evidence: sampleEvidence('2026-11-05'), decisions: [], reviewRows: [] });
    const rail = railLayout(items.map((i) => ({ itemId: i.itemId, slot: i.slot, type: i.type })), L.tags);
    const all = [...rail.hanging, ...rail.shoes];
    assert.equal(all.length, items.length, 'every piece is on the rail or under it, once');
    assert.equal(new Set(all.map((x) => x.itemId)).size, items.length);
    const tagged = all.filter((x) => x.tag).map((x) => x.itemId).sort();
    assert.deepEqual(tagged, Object.keys(L.tags).sort(), 'tags exactly where the ledger has a row');
    for (const x of all) {
      if (!x.tag) continue;
      const row = L.tags[x.itemId];
      assert.equal(x.tag.amount, row.amount);
      assert.equal(x.tag.currency, row.currency);
      assert.equal(x.tag.sample, row.source === 'sample');
    }
    assert.ok(tagged.length < items.length, 'pieces without a price stay untagged');
  });

  it('R-05 all 17 side-hung 3/4 boutique garment studio PNGs exist, are portrait, and carry no EXIF', () => {
    const keys = [
      'coat', 'overcoat', 'blazer', 'puffer', 'blouson', 'work',
      'knit', 'cardigan', 'crew', 'shirt', 'tee', 'hoodie',
      'trousers', 'slacks', 'jeans', 'chinos', 'joggers',
    ];
    for (const k of keys) {
      const p = join(ROOT, 'web/public/photos', `side-${k}.png`);
      const buf = readFileSync(p);
      assert.equal(buf.subarray(0, 4).toString('hex'), '89504e47', `side-${k}.png is a valid PNG`);
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      assert.ok(w >= 40 && h >= 350 && w < h * 0.65, `side-${k}.png has portrait side-profile dimensions (${w}x${h})`);
      assert.equal(buf.includes(Buffer.from('eXIf')), false, `side-${k}.png carries no eXIf chunk`);
      assert.equal(buf.includes(Buffer.from('Exif\0\0')), false, `side-${k}.png carries no Exif marker`);
    }
  });

  it('R-06 rotationHeatOf classifies pieces strictly by counted wears and 60-day review status with zero probabilities', () => {
    assert.deepEqual(rotationHeatOf({ wearCount: 4, review: 'RECENT_WEAR' }), {
      tier: 'hot',
      wears: 4,
      shortLabel: '4x · Active',
      detailLabel: '4 confirmed wears',
    });
    assert.deepEqual(rotationHeatOf({ wearCount: 1, review: 'RECENT_WEAR' }), {
      tier: 'warm',
      wears: 1,
      shortLabel: '1x',
      detailLabel: '1 confirmed wear',
    });
    assert.deepEqual(rotationHeatOf({ wearCount: 0, review: 'CANDIDATE' }), {
      tier: 'cold',
      wears: 0,
      shortLabel: '0x · Review',
      detailLabel: '0 confirmed wears in 60d',
    });
    assert.deepEqual(rotationHeatOf({ wearCount: 0, review: 'INSUFFICIENT_HISTORY' }), {
      tier: 'fresh',
      wears: 0,
      shortLabel: '0x',
      detailLabel: 'No confirmed wear yet',
    });
  });

  it('R-07 railLayout sort modes (review, worn, priced) preserve all pieces once and spotlight review candidates at centre', () => {
    const items = [
      { itemId: 'J1', slot: 'outer', type: 'jacket', wearCount: 5, review: 'RECENT_WEAR' },
      { itemId: 'T1', slot: 'top', type: 'tee', wearCount: 0, review: 'CANDIDATE' },
      { itemId: 'T2', slot: 'top', type: 'knit', wearCount: 2, review: 'RECENT_WEAR' },
      { itemId: 'B1', slot: 'bottom', type: 'jeans', wearCount: 0, review: 'CANDIDATE' },
      { itemId: 'B2', slot: 'bottom', type: 'trousers', wearCount: 1, review: 'RECENT_WEAR' },
      { itemId: 'S1', slot: 'shoes', type: 'sneakers', wearCount: 3, review: 'RECENT_WEAR' },
    ];
    const tags = {
      T2: { amount: 90000, currency: 'KRW', source: 'sample', priceType: 'ASK', platform: 'KARROT' },
      B2: { amount: 140000, currency: 'KRW', source: 'owner_entered', priceType: 'TRADE', platform: 'KREAM' },
    };

    const byWorn = railLayout(items, tags, { sort: 'worn', withHeat: true });
    assert.deepEqual(byWorn.hanging.map((h) => h.itemId), ['J1', 'T2', 'B2', 'T1', 'B1']);

    const byPriced = railLayout(items, tags, { sort: 'priced' });
    assert.equal(byPriced.hanging[0].itemId, 'B2', 'owner-entered price comes first');
    assert.equal(byPriced.hanging[1].itemId, 'T2', 'sample price comes second');

    const byReview = railLayout(items, tags, { sort: 'review', withHeat: true });
    assert.equal(byReview.hanging.length, 5);
    assert.equal(new Set(byReview.hanging.map((h) => h.itemId)).size, 5);
    assert.equal(byReview.hanging[2].itemId, 'T1', 'first review candidate sits dead-centre on odd count');
    assert.equal(byReview.hanging[2].spotlight, true);
    assert.equal(byReview.hanging[3].itemId, 'B1', 'second review candidate flanks centre');
    assert.equal(byReview.hanging[3].spotlight, true);
  });
});
