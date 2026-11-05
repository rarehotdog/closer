import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ledger from './ledgerLogic';
import {
  buildPlatformDotStrips,
  compute30DayRotationTrend,
  computeGarmentRotationHeat,
  computeLedgerSummary,
  computeNetPayout,
  computeSameSeriesSparkline,
  countRotationTiers,
  createHungPiece,
  daysBetween,
  defaultAskPrice,
  describePhotoSource,
  evaluatePreCheckoutGate,
  evaluateTargetLook,
  feeLinesConfirmed,
  filterObservationsByWindow,
  formatCurrency,
  formatShortDate,
  formatSignedCurrency,
  hasFactsMoved,
  hasPriceBasis,
  isKeptAfterReload,
  NEUTRAL_DECISION_BADGE,
  parseQuickOrderLine,
  summarizeKeepSellEvidence,
} from './ledgerLogic';
import { FeeStructure, GarmentPiece } from '../types/closet';
import {
  INITIAL_GARMENTS,
  platformsForCurrency,
  TARGET_LOOKS,
} from '../data/seedCloset';

const checkedFees = (
  fc: Omit<FeeStructure, 'feeRateConfirmed' | 'shippingConfirmed' | 'confirmed'>,
): FeeStructure => ({
  ...fc,
  feeRateConfirmed: true,
  shippingConfirmed: true,
  confirmed: true,
});

const uncheckedFees = (
  fc: Omit<FeeStructure, 'feeRateConfirmed' | 'shippingConfirmed' | 'confirmed'>,
): FeeStructure => ({
  ...fc,
  feeRateConfirmed: false,
  shippingConfirmed: false,
  confirmed: false,
});

const seed = (code: string): GarmentPiece => {
  const g = INITIAL_GARMENTS.find((x) => x.code === code);
  if (!g) throw new Error(`seed ${code} missing`);
  return g;
};

/** A piece with both of its own cost lines ticked, as an owner would do in the drawer. */
const withCheckedFees = (g: GarmentPiece): GarmentPiece => ({
  ...g,
  feeConfig: {
    ...g.feeConfig,
    feeRateConfirmed: true,
    shippingConfirmed: true,
    confirmed: true,
  },
});

/** A piece as the photo scan hangs it: a cut-out, no price, no purchase price, no wear log. */
const scannedPiece = (over: Partial<GarmentPiece> = {}): GarmentPiece => ({
  id: 'scan-1700000000000-1',
  code: 'J5',
  name: 'navy jacket',
  brand: '',
  category: 'blazer',
  silhouette: 'blazer',
  currency: 'KRW',
  purchasePrice: null,
  isSample: false,
  colorHex: '#1E2852',
  secondaryColorHex: '#1E2852',
  fabricLabel: 'Fabric not entered',
  hangerType: 'walnut-brass',
  wearsLast60Days: 0,
  wearLogStatus: 'insufficient',
  lastWornDate: null,
  lockedForToday: false,
  imageUrl: 'data:image/png;base64,AAAA',
  frontImageUrl: 'data:image/png;base64,AAAA',
  cutoutSource: 'sam-mask',
  scanMode: 'fake',
  observations: [],
  // As ScanPhotoModal builds it: no per-line flags at all (older stored pieces look like this too).
  feeConfig: { platform: 'Karrot', feeRatePct: 0, shippingCost: 0, confirmed: false },
  ...over,
});

const mockGarments: GarmentPiece[] = [
  {
    id: 'g-1',
    code: 'J1',
    name: 'Double-Faced Cashmere Overcoat',
    brand: 'AURELIER',
    category: 'outerwear',
    silhouette: 'overcoat',
    currency: 'KRW',
    purchasePrice: 1480000,
    isSample: false,
    colorHex: '#C19A6B',
    secondaryColorHex: '#9E7B4F',
    fabricLabel: '100% Cashmere',
    hangerType: 'walnut-brass',
    wearsLast60Days: 8,
    wearLogStatus: 'verified',
    lastWornDate: '2026-11-01',
    conditionGrade: 'Mint (S)',
    observations: [
      {
        id: 'o-1',
        date: '2026-09-10',
        platform: 'KREAM',
        price: 1120000,
        currency: 'KRW',
        kind: 'traded',
      },
      {
        id: 'o-2',
        date: '2026-11-02',
        platform: 'KREAM',
        price: 1240000,
        currency: 'KRW',
        kind: 'traded',
      },
    ],
    feeConfig: checkedFees({
      platform: 'KREAM',
      feeRatePct: 5.0,
      shippingCost: 4000,
    }),
    lastDecision: {
      id: 'd-1',
      choice: 'keep',
      savedAt: '2026-10-01',
      snapshotPrice: 1120000,
      snapshotCurrency: 'KRW',
      snapshotPlatform: 'KREAM',
    },
  },
  {
    id: 'g-2',
    code: 'T1',
    name: 'Heavyweight Washed Fleece Hoodie',
    brand: 'VELVETICA ARCHIVE',
    category: 'hoodie',
    silhouette: 'hoodie',
    currency: 'USD',
    purchasePrice: 240,
    isSample: false,
    colorHex: '#3B3D40',
    secondaryColorHex: '#282A2C',
    fabricLabel: '620gsm Cotton Fleece',
    hangerType: 'walnut-brass',
    wearsLast60Days: 0,
    wearLogStatus: 'insufficient',
    observations: [
      {
        id: 'o-3',
        date: '2026-10-20',
        platform: 'Grailed',
        price: 199,
        currency: 'USD',
        kind: 'listed',
      },
    ],
    feeConfig: uncheckedFees({
      platform: 'Grailed',
      feeRatePct: 9.0,
      shippingCost: 15,
    }),
  },
  {
    id: 'g-sample',
    code: 'S1',
    name: 'Sample Archive Blazer',
    brand: 'SAMPLE STUDIO',
    category: 'blazer',
    silhouette: 'blazer',
    currency: 'KRW',
    purchasePrice: null,
    isSample: true,
    colorHex: '#1D2939',
    secondaryColorHex: '#101828',
    fabricLabel: 'Wool Silk',
    hangerType: 'brushed-brass',
    wearsLast60Days: 0,
    observations: [
      {
        id: 'o-4',
        date: '2026-11-01',
        platform: 'Bunjang',
        price: 178000,
        currency: 'KRW',
        kind: 'listed',
        isSample: true,
      },
    ],
    feeConfig: checkedFees({
      platform: 'Bunjang',
      feeRatePct: 3.5,
      shippingCost: 3500,
    }),
  },
];

/** Collects every string value in an object tree. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

// ---------------------------------------------------------------------------
// Ledger totals
// ---------------------------------------------------------------------------

test('computeLedgerSummary separates KRW and USD and never adds Sample prices to owned totals', () => {
  const summary = computeLedgerSummary(mockGarments);

  assert.equal(summary.totalOwnedPieces, 2);
  assert.equal(summary.totalSamplePieces, 1);

  assert.equal(summary.krw.ownedTotalLatest, 1240000);
  assert.equal(summary.krw.ownedSeenCount, 1);
  assert.equal(summary.krw.ownedTotalPieces, 1);

  assert.equal(summary.krw.sampleTotalLatest, 178000);
  assert.equal(summary.krw.sampleSeenCount, 1);

  assert.equal(summary.usd.ownedTotalLatest, 199);
  assert.equal(summary.usd.ownedSeenCount, 1);
  assert.equal(summary.usd.ownedTotalPieces, 1);
});

test('seed closet: decision counts expose the undecided piece and its denominator', () => {
  const summary = computeLedgerSummary(INITIAL_GARMENTS);
  assert.equal(summary.keepCount, 6);
  assert.equal(summary.sellCount, 2);
  assert.equal(summary.undecidedCount, 1);
  assert.equal(summary.totalOwnedPieces, 9);
  assert.equal(
    summary.keepCount + summary.sellCount + summary.undecidedCount,
    summary.totalOwnedPieces,
  );
});

test('seed closet: no seeded fee line is pre-ticked, so no net payout is counted until the owner checks both lines', () => {
  for (const g of INITIAL_GARMENTS) {
    assert.equal(g.feeConfig.feeRateConfirmed, false, `${g.code} fee rate`);
    assert.equal(g.feeConfig.shippingConfirmed, false, `${g.code} shipping`);
    assert.equal(g.feeConfig.confirmed, false, `${g.code} confirmed`);
  }
  const summary = computeLedgerSummary(INITIAL_GARMENTS);
  assert.equal(summary.krw.confirmedNetCount, 0);
  assert.equal(summary.usd.confirmedNetCount, 0);
});

test('seed closet: the simulation fields that fed probabilities are gone', () => {
  for (const g of INITIAL_GARMENTS) {
    assert.equal('unsoldCompCount' in g, false, g.code);
    assert.equal('avgDaysToSell' in g, false, g.code);
  }
});

test('seed closet: no weather or "not worn for N days" claim is stated as an upcoming occasion', () => {
  for (const g of INITIAL_GARMENTS) {
    for (const occ of g.upcomingOccasions ?? []) {
      assert.equal(/°C|season|window|replaced|for \d+ days/i.test(occ), false, `${g.code}: ${occ}`);
    }
  }
});

test('feeLinesConfirmed needs both cost lines ticked; a missing tick counts as not ticked', () => {
  assert.equal(feeLinesConfirmed(true, true), true);
  assert.equal(feeLinesConfirmed(true, false), false);
  assert.equal(feeLinesConfirmed(false, true), false);
  assert.equal(feeLinesConfirmed(undefined, true), false);
  assert.equal(feeLinesConfirmed(true, undefined), false);
});

test('computeNetPayout returns net only when fee structure is confirmed', () => {
  const confirmedRes = computeNetPayout(100000, 5, 3000, true);
  assert.equal(confirmedRes.status, 'confirmed');
  assert.equal(confirmedRes.feeAmount, 5000);
  assert.equal(confirmedRes.netPayout, 92000);

  const unconfirmedRes = computeNetPayout(199, 9, 15, false);
  assert.equal(unconfirmedRes.status, 'unconfirmed');
  assert.equal(unconfirmedRes.netPayout, null);

  // No price at all: nothing to compute, even with confirmed fees.
  assert.equal(computeNetPayout(null, 5, 3000, true).netPayout, null);
});

test('hasFactsMoved detects when latest price differs from decision snapshot price', () => {
  assert.equal(hasFactsMoved(mockGarments[0]), true);
  assert.equal(hasFactsMoved(mockGarments[1]), false);
});

// ---------------------------------------------------------------------------
// No default asking price without a price on record
// ---------------------------------------------------------------------------

test('a scanned piece with no price on record has no default ask (never 100)', () => {
  const piece = scannedPiece();
  assert.equal(defaultAskPrice(piece), null);
  assert.equal(hasPriceBasis(piece), false);

  const ev = summarizeKeepSellEvidence(piece, null, TARGET_LOOKS);
  assert.equal(ev.sellScenario.askPrice, null);
  assert.equal(ev.sellScenario.status, 'no_price_records');
  assert.equal(ev.sellScenario.netPayoutInfo.netPayout, null);
  assert.equal(ev.sellScenario.askDeltaPctFromLatest, null);

  // Even with both cost lines ticked there is no payout: there is no price to sell at.
  const checked = summarizeKeepSellEvidence(withCheckedFees(piece), null, TARGET_LOOKS);
  assert.equal(checked.sellScenario.askPrice, null);
  assert.equal(checked.sellScenario.netPayoutInfo.netPayout, null);

  const rows = buildPlatformDotStrips(withCheckedFees(piece), null);
  assert.equal(rows.every((r) => r.conditionalNetAtAsk === null), true);
  assert.equal(rows.some((r) => r.isRecommendedNet), false);
  assert.equal(JSON.stringify(ev).includes('"askPrice":100'), false);
});

test('the default ask is the latest price seen, else the purchase price', () => {
  assert.equal(defaultAskPrice(seed('J2')), 1360000);
  assert.equal(defaultAskPrice(scannedPiece({ purchasePrice: 450000 })), 450000);
  assert.equal(hasPriceBasis(scannedPiece({ purchasePrice: 450000 })), true);
  // A bad ask falls back to the same basis, never to an invented number.
  assert.equal(
    summarizeKeepSellEvidence(seed('J2'), Number.NaN, TARGET_LOOKS).sellScenario.askPrice,
    1360000,
  );
});

// ---------------------------------------------------------------------------
// Price change: same platform and kind only
// ---------------------------------------------------------------------------

test('filterObservationsByWindow computes a delta between records of the same platform and kind', () => {
  const res = filterObservationsByWindow(
    mockGarments[0].observations,
    'KRW',
    'all',
    '2026-11-05',
  );
  assert.equal(res.first?.price, 1120000);
  assert.equal(res.latest?.price, 1240000);
  assert.equal(res.seriesCount, 2);
  assert.equal(res.deltaAmount, 120000);
  assert.equal(formatCurrency(1240000, 'KRW'), '₩1,240,000');
});

test('filterObservationsByWindow gives no cross-platform delta (T1: Musinsa trade vs Karrot ask)', () => {
  const t1 = seed('T1');
  const res = filterObservationsByWindow(t1.observations, 'KRW', 'all');
  assert.equal(res.latest?.platform, 'Karrot');
  assert.equal(res.latest?.kind, 'listed');
  assert.equal(res.seriesCount, 1);
  assert.equal(res.deltaAmount, null);
  assert.equal(res.deltaPct, null);
});

test('filterObservationsByWindow compares J1 KREAM trade with the earlier KREAM trade only', () => {
  const res = filterObservationsByWindow(seed('J1').observations, 'KRW', 'all');
  assert.equal(res.latest?.platform, 'KREAM');
  assert.equal(res.seriesFirst?.id, 'obs-j1-1');
  assert.equal(res.seriesCount, 2);
  assert.equal(res.deltaAmount, 275000 - 235000);
});

test('evaluateTargetLook counts pieces with their denominator and no percentage', () => {
  const look = {
    id: 'look-1',
    title: 'Autumn Gallery Opening',
    occasion: 'Evening',
    pieceIds: ['J1', 'T1', 'B99'],
  };
  const status = evaluateTargetLook(look, mockGarments);
  assert.equal(status.ownedCount, 2);
  assert.equal(status.totalRequired, 3);
  assert.equal(status.isComplete, false);
  assert.equal('coveragePct' in status, false);
});

// ---------------------------------------------------------------------------
// Ledger sparkline: one platform & kind, a change only with 2+ records
// ---------------------------------------------------------------------------

test('ledger sparkline uses only the latest record\'s platform and kind (J3: 3 KREAM trades, +14.5%)', () => {
  const s = computeSameSeriesSparkline(seed('J3'));
  assert.equal(s.status, 'series');
  assert.equal(s.platform, 'KREAM');
  assert.equal(s.kind, 'traded');
  assert.equal(s.count, 3);
  assert.deepEqual(
    s.points.map((p) => p.price),
    [1790000, 1940000, 2050000],
  );
  assert.equal(s.deltaAmount, 260000);
  assert.equal(s.deltaPct, 14.5);
  assert.equal(s.direction, 'up');
});

test('ledger sparkline never joins platforms or invents a baseline point (T1: 1 Karrot ask, no change)', () => {
  const s = computeSameSeriesSparkline(seed('T1'));
  assert.equal(s.status, 'single');
  assert.equal(s.count, 1);
  assert.equal(s.points.length, 1);
  assert.equal(s.points[0].price, 255000);
  assert.equal(s.deltaAmount, null);
  assert.equal(s.deltaPct, null);
  assert.equal(s.direction, null);
  // The old fabricated "2026-10-06" baseline point is gone.
  assert.equal(s.points.some((p) => p.date === '2026-10-06'), false);

  for (const g of INITIAL_GARMENTS) {
    const sp = computeSameSeriesSparkline(g);
    const latest = ledger.getLatestObservation(g)!;
    const series = g.observations.filter(
      (o) => o.platform === latest.platform && o.kind === latest.kind,
    );
    assert.equal(sp.count, series.length, g.code);
  }
});

test('ledger sparkline for a piece with no price on record says so (no flat line at 0)', () => {
  const s = computeSameSeriesSparkline(scannedPiece());
  assert.equal(s.status, 'none');
  assert.equal(s.points.length, 0);
  assert.equal(s.deltaPct, null);
});

// ---------------------------------------------------------------------------
// Rotation heatmap: counted wears, no log is its own group
// ---------------------------------------------------------------------------

test('rotation heat tiers come from logged wears; no wear log is "no log", never a 0-wear Cold', () => {
  assert.equal(computeGarmentRotationHeat(seed('J1')).tier, 'hot'); // 14 wears
  assert.equal(computeGarmentRotationHeat(seed('T2')).tier, 'cool'); // 2 wears
  assert.equal(computeGarmentRotationHeat({ ...seed('T2'), wearsLast60Days: 4 }).tier, 'warm');

  const k1 = computeGarmentRotationHeat(seed('K1'));
  assert.equal(k1.tier, 'no-log');
  assert.equal(k1.wearsLast60Days, null);
  assert.equal(k1.shortLabel, 'no log');

  assert.equal(computeGarmentRotationHeat(scannedPiece()).tier, 'no-log');
  assert.equal(computeGarmentRotationHeat(seed('S1')).tier, 'no-log');
});

test('rotation heatmap legend counts add up to the non-sample pieces (seed: 6 Hot, 0 Warm, 2 Cold, 1 no log, of 9)', () => {
  const c = countRotationTiers(INITIAL_GARMENTS);
  assert.equal(c.total, 9);
  assert.equal(c.hot, 6);
  assert.equal(c.warm, 0);
  assert.equal(c.cool, 2);
  assert.equal(c.noLog, 1);
  assert.equal(c.hot + c.warm + c.cool + c.noLog, c.total);
});

// ---------------------------------------------------------------------------
// 30-day decisions (nothing is "sold")
// ---------------------------------------------------------------------------

test('compute30DayRotationTrend counts Keep vs Sell DECISIONS within 30 days', () => {
  const garmentsWithRecentDecisions: GarmentPiece[] = [
    {
      ...mockGarments[0],
      lastDecision: {
        id: 'd-keep-recent',
        choice: 'keep',
        savedAt: '2026-10-25',
        snapshotPrice: 1240000,
        snapshotCurrency: 'KRW',
        snapshotPlatform: 'KREAM',
      },
    },
    {
      ...mockGarments[1],
      lastDecision: {
        id: 'd-sell-recent',
        choice: 'sell',
        savedAt: '2026-11-02',
        snapshotPrice: 199,
        snapshotCurrency: 'USD',
        snapshotPlatform: 'Grailed',
      },
    },
  ];

  const trend = compute30DayRotationTrend(
    garmentsWithRecentDecisions,
    '2026-11-05',
  );
  assert.equal(trend.keptLast30d, 1);
  assert.equal(trend.sellDecidedLast30d, 1);
  assert.equal(trend.totalDecided30d, 2);
  assert.equal(trend.ownedPieces, 2);
  assert.equal(trend.keptValuationKRW, 1240000);
  assert.equal(trend.sellDecidedValuationUSD, 199);
  for (const key of Object.keys(trend)) {
    assert.equal(/sold|pct|rate/i.test(key), false, key);
  }
});

test('seed closet: 30-day decisions are 5 Keep and 2 Sell of 9 pieces; Sell value $409 at latest price seen', () => {
  const trend = compute30DayRotationTrend(INITIAL_GARMENTS);
  assert.equal(trend.keptLast30d, 5);
  assert.equal(trend.sellDecidedLast30d, 2);
  assert.equal(trend.totalDecided30d, 7);
  assert.equal(trend.ownedPieces, 9);
  assert.equal(trend.sellDecidedValuationUSD, 409);
  assert.equal(trend.keptPricedCount, 5);
  assert.equal(trend.sellDecidedPricedCount, 2);
});

test('a decided piece with no price on record is counted as a decision but not summed (no snapshot fallback)', () => {
  const decided = scannedPiece({
    lastDecision: {
      id: 'd_x',
      choice: 'keep',
      savedAt: '2026-11-05',
      snapshotPrice: 0,
      snapshotCurrency: 'KRW',
      snapshotPlatform: 'Karrot',
    },
  });
  const trend = compute30DayRotationTrend([decided]);
  assert.equal(trend.keptLast30d, 1);
  assert.equal(trend.keptPricedCount, 0);
  assert.equal(trend.keptValuationKRW, 0);
});

// ---------------------------------------------------------------------------
// Keep / Sell evidence: counted facts only, no probabilities
// ---------------------------------------------------------------------------

test('no probability is computed or exported: no Pct/probability fields and no simulation helpers', () => {
  assert.equal('evaluateDualScenarios' in ledger, false);
  assert.equal('computeWhatIfCashInflow' in ledger, false);
  assert.equal('compute30DayResaleSparkline' in ledger, false);

  for (const g of [...INITIAL_GARMENTS, scannedPiece()]) {
    const res = summarizeKeepSellEvidence(g, 1000, TARGET_LOOKS);
    const keepKeys = Object.keys(res.keepScenario);
    const sellKeys = Object.keys(res.sellScenario);
    assert.deepEqual(
      keepKeys.filter((k) => /pct|probab|likel|chance/i.test(k)),
      [],
      `${g.code} keep keys`,
    );
    // A single percentage remains on the sell side: a price difference (ask vs latest price seen).
    assert.deepEqual(
      sellKeys.filter((k) => /pct|probab|likel|chance/i.test(k)),
      ['askDeltaPctFromLatest'],
      `${g.code} sell keys`,
    );
    for (const s of collectStrings(res)) {
      assert.equal(/\d\s*%/.test(s), false, `${g.code}: "${s}" shows a percentage`);
    }
  }
});

test('the decision badge is always the neutral text (no recommendation)', () => {
  for (const g of INITIAL_GARMENTS) {
    const res = summarizeKeepSellEvidence(g, 1, TARGET_LOOKS);
    assert.equal(res.summary.neutralBadge, NEUTRAL_DECISION_BADGE);
    assert.equal(res.summary.neutralBadge, 'Compare the records, then decide');
  }
});

test('J2 evidence: 6 wears in 60 days, last worn Oct 26 (10 days), 3 trades (2 in 60 days) and 2 asks with dates', () => {
  const res = summarizeKeepSellEvidence(seed('J2'), 1360000, TARGET_LOOKS);
  assert.equal(res.keepScenario.status, 'wear_log_counted');
  assert.equal(res.keepScenario.wearsLast60Days, 6);
  assert.equal(res.keepScenario.lastWornDate, '2026-10-26');
  assert.equal(res.keepScenario.daysSinceLastWorn, 10);

  assert.equal(res.sellScenario.status, 'prices_counted');
  assert.deepEqual(res.sellScenario.traded, {
    count: 3,
    last60dCount: 2,
    firstDate: '2026-08-05',
    lastDate: '2026-11-04',
  });
  assert.deepEqual(res.sellScenario.listed, {
    count: 2,
    last60dCount: 2,
    firstDate: '2026-09-22',
    lastDate: '2026-10-18',
  });
});

test('J1 evidence counts what is recorded: 3 trades (2 in the last 60 days) and 2 asks', () => {
  const res = summarizeKeepSellEvidence(seed('J1'), 275000, TARGET_LOOKS);
  assert.equal(res.sellScenario.traded.count, 3);
  assert.equal(res.sellScenario.traded.last60dCount, 2);
  assert.equal(res.sellScenario.listed.count, 2);
});

test('numbers move only with facts: lockedForToday and condition grade do not change the evidence', () => {
  const base = seed('J2');
  const a = summarizeKeepSellEvidence(
    { ...base, lockedForToday: false, conditionGrade: 'Good (A)' },
    1360000,
    TARGET_LOOKS,
  );
  const b = summarizeKeepSellEvidence(
    { ...base, lockedForToday: true, conditionGrade: 'Mint (S)' },
    1360000,
    TARGET_LOOKS,
  );
  assert.deepEqual(a, b);
});

test('changing the ask changes only the payout IF sold, never the counted records', () => {
  const j1 = withCheckedFees(seed('J1'));
  const low = summarizeKeepSellEvidence(j1, 250000, TARGET_LOOKS);
  const high = summarizeKeepSellEvidence(j1, 300000, TARGET_LOOKS);
  assert.deepEqual(low.sellScenario.traded, high.sellScenario.traded);
  assert.deepEqual(low.sellScenario.listed, high.sellScenario.listed);
  assert.deepEqual(low.keepScenario, high.keepScenario);
  assert.ok(
    (low.sellScenario.netPayoutInfo.netPayout ?? 0) <
      (high.sellScenario.netPayoutInfo.netPayout ?? 0),
  );
});

test('no wear log is "unknown", never 0 wears, and has no "days since" value', () => {
  const res = summarizeKeepSellEvidence(mockGarments[1], 199, []);
  assert.equal(res.keepScenario.status, 'no_wear_log');
  assert.equal(res.keepScenario.wearsLast60Days, null);
  assert.equal(res.keepScenario.daysSinceLastWorn, null);

  const k1 = summarizeKeepSellEvidence(seed('K1'), 1090, TARGET_LOOKS);
  assert.equal(k1.keepScenario.status, 'no_wear_log');
  assert.equal(k1.keepScenario.wearsLast60Days, null);
});

test('net payout at the ask stays unknown while either cost line is unchecked', () => {
  const j2 = seed('J2');
  const res = summarizeKeepSellEvidence(j2, 1360000, TARGET_LOOKS);
  assert.equal(res.sellScenario.netPayoutInfo.status, 'unconfirmed');
  assert.equal(res.sellScenario.netPayoutInfo.netPayout, null);

  const checked = summarizeKeepSellEvidence(
    withCheckedFees(j2),
    1360000,
    TARGET_LOOKS,
  );
  // 1,360,000 - 5.5% (74,800) - 4,000 shipping
  assert.equal(checked.sellScenario.netPayoutInfo.netPayout, 1281200);
});

test('daysBetween and formatShortDate say "unknown" instead of 0 when the date is missing', () => {
  assert.equal(daysBetween(null), null);
  assert.equal(daysBetween('2026-10-26', '2026-11-05'), 10);
  assert.equal(formatShortDate('2026-10-26'), 'Oct 26');
  assert.equal(formatShortDate(null), 'date unknown');
  assert.equal(formatShortDate('not a date'), 'date unknown');
});

// ---------------------------------------------------------------------------
// Per-platform rows: star only on confirmed fees, range + count (no median)
// ---------------------------------------------------------------------------

test('buildPlatformDotStrips separates platforms, computes conditional net, and recalculates when an observation is excluded', () => {
  const rowsAll = buildPlatformDotStrips(mockGarments[0], 1200000, []);
  const kreamRow = rowsAll.find((r) => r.platform === 'KREAM');
  assert.ok(kreamRow);
  assert.equal(kreamRow.tradedCount, 2);
  assert.equal(kreamRow.minPrice, 1120000);
  assert.equal(kreamRow.maxPrice, 1240000);
  assert.equal(kreamRow.activeCount, 2);
  assert.equal(kreamRow.conditionalNetAtAsk, 1136000);

  const rowsExcluded = buildPlatformDotStrips(mockGarments[0], 1200000, ['o-1']);
  const kreamAfter = rowsExcluded.find((r) => r.platform === 'KREAM');
  assert.ok(kreamAfter);
  assert.equal(kreamAfter.tradedCount, 1);
  assert.equal(kreamAfter.activeCount, 1);
  assert.equal(kreamAfter.minPrice, 1240000);
  assert.equal(kreamAfter.maxPrice, 1240000);
});

test('★ star only on a row whose fees were confirmed: never on default-fee platforms (J1 Karrot 0%)', () => {
  const seededRows = buildPlatformDotStrips(seed('J1'), 275000, []);
  assert.equal(seededRows.some((r) => r.isRecommendedNet), false);
  assert.equal(seededRows.every((r) => r.conditionalNetAtAsk === null), true);
  assert.equal(seededRows.every((r) => r.feeConfirmed === false), true);

  const rows = buildPlatformDotStrips(withCheckedFees(seed('J1')), 275000, []);
  const karrot = rows.find((r) => r.platform === 'Karrot');
  const kream = rows.find((r) => r.platform === 'KREAM');
  assert.ok(karrot && kream);
  assert.equal(karrot.feeConfirmed, false);
  assert.equal(karrot.feeSource, 'default');
  assert.equal(karrot.conditionalNetAtAsk, null);
  assert.equal(karrot.isRecommendedNet, false);
  assert.equal(kream.feeConfirmed, true);
  assert.equal(kream.isRecommendedNet, true);
  for (const r of rows) {
    if (r.isRecommendedNet) assert.equal(r.feeConfirmed, true);
    if (!r.isPrimary) assert.equal(r.feeConfirmed, false);
  }
});

test('★ star never lands on unchecked rows for the other audited pieces (J2, J3, B1, T3)', () => {
  for (const code of ['J2', 'J3', 'B1', 'T3']) {
    const g = withCheckedFees(seed(code));
    const latest = ledger.getLatestObservation(g)?.price ?? 1;
    const rows = buildPlatformDotStrips(g, latest, []);
    const starred = rows.filter((r) => r.isRecommendedNet);
    assert.ok(starred.length <= 1, code);
    for (const r of starred) {
      assert.equal(r.platform, g.feeConfig.platform, code);
      assert.equal(r.feeConfirmed, true, code);
    }
  }
});

test('one ticked line is not enough: the row stays unconfirmed and gets no star', () => {
  const g = seed('J2');
  const half: GarmentPiece = {
    ...g,
    feeConfig: {
      ...g.feeConfig,
      feeRateConfirmed: true,
      shippingConfirmed: false,
      confirmed: feeLinesConfirmed(true, false),
    },
  };
  const rows = buildPlatformDotStrips(half, 1360000, []);
  assert.equal(rows.some((r) => r.feeConfirmed || r.isRecommendedNet), false);
});

test('rows show the observed range and count, never an averaged "median" (J1 KREAM 235,000 – 275,000 · 2)', () => {
  const rows = buildPlatformDotStrips(seed('J1'), 275000, []);
  const kream = rows.find((r) => r.platform === 'KREAM');
  assert.ok(kream);
  assert.equal('medianPrice' in kream, false);
  assert.equal(kream.minPrice, 235000);
  assert.equal(kream.maxPrice, 275000);
  assert.equal(kream.activeCount, 2);
  assert.equal(JSON.stringify(kream).includes('255000'), false);
});

test('a Sample price row is flagged so it can be labelled "Sample"', () => {
  const rows = buildPlatformDotStrips(seed('S1'), 178000, []);
  const kream = rows.find((r) => r.platform === 'KREAM');
  assert.ok(kream);
  assert.equal(kream.hasSampleObservation, true);
});

// ---------------------------------------------------------------------------
// Pre-checkout swap: an assumption, with sign, and no gross-as-net
// ---------------------------------------------------------------------------

test('evaluatePreCheckoutGate detects category duplicates and parseQuickOrderLine reads a 1-line receipt', () => {
  const gate = evaluatePreCheckoutGate(
    {
      name: 'New Cashmere Coat',
      brand: 'LEMAIRE',
      category: 'outerwear',
      price: 1500000,
      currency: 'KRW',
    },
    mockGarments,
  );
  assert.equal(gate.duplicateCategoryPieces.length, 1);
  assert.equal(gate.duplicateCategoryPieces[0].code, 'J1');

  const parsed = parseQuickOrderLine('SSENSE Lemaire Double Coat ₩2,450,000');
  assert.ok(parsed);
  assert.equal(parsed.brand, 'LEMAIRE');
  assert.equal(parsed.name, 'Double Coat');
  assert.equal(parsed.currency, 'KRW');
  assert.equal(parsed.price, 2450000);
  assert.equal(parsed.silhouette, 'overcoat');
});

test('parseQuickOrderLine invents nothing: no default brand, name or silhouette', () => {
  const bare = parseQuickOrderLine('₩120,000');
  assert.ok(bare);
  assert.equal(bare.brand, '');
  assert.equal(bare.name, '');
  assert.equal(bare.silhouette, null);

  const oneWord = parseQuickOrderLine('Grailed Visvim $240');
  assert.ok(oneWord);
  assert.equal(oneWord.brand, 'VISVIM');
  assert.equal(oneWord.name, '');
  assert.equal(oneWord.price, 240);
  assert.equal(oneWord.currency, 'USD');

  // A number written with a currency mark wins over a year in the name.
  const year = parseQuickOrderLine('Our Legacy 2024 Hoodie $240');
  assert.ok(year);
  assert.equal(year.price, 240);
  assert.equal(year.silhouette, 'hoodie');
});

test('swap difference is not computed from the gross price when fees are unchecked', () => {
  const gate = evaluatePreCheckoutGate(
    {
      name: 'Wrap Double-Faced Wool Overcoat',
      brand: 'LEMAIRE',
      category: 'outerwear',
      price: 2150000,
      currency: 'KRW',
    },
    INITIAL_GARMENTS,
  );
  assert.equal(gate.swapCandidate?.code, 'J2');
  assert.equal(gate.swapCandidateGross, 1360000);
  assert.equal(gate.swapCandidateFeesConfirmed, false);
  assert.equal(gate.swapCandidateNetPayout, null);
  assert.equal(gate.netCashAfterSwap, null);
});

test('swap difference keeps its sign once fees are checked (shirt preset is −₩691,200, not ₩0)', () => {
  const garments = INITIAL_GARMENTS.map((g) =>
    g.code === 'J2' ? withCheckedFees(g) : g,
  );
  const coat = evaluatePreCheckoutGate(
    { name: 'Coat', brand: 'LEMAIRE', category: 'outerwear', price: 2150000, currency: 'KRW' },
    garments,
  );
  assert.equal(coat.swapCandidateNetPayout, 1281200);
  assert.equal(coat.netCashAfterSwap, 868800);
  assert.equal(formatSignedCurrency(coat.netCashAfterSwap!, 'KRW'), '+₩868,800');

  const shirt = evaluatePreCheckoutGate(
    { name: 'Shirt', brand: 'DRIES VAN NOTEN', category: 'shirt', price: 590000, currency: 'KRW' },
    garments,
  );
  assert.equal(shirt.netCashAfterSwap, -691200);
  assert.equal(formatSignedCurrency(shirt.netCashAfterSwap!, 'KRW'), '−₩691,200');
});

test('a piece with no wear log is not picked as the "least worn" swap piece', () => {
  const hung = createHungPiece({
    id: 'piece-custom-1',
    observationId: 'obs-custom-1',
    code: 'A11',
    name: 'Coat',
    brand: 'lemaire',
    silhouette: 'overcoat',
    currency: 'KRW',
    price: 500000,
    platform: 'KREAM',
    colorHex: '#000000',
    occlusionStatus: 'front_verified',
  });
  const gate = evaluatePreCheckoutGate(
    { name: 'Shirt', brand: 'X', category: 'shirt', price: 100000, currency: 'KRW' },
    [...INITIAL_GARMENTS, hung],
  );
  assert.notEqual(gate.swapCandidate?.code, 'A11');
});

// ---------------------------------------------------------------------------
// Upload Photo & Hang: only what the owner typed or the scan returned
// ---------------------------------------------------------------------------

test('createHungPiece defaults: ask not trade, fees unconfirmed, no wear log, no decision, no grade, no fabric', () => {
  const piece = createHungPiece({
    id: 'piece-custom-2',
    observationId: 'obs-custom-2',
    code: 'A11',
    name: '  Double-Faced Wool Overshirt ',
    brand: 'hermès',
    silhouette: 'blouson',
    currency: 'KRW',
    price: 420000,
    platform: 'Bunjang',
    colorHex: '#F37021',
    occlusionStatus: 'side_occluded',
  });

  assert.equal(piece.observations.length, 1);
  assert.equal(piece.observations[0].kind, 'listed');
  assert.equal(piece.observations[0].price, 420000);
  assert.equal(piece.observations[0].currency, 'KRW');

  assert.equal(piece.feeConfig.confirmed, false);
  assert.equal(piece.feeConfig.feeRateConfirmed, false);
  assert.equal(piece.feeConfig.shippingConfirmed, false);
  assert.equal(piece.feeConfig.platform, 'Bunjang');
  assert.equal(piece.feeConfig.feeRatePct, 3.5);

  assert.equal(piece.wearLogStatus, 'insufficient');
  assert.equal(piece.wearsLast60Days, 0);
  assert.equal(piece.lastWornDate, null);
  assert.equal(piece.lastDecision, undefined);
  assert.equal(piece.conditionGrade, undefined);
  assert.equal(piece.fabricLabel, 'Fabric not entered');
  assert.equal(piece.purchasePrice, null);
  assert.equal(piece.name, 'Double-Faced Wool Overshirt');
  assert.equal(piece.brand, 'HERMÈS');
  assert.equal(piece.category, 'outerwear');
  assert.equal(piece.isSample, false);
  assert.equal(piece.cutoutSource, undefined);

  const ev = summarizeKeepSellEvidence(piece, 420000, TARGET_LOOKS);
  assert.equal(ev.keepScenario.status, 'no_wear_log');
  assert.equal(ev.sellScenario.netPayoutInfo.netPayout, null);
  assert.equal(ev.sellScenario.traded.count, 0);
  assert.equal(ev.sellScenario.listed.count, 1);
  assert.equal(
    buildPlatformDotStrips(piece, 420000).some((r) => r.isRecommendedNet),
    false,
  );
  const summary = computeLedgerSummary([piece]);
  assert.equal(summary.undecidedCount, 1);
  assert.equal(summary.keepCount, 0);
});

test('createHungPiece records a trade only when the owner marks it as one', () => {
  const piece = createHungPiece({
    id: 'piece-custom-3',
    observationId: 'obs-custom-3',
    code: 'A12',
    name: 'Hoodie',
    brand: 'Our Legacy',
    silhouette: 'hoodie',
    currency: 'USD',
    price: 240,
    platform: 'Grailed',
    priceKind: 'traded',
    colorHex: '#000000',
    occlusionStatus: 'front_verified',
  });
  assert.equal(piece.observations[0].kind, 'traded');
  assert.equal(piece.feeConfig.confirmed, false);
});

test('createHungPiece with no price typed has no price at all (no default), and "paid" is a purchase price, not a resale price', () => {
  const none = createHungPiece({
    id: 'scan-upload-1',
    observationId: 'obs-1',
    code: 'A10',
    name: 'Navy jacket',
    brand: '',
    silhouette: 'blazer',
    currency: 'KRW',
    price: null,
    platform: 'KREAM',
    colorHex: '#1E2852',
    occlusionStatus: 'front_verified',
  });
  assert.equal(none.observations.length, 0);
  assert.equal(none.purchasePrice, null);
  assert.equal(none.brand, '');
  assert.equal(defaultAskPrice(none), null);

  const paid = createHungPiece({
    id: 'piece-custom-4',
    observationId: 'obs-4',
    code: 'A13',
    name: 'Double Coat',
    brand: 'LEMAIRE',
    silhouette: 'overcoat',
    currency: 'KRW',
    price: 2450000,
    priceKind: 'paid',
    platform: 'KREAM',
    colorHex: '#000000',
    occlusionStatus: 'front_verified',
  });
  assert.equal(paid.observations.length, 0);
  assert.equal(paid.purchasePrice, 2450000);
  assert.equal(computeLedgerSummary([paid]).krw.ownedSeenCount, 0);
});

test('createHungPiece from a scan keeps the cut-out, its source and mode, and the scan category (trousers)', () => {
  const piece = createHungPiece({
    id: 'scan-upload-2',
    observationId: 'obs-2',
    code: 'A10',
    name: 'Grey trousers',
    brand: '',
    silhouette: 'tee',
    category: 'trousers',
    currency: 'KRW',
    platform: 'KREAM',
    colorHex: '#808082',
    occlusionStatus: 'front_verified',
    imageUrl: 'data:image/png;base64,AAAA',
    cutoutSource: 'box-crop',
    scanMode: 'live',
  });
  assert.equal(piece.category, 'trousers');
  assert.equal(piece.imageUrl, 'data:image/png;base64,AAAA');
  assert.equal(piece.frontImageUrl, 'data:image/png;base64,AAAA');
  assert.equal(piece.cutoutSource, 'box-crop');
  assert.equal(piece.scanMode, 'live');
  assert.equal(isKeptAfterReload(piece), true);
  assert.equal(describePhotoSource(piece), 'Prior scan · source unverified');

  const sample = createHungPiece({
    id: 'scan-upload-3',
    observationId: 'obs-3',
    code: 'A11',
    name: 'Blazer',
    brand: '',
    silhouette: 'blazer',
    currency: 'KRW',
    platform: 'KREAM',
    colorHex: '#000000',
    occlusionStatus: 'front_verified',
    imageUrl: 'data:image/png;base64,BBBB',
    cutoutSource: 'sam-mask',
    scanMode: 'fake',
    isSample: true,
  });
  assert.equal(sample.isSample, true);
  assert.equal(computeLedgerSummary([sample]).totalOwnedPieces, 0);
});

test('photo provenance names a model only for a scanned cut-out', () => {
  assert.equal(describePhotoSource(scannedPiece()), '1 photo · SAM 3.1 mask · Test fake · no Meta call');
  assert.equal(
    describePhotoSource(scannedPiece({ scanMode: 'live', scanReceiptId:'receipt-a', scanCardId:'1' })),
    '1 photo · SAM 3.1 mask · LIVE',
  );
  for (const g of INITIAL_GARMENTS) {
    assert.equal(describePhotoSource(g), 'Sample photo · no model call', g.code);
    assert.equal(isKeptAfterReload(g), false, g.code);
  }
  assert.equal(
    describePhotoSource(scannedPiece({ cutoutSource: undefined, scanMode: undefined })),
    'Your photo · no model call',
  );
  assert.equal(
    describePhotoSource(
      scannedPiece({ cutoutSource: undefined, imageUrl: undefined, frontImageUrl: undefined }),
    ),
    'No photo · no model call',
  );
});

test('price entry lists only platforms in the piece currency', () => {
  const krw = platformsForCurrency('KRW').map((p) => p.name);
  const usd = platformsForCurrency('USD').map((p) => p.name);
  assert.deepEqual(krw.sort(), ['Bunjang', 'KREAM', 'Karrot', 'Musinsa Used']);
  assert.equal(usd.includes('KREAM'), false);
  assert.equal(usd.includes('Grailed'), true);
  assert.equal(krw.includes('Grailed'), false);
});

// ---------------------------------------------------------------------------
// On-screen wording: no banned words in src/, index.html, metadata.json, vite.config.ts
// ---------------------------------------------------------------------------

// Assembled from parts so this file does not contain the words it checks for.
const BANNED = [
  ['conn', 'ected'],
  ['un', 'worn'],
  ['never ', 'worn'],
  ['미착', '용'],
  ['안 ', '입'],
  ['age', 'nt'],
  ['about to ', 'buy'],
  ['knows ', 'what'],
  ['the ', 'only'],
  ['first ', 'app'],
  ['nobody ', 'else'],
  ['유', '일'],
  ['최', '초'],
].map((parts) => parts.join(''));

function listFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p.endsWith(join('src', 'assets'))) continue;
      listFiles(p, out);
    } else if (/\.(tsx?|css|html|json)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

test('banned words do not appear in the app source or its page metadata', () => {
  const root = join(import.meta.dirname, '..', '..');
  const files = [
    ...listFiles(join(root, 'src')),
    join(root, 'index.html'),
    join(root, 'metadata.json'),
    join(root, 'vite.config.ts'),
  ];
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8').toLowerCase();
    for (const w of BANNED) {
      if (text.includes(w)) hits.push(`${f}: ${w}`);
    }
  }
  assert.deepEqual(hits, []);
});


test('decision trend accepts ISO timestamps and legacy dates in the same window', () => {
  const base = {...mockGarments[0], isSample:false};
  const decision = {id:'d-iso',choice:'sell' as const,savedAt:'2026-11-06T03:04:05.000Z',snapshotPrice:125000,snapshotCurrency:'KRW' as const,snapshotPlatform:'Karrot' as const};
  const trend=compute30DayRotationTrend([{...base,id:'iso',lastDecision:decision},{...base,id:'legacy',lastDecision:{...decision,id:'d-date',savedAt:'2026-11-06'}}],'2026-11-06');
  assert.equal(trend.sellDecidedLast30d,2);
});


test('manual trousers and footwear keep their category and specialized display after hanging',()=>{
 for (const [silhouette,category,variant] of [
   ['trousers','trousers','trouser-clamp'],
   ['sneaker-box','footwear','glossy-glass-box'],
 ] as const) {
   const hung=createHungPiece({id:`piece-custom-${silhouette}`,observationId:'obs-fixture',code:'A11',name:'Owner piece',brand:'',silhouette,currency:'KRW',price:null,platform:'KREAM',colorHex:'#000000',occlusionStatus:'front_verified'});
   assert.equal(hung.category,category);
   assert.equal(ledger.resolve3DDisplayVariant(hung).variant,variant);
   assert.equal(hung.wearLogStatus,'insufficient');
   assert.equal(hung.lastDecision,undefined);
 }
 assert.equal(ledger.resolve3DDisplayVariant({category:'trousers',silhouette:'tee'}).variant,'trouser-clamp');
 assert.equal(ledger.resolve3DDisplayVariant({category:'footwear',silhouette:'tee'}).variant,'glossy-glass-box');
 assert.equal(ledger.resolve3DDisplayVariant({category:'shirt',silhouette:'tee'}).variant,'sartorial-hanger');
});
