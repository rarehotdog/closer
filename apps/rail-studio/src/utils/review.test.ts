import test from 'node:test';
import assert from 'node:assert/strict';
import { FeeStructure, GarmentPiece } from '../types/closet';
import { INITIAL_GARMENTS } from '../data/seedCloset';
import { computeNetPayout } from './ledgerLogic';
import {
  buildListingDraft,
  describeLatestPrice,
  describeSumLine,
  describeWears,
  reviewCandidates,
  reviewDecision,
  reviewSums,
  tradedBand,
  toReviewRow,
} from './review';

const seed = (code: string): GarmentPiece => {
  const g = INITIAL_GARMENTS.find((x) => x.code === code);
  if (!g) throw new Error(`seed ${code} missing`);
  return g;
};

const ticked: FeeStructure = {
  platform: 'Bunjang',
  feeRatePct: 3.5,
  shippingCost: 3500,
  feeRateConfirmed: true,
  shippingConfirmed: true,
  confirmed: true,
};

const unticked: FeeStructure = {
  platform: 'Bunjang',
  feeRatePct: 3.5,
  shippingCost: 3500,
  feeRateConfirmed: false,
  shippingConfirmed: false,
  confirmed: false,
};

/** A minimal owned piece; every field a test cares about is passed in. */
const piece = (over: Partial<GarmentPiece> & { id: string; code: string }): GarmentPiece => ({
  name: 'Test piece',
  brand: '',
  category: 'knitwear',
  silhouette: 'knit',
  currency: 'KRW',
  purchasePrice: null,
  isSample: false,
  colorHex: '#6B7280',
  secondaryColorHex: '#6B7280',
  fabricLabel: 'Fabric not entered',
  hangerType: 'walnut-brass',
  wearsLast60Days: 0,
  wearLogStatus: 'verified',
  lastWornDate: null,
  observations: [],
  feeConfig: unticked,
  ...over,
});

const obs = (id: string, price: number, currency: 'KRW' | 'USD', kind: 'traded' | 'listed', date = '2026-11-01') => ({
  id,
  date,
  platform: currency === 'KRW' ? ('Bunjang' as const) : ('Grailed' as const),
  price,
  currency,
  kind,
});

const sell = { id: 'd1', choice: 'sell' as const, savedAt: '2026-11-01', snapshotPrice: 0, snapshotCurrency: 'KRW' as const, snapshotPlatform: 'Bunjang' as const };
const keep = { ...sell, id: 'd2', choice: 'keep' as const };

test('RV-01 candidates: Sell and undecided pieces are listed, Keep pieces are not, Sample is listed and flagged', () => {
  const rows = reviewCandidates([
    piece({ id: 'a', code: 'A', lastDecision: keep }),
    piece({ id: 'b', code: 'B', lastDecision: sell }),
    piece({ id: 'c', code: 'C' }),
    piece({ id: 's', code: 'S', isSample: true }),
  ]);
  assert.deepEqual(rows.map((r) => r.code), ['B', 'C', 'S']);
  assert.deepEqual(rows.map((r) => r.decision), ['sell', 'undecided', 'undecided']);
  assert.equal(rows.find((r) => r.code === 'S')?.isSample, true);
  assert.equal(reviewDecision(piece({ id: 'a', code: 'A', lastDecision: keep })), 'keep');
});

test('RV-02 order: Sell first, then the fewest counted wears, pieces with no wear log last; ties keep closet order', () => {
  const rows = reviewCandidates([
    piece({ id: 'u-nolog', code: 'U0', wearLogStatus: 'insufficient', wearsLast60Days: 0 }),
    piece({ id: 'u-3', code: 'U3', wearsLast60Days: 3 }),
    piece({ id: 's-nolog', code: 'S0', lastDecision: sell, wearLogStatus: 'insufficient', wearsLast60Days: 9 }),
    piece({ id: 's-2', code: 'S2', lastDecision: sell, wearsLast60Days: 2 }),
    piece({ id: 'u-0', code: 'U00', wearsLast60Days: 0 }),
    piece({ id: 's-0', code: 'S00', lastDecision: sell, wearsLast60Days: 0 }),
    piece({ id: 'sample', code: 'SM', isSample: true, wearsLast60Days: 5 }),
    piece({ id: 'u-nolog-2', code: 'U0b', wearLogStatus: 'insufficient' }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.code),
    ['S00', 'S2', 'S0', 'U00', 'U3', 'U0', 'SM', 'U0b'],
  );
  // A verified log with 0 wears is a count (sorts first); a missing log is unknown (null, last).
  assert.equal(rows.find((r) => r.code === 'U00')?.wears60d, 0);
  assert.equal(rows.find((r) => r.code === 'U0')?.wears60d, null);
  // A sample piece has no wear log of its own, whatever number its record carries.
  assert.equal(rows.find((r) => r.code === 'SM')?.wears60d, null);
});

test('RV-03 sums: only selected rows with a price seen and every cost line ticked are summed', () => {
  const rows = reviewCandidates([
    piece({ id: 'k-ok', code: 'K1', observations: [obs('o1', 85000, 'KRW', 'listed')], feeConfig: ticked }),
    piece({ id: 'k-unticked', code: 'K2', observations: [obs('o2', 120000, 'KRW', 'traded')], feeConfig: unticked }),
    piece({ id: 'k-noprice', code: 'K3', observations: [], feeConfig: ticked }),
    piece({ id: 'k-notselected', code: 'K4', observations: [obs('o4', 50000, 'KRW', 'traded')], feeConfig: ticked }),
  ]);
  const sums = reviewSums(rows, ['k-ok', 'k-unticked', 'k-noprice']);
  const expectedNet = computeNetPayout(85000, 3.5, 3500, true).netPayout;
  assert.equal(expectedNet, 85000 - 2975 - 3500);
  assert.deepEqual(sums.krw, {
    currency: 'KRW',
    sum: expectedNet,
    summed: 1,
    selected: 3,
    noPrice: 1,
    feeNotConfirmed: 1,
  });
  assert.deepEqual(sums.usd, { currency: 'USD', sum: 0, summed: 0, selected: 0, noPrice: 0, feeNotConfirmed: 0 });
  assert.equal(describeSumLine(sums.krw), `Net if sold at the latest price seen: ₩78,525 on 1 of 3 selected (fees checked)`);
});

test('RV-04 sums: a Sample row is never counted, even when its id is selected', () => {
  const rows = reviewCandidates([
    piece({ id: 'sample', code: 'S1', isSample: true, observations: [obs('o1', 178000, 'KRW', 'listed')], feeConfig: ticked }),
    piece({ id: 'own', code: 'K1', observations: [obs('o2', 100000, 'KRW', 'traded')], feeConfig: ticked }),
  ]);
  const sums = reviewSums(rows, ['sample', 'own']);
  assert.equal(sums.krw.selected, 1);
  assert.equal(sums.krw.summed, 1);
  assert.equal(sums.krw.sum, computeNetPayout(100000, 3.5, 3500, true).netPayout);
  const onlySample = reviewSums(rows, ['sample']);
  assert.deepEqual(onlySample.krw, { currency: 'KRW', sum: 0, summed: 0, selected: 0, noPrice: 0, feeNotConfirmed: 0 });
});

test('RV-05 sums: KRW and USD are kept apart; there is no combined total', () => {
  const usdTicked: FeeStructure = { ...ticked, platform: 'Grailed', feeRatePct: 9, shippingCost: 14 };
  const rows = reviewCandidates([
    piece({ id: 'k', code: 'K1', observations: [obs('o1', 100000, 'KRW', 'traded')], feeConfig: ticked }),
    piece({ id: 'u', code: 'U1', currency: 'USD', observations: [obs('o2', 210, 'USD', 'traded')], feeConfig: usdTicked }),
  ]);
  const sums = reviewSums(rows, new Set(['k', 'u']));
  assert.equal(sums.krw.sum, computeNetPayout(100000, 3.5, 3500, true).netPayout);
  assert.equal(sums.usd.sum, computeNetPayout(210, 9, 14, true).netPayout);
  assert.deepEqual(Object.keys(sums).sort(), ['krw', 'usd']);
  assert.equal(describeSumLine(sums.usd), 'Net if sold at the latest price seen: $177 on 1 of 1 selected (fees checked)');
});

test('RV-06 a price in another currency is not a price seen for the piece', () => {
  const row = toReviewRow(piece({ id: 'k', code: 'K1', observations: [obs('o1', 150, 'USD', 'traded')], feeConfig: ticked }));
  assert.equal(row.latest, null);
  assert.equal(row.net, null);
  assert.equal(describeLatestPrice(row), 'No price seen');
});

test('RV-07 wear and price lines are counted facts, never 0 for a missing log', () => {
  assert.equal(describeWears({ wears60d: null, lastWornDate: null }), 'No wear log');
  assert.equal(describeWears({ wears60d: 0, lastWornDate: null }), '0 wears · 60 days');
  assert.equal(describeWears({ wears60d: 1, lastWornDate: '2026-09-18' }), '1 wear · 60 days · last worn 2026-09-18');
  assert.equal(describeWears({ wears60d: 2, lastWornDate: '2026-09-28' }), '2 wears · 60 days · last worn 2026-09-28');
  assert.equal(describeLatestPrice(toReviewRow(seed('J1'))), '₩275,000 · KREAM · trade · 2026-11-03');
  assert.equal(describeLatestPrice(toReviewRow(seed('S1'))), '₩178,000 · KREAM · ask · Sample · 2026-10-10');
  assert.deepEqual(tradedBand(seed('T2')), { min: 185, max: 210, count: 2 });
  assert.deepEqual(tradedBand(seed('S1')), { min: null, max: null, count: 0 });
});

test('RV-08 the sample closet: 4 candidates in review order, nothing summed while no cost line is ticked', () => {
  const rows = reviewCandidates(INITIAL_GARMENTS);
  assert.deepEqual(rows.map((r) => r.code), ['T3', 'T2', 'K1', 'S1']);
  assert.deepEqual(rows.map((r) => r.decision), ['sell', 'sell', 'undecided', 'undecided']);
  const sums = reviewSums(rows, rows.map((r) => r.id));
  assert.equal(sums.usd.selected, 3);
  assert.equal(sums.usd.summed, 0);
  assert.equal(sums.usd.sum, 0);
  assert.equal(sums.usd.feeNotConfirmed, 3);
  assert.equal(sums.krw.selected, 0); // S1 is the sample piece: listed, never counted
});

test('RV-09 the listing draft is the inspector text: ask = latest price seen, else purchase price, else [VERIFY]', () => {
  assert.equal(
    buildListingDraft(seed('T3')),
    `[VELVETICA ARCHIVE] Forest Pine Oversized Loopback Hoodie (T3)
· Target Ask Price: $199 (StockX)
· Fabric / Condition: 600gsm Heavy Fleece / Mint (S)
· Size / Measurements: [VERIFY: Tag Size & Measurements]
· Provenance / Packaging: [VERIFY: Original Receipt / Tags]`,
  );
  const noPrice = buildListingDraft(piece({ id: 'x', code: 'X1', name: 'navy jacket' }));
  assert.match(noPrice, /^\[\[VERIFY: Brand\]\] navy jacket \(X1\)\n· Target Ask Price: \[VERIFY: Asking Price\]/);
  assert.match(noPrice, /\[VERIFY: Condition Grade\]/);
  const paidOnly = buildListingDraft(piece({ id: 'y', code: 'Y1', purchasePrice: 90000, feeConfig: { ...unticked, platform: 'Karrot' } }));
  assert.match(paidOnly, /· Target Ask Price: ₩90,000 \(Karrot\)/);
});
