import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_GARMENTS, TARGET_LOOKS } from '../data/seedCloset';
import { GarmentPiece } from '../types/closet';
import { summarizeKeepSellEvidence } from '../utils/ledgerLogic';
import {
  decisionStorageNote,
  hasTwoPhotos,
  latestPricePerPlatform,
  netIfSold,
  purchaseLines,
  resolveSheetDrag,
  scanSourceLabel,
  sheetHeightFor,
  sheetHeightWhileDragging,
  statusChips,
  wearRecordLine,
  wearRecordParts,
} from './InspectorLogic';

const seed = (code: string): GarmentPiece => {
  const g = INITIAL_GARMENTS.find((x) => x.code === code);
  if (!g) throw new Error(`seed ${code} missing`);
  return g;
};

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
  feeConfig: { platform: 'Karrot', feeRatePct: 0, shippingCost: 0, confirmed: false },
  ...over,
});

const withCheckedFees = (g: GarmentPiece): GarmentPiece => ({
  ...g,
  feeConfig: { ...g.feeConfig, feeRateConfirmed: true, shippingConfirmed: true, confirmed: true },
});

// ---------------------------------------------------------------------------
// Price seen: latest per platform, up to 3, never averaged
// ---------------------------------------------------------------------------

test('J2 price seen: the latest record per platform, newest first, 3 of 4 platforms shown, 5 records counted', () => {
  const j2 = seed('J2');
  const r = latestPricePerPlatform(j2.observations, j2.currency, 3);
  assert.equal(r.rows.length, 3);
  assert.equal(r.platformCount, 4);
  assert.equal(r.recordCount, 5);
  assert.deepEqual(
    r.rows.map((x) => [x.platform, x.price, x.date, x.kind]),
    [
      ['KREAM', 1360000, '2026-11-04', 'traded'],
      ['Karrot', 1290000, '2026-10-18', 'listed'],
      ['Musinsa Used', 1260000, '2026-10-11', 'traded'],
    ],
  );
  // The older KREAM trade (Aug 05) is not a second KREAM row.
  assert.equal(r.rows.filter((x) => x.platform === 'KREAM').length, 1);
  // Every row keeps the piece currency; no averaged value appears anywhere.
  assert.ok(r.rows.every((x) => x.currency === 'KRW'));
  assert.equal(JSON.stringify(r).includes('1275000'), false);
});

test('price seen ignores records in another currency and a Sample price is flagged', () => {
  const j2 = seed('J2');
  const mixed = [
    ...j2.observations,
    { id: 'usd-1', date: '2026-11-05', platform: 'Grailed' as const, price: 900, currency: 'USD' as const, kind: 'listed' as const },
  ];
  const r = latestPricePerPlatform(mixed, 'KRW', 10);
  assert.equal(r.platformCount, 4);
  assert.equal(r.recordCount, 5);
  assert.equal(r.rows.some((x) => x.platform === 'Grailed'), false);

  const s1 = seed('S1');
  const rs = latestPricePerPlatform(s1.observations, s1.currency);
  assert.equal(rs.rows.length, 1);
  assert.equal(rs.rows[0].isSample, true);

  const none = latestPricePerPlatform(scannedPiece().observations, 'KRW');
  assert.deepEqual(none, { rows: [], platformCount: 0, recordCount: 0 });
});

// ---------------------------------------------------------------------------
// Wear record line
// ---------------------------------------------------------------------------

test('wear record reads "k wears · 60 days · last worn YYYY-MM-DD", or "No wear log" (never 0 wears)', () => {
  const j2 = summarizeKeepSellEvidence(seed('J2'), 1360000, TARGET_LOOKS).keepScenario;
  assert.equal(wearRecordLine(j2), '6 wears · 60 days · last worn 2026-10-26');
  assert.deepEqual(wearRecordParts(j2), {
    kind: 'counted',
    wearsText: '6 wears',
    rest: '· 60 days · last worn 2026-10-26',
  });

  const t3 = summarizeKeepSellEvidence(seed('T3'), 199, TARGET_LOOKS).keepScenario;
  assert.equal(wearRecordLine(t3), '1 wear · 60 days · last worn 2026-09-18');

  // A verified log with 0 wears is a counted 0, not a missing log.
  assert.equal(
    wearRecordLine({ status: 'wear_log_counted', wearsLast60Days: 0, lastWornDate: '2026-08-01' }),
    '0 wears · 60 days · last worn 2026-08-01',
  );
  assert.equal(
    wearRecordLine({ status: 'wear_log_counted', wearsLast60Days: 2, lastWornDate: null }),
    '2 wears · 60 days · last worn date unknown',
  );

  const k1 = summarizeKeepSellEvidence(seed('K1'), 1090, TARGET_LOOKS).keepScenario;
  assert.equal(wearRecordLine(k1), 'No wear log');
  const s1 = summarizeKeepSellEvidence(seed('S1'), 178000, TARGET_LOOKS).keepScenario;
  assert.equal(wearRecordLine(s1), 'No wear log');
  const scanned = summarizeKeepSellEvidence(scannedPiece(), null, TARGET_LOOKS).keepScenario;
  assert.equal(wearRecordLine(scanned), 'No wear log');
});

// ---------------------------------------------------------------------------
// Status chips
// ---------------------------------------------------------------------------

test('status chips: Sample alone for a sample piece; a decision chip for owned pieces; a source chip only after a scan', () => {
  assert.deepEqual(
    statusChips(seed('S1')).map((c) => [c.id, c.label]),
    [['sample', 'Sample (Excluded from Owned Total)']],
  );
  assert.deepEqual(statusChips(seed('J2')).map((c) => [c.id, c.label, c.tone]), [['decision', 'Keep', 'keep']]);
  assert.deepEqual(statusChips(seed('T2')).map((c) => [c.id, c.label, c.tone]), [['decision', 'Sell', 'sell']]);
  assert.deepEqual(statusChips(seed('K1')).map((c) => [c.id, c.label, c.tone]), [['decision', 'Undecided', 'undecided']]);

  assert.deepEqual(
    statusChips(scannedPiece()).map((c) => [c.id, c.label]),
    [
      ['source', 'SAM mask · Test fake · no Meta call'],
      ['decision', 'Undecided'],
    ],
  );
  assert.equal(scanSourceLabel(scannedPiece({ cutoutSource: 'box-crop', scanMode: 'live' })), 'Spark box · LIVE');
  assert.equal(scanSourceLabel(scannedPiece({ cutoutSource: 'sam-mask', scanMode: 'live' })), 'SAM mask · LIVE');
  assert.equal(scanSourceLabel(seed('J2')), null);
  // No model version is named on the chip.
  for (const g of [scannedPiece(), scannedPiece({ scanMode: 'live' })]) {
    for (const c of statusChips(g)) assert.equal(/\d\.\d/.test(c.label), false, c.label);
  }
});

// ---------------------------------------------------------------------------
// Purchase lines
// ---------------------------------------------------------------------------

test('purchase lines show what was paid and leave date and place "not entered"; a scanned piece has nothing entered', () => {
  assert.deepEqual(purchaseLines(seed('J2')), [
    { label: 'Paid', value: '₩1,650,000', entered: true },
    { label: 'When', value: 'not entered', entered: false },
    { label: 'Where', value: 'not entered', entered: false },
  ]);
  assert.deepEqual(purchaseLines(seed('T2'))[0], { label: 'Paid', value: '$225', entered: true });
  const scanned = purchaseLines(scannedPiece());
  assert.ok(scanned.every((l) => l.value === 'not entered' && l.entered === false));
  // A sample piece with no purchase price is not filled from its price seen.
  assert.equal(purchaseLines(seed('S1'))[0].value, 'not entered');
});

// ---------------------------------------------------------------------------
// Net if sold
// ---------------------------------------------------------------------------

test('net if sold: "not set" with no price, "Fee not confirmed" until both lines are ticked, then the net', () => {
  const scanned = summarizeKeepSellEvidence(scannedPiece(), null, TARGET_LOOKS).sellScenario;
  assert.deepEqual(netIfSold(scanned.askPrice, scanned.netPayoutInfo), { kind: 'no_price' });

  const j2 = summarizeKeepSellEvidence(seed('J2'), 1360000, TARGET_LOOKS).sellScenario;
  assert.deepEqual(netIfSold(1360000, j2.netPayoutInfo), { kind: 'fee_not_confirmed', ask: 1360000 });

  const checked = summarizeKeepSellEvidence(withCheckedFees(seed('J2')), 1360000, TARGET_LOOKS).sellScenario;
  // 1,360,000 − 5.5% (74,800) − 4,000 shipping
  assert.deepEqual(netIfSold(1360000, checked.netPayoutInfo), { kind: 'net', ask: 1360000, net: 1281200 });

  // One ticked line is not enough.
  const half: GarmentPiece = {
    ...seed('J2'),
    feeConfig: { ...seed('J2').feeConfig, feeRateConfirmed: true, shippingConfirmed: false, confirmed: false },
  };
  const halfEv = summarizeKeepSellEvidence(half, 1360000, TARGET_LOOKS).sellScenario;
  assert.equal(netIfSold(1360000, halfEv.netPayoutInfo).kind, 'fee_not_confirmed');
});

test('where a decision is saved, and when the photo toggle shows', () => {
  assert.equal(decisionStorageNote(seed('J2')), 'Saved in this browser only · resets on reload');
  assert.equal(decisionStorageNote(scannedPiece()), 'Saved in this browser only · kept after reload');
  assert.equal(hasTwoPhotos(seed('J2')), true);
  assert.equal(hasTwoPhotos(seed('B1')), false);
  assert.equal(hasTwoPhotos(scannedPiece()), false);
});

// ---------------------------------------------------------------------------
// Phone bottom sheet drag rules
// ---------------------------------------------------------------------------

test('bottom sheet: about 70% tall, dragged up to full, dragged down to close', () => {
  assert.equal(sheetHeightFor('half', 844), 591);
  assert.equal(sheetHeightFor('full', 844), 844);

  assert.equal(resolveSheetDrag('half', -120, 844), 'full');
  assert.equal(resolveSheetDrag('half', 120, 844), 'closed');
  assert.equal(resolveSheetDrag('half', 20, 844), 'half');
  assert.equal(resolveSheetDrag('half', -20, 844), 'half');
  assert.equal(resolveSheetDrag('full', 120, 844), 'half');
  assert.equal(resolveSheetDrag('full', 400, 844), 'closed');
  assert.equal(resolveSheetDrag('full', -50, 844), 'full');

  assert.equal(sheetHeightWhileDragging('half', 100, 844), 491);
  assert.equal(sheetHeightWhileDragging('half', -400, 844), 844);
  assert.equal(sheetHeightWhileDragging('full', 900, 844), 96);
});
