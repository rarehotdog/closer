import test from 'node:test';
import assert from 'node:assert/strict';
import { GarmentPiece, PriceObservation } from '../types/closet';
import { NO_PRICE_TEXT, NO_WEAR_LOG_TEXT, tagForm, wearText } from './tagForms';

function piece(over: Partial<GarmentPiece> = {}): GarmentPiece {
  return {
    id: 'piece-x',
    code: 'X1',
    name: 'Wool coat',
    brand: '',
    category: 'outerwear',
    silhouette: 'overcoat',
    currency: 'KRW',
    purchasePrice: null,
    isSample: false,
    colorHex: '#333333',
    secondaryColorHex: '#333333',
    fabricLabel: 'Fabric not entered',
    hangerType: 'walnut-brass',
    wearsLast60Days: 0,
    wearLogStatus: 'insufficient',
    observations: [],
    feeConfig: { platform: 'Karrot', feeRatePct: 0, shippingCost: 0, confirmed: false },
    ...over,
  };
}

function seen(price: number, currency: 'KRW' | 'USD', extra: Partial<PriceObservation> = {}): PriceObservation {
  return { id: `obs-${price}`, date: '2026-11-01', platform: 'KREAM', price, currency, kind: 'traded', ...extra };
}

test('TF-01 no price on record: a "No price seen" tag with no amount and no currency sign', () => {
  const f = tagForm(piece());
  assert.equal(f.kind, 'no-price');
  assert.equal(f.priceText, NO_PRICE_TEXT);
  assert.equal(f.platform, null);
  assert.doesNotMatch(f.priceText, /[0-9₩$]/);
  // a purchase price alone is not a price seen
  assert.equal(tagForm(piece({ purchasePrice: 290000 })).kind, 'no-price');
});

test('TF-02 a price seen: the amount in its own currency, the platform, ask and Sample marks', () => {
  const krw = tagForm(piece({ observations: [seen(1360000, 'KRW')] }));
  assert.deepEqual([krw.kind, krw.priceText, krw.platform, krw.ask, krw.samplePrice], ['price', '₩1,360,000', 'KREAM', false, false]);
  const usd = tagForm(piece({ currency: 'USD', observations: [seen(215, 'USD', { kind: 'listed', isSample: true, platform: 'Grailed' })] }));
  assert.deepEqual([usd.kind, usd.priceText, usd.platform, usd.ask, usd.samplePrice], ['price', '$215', 'Grailed', true, true]);
});

test('TF-03 currencies never mix: a price seen in another currency is not this piece\'s price', () => {
  const f = tagForm(piece({ currency: 'KRW', observations: [seen(215, 'USD')] }));
  assert.equal(f.kind, 'no-price');
  assert.equal(f.priceText, NO_PRICE_TEXT);
});

test('TF-04 no wear log: a hollow dot and "No wear log", never a 0', () => {
  const f = tagForm(piece({ wearLogStatus: 'insufficient', wearsLast60Days: 0 }));
  assert.deepEqual([f.hollow, f.wears, f.wearText], [true, null, NO_WEAR_LOG_TEXT]);
  // a "verified" status without a usable count is still no log
  const broken = tagForm(piece({ wearLogStatus: 'verified', wearsLast60Days: Number.NaN }));
  assert.deepEqual([broken.hollow, broken.wears, broken.wearText], [true, null, NO_WEAR_LOG_TEXT]);
  assert.equal(wearText(null), NO_WEAR_LOG_TEXT);
});

test('TF-05 a verified log is counted: "0 wears · 60d", "1 wear · 60d", "k wears · 60d"', () => {
  const zero = tagForm(piece({ wearLogStatus: 'verified', wearsLast60Days: 0 }));
  assert.deepEqual([zero.hollow, zero.wears, zero.wearText], [false, 0, '0 wears · 60d']);
  assert.equal(tagForm(piece({ wearLogStatus: 'verified', wearsLast60Days: 1 })).wearText, '1 wear · 60d');
  assert.equal(tagForm(piece({ wearLogStatus: 'verified', wearsLast60Days: 6 })).wearText, '6 wears · 60d');
  // a missing status counts as verified, as everywhere else in the ledger
  assert.equal(tagForm(piece({ wearLogStatus: undefined, wearsLast60Days: 3 })).wearText, '3 wears · 60d');
});

test('TF-06 a piece from a photo scan (no price, no wear log) carries both forms at once', () => {
  const f = tagForm(piece({ id: 'scan-1-0', observations: [], wearLogStatus: 'insufficient' }));
  assert.deepEqual([f.kind, f.hollow, f.priceText, f.wearText], ['no-price', true, NO_PRICE_TEXT, NO_WEAR_LOG_TEXT]);
});
