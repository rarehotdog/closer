// F8 closet ledger: the owner's pieces and the prices seen for them, counted per currency, owner and
// sample rows apart. Expected values are written by hand from evidence rows built in this file; the
// fixture-closet case at the end asserts relations only (the sample fixture's rows may change).
import { ROOT, ok } from './helpers.ts';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteLedger } from '../store/ledger.ts';
import { ExtrasStore } from '../store/extras.ts';
import { CloserService } from '../engine/service.ts';
import { FeatureService } from '../engine/features.ts';
import { createMockPorts } from '../adapters/index.ts';
import { createPhotoLibrary } from '../fixtures/photos.ts';
import { closetHistory, closetItems, sampleEvidence } from '../fixtures/closet.ts';
import { KILL_TTL_MS, PROVISIONAL_CAPS } from '../engine/caps.ts';
import { addDays } from '../shared/dates.ts';
import { closetLedger, type ClosetLedger, type LedgerDecision, type LedgerReviewRow } from '../engine/ledger.ts';
import type { Evidence } from '../engine/market.ts';

const TODAY = '2026-11-04';

type EvIn = Partial<Evidence> & Pick<Evidence, 'evidenceId' | 'itemId' | 'amount' | 'retrievedAt'>;
const ev = (o: EvIn): Evidence => ({
  platform: 'KARROT', priceType: 'ASK', currency: 'KRW', url: null, size: null, condition: null, matchLevel: 'SIMILAR', source: 'owner_entered', ...o,
});
const sampleRow = (o: EvIn): Evidence => ev({ source: 'sample', ...o });
const confirmed = (...ids: string[]) => ids.map((itemId) => ({ itemId, ownership: 'CONFIRMED' as const }));
const run = (o: { items: ReturnType<typeof confirmed> | { itemId: string; ownership: 'CANDIDATE' | 'CONFIRMED' | 'REJECTED' }[]; evidence?: Evidence[]; decisions?: LedgerDecision[]; reviewRows?: LedgerReviewRow[] }): ClosetLedger =>
  closetLedger({ items: o.items, evidence: o.evidence ?? [], decisions: o.decisions ?? [], reviewRows: o.reviewRows ?? [] });
const side = (L: ClosetLedger, c: 'KRW' | 'USD' | 'EUR') => L.byCurrency.find((x) => x.currency === c);
const position = (itemId: string, at: string, currency: string, net: number | null | undefined): LedgerDecision => ({
  itemId, at, sell: { currency, scenario: net === undefined ? null : { net } },
});

describe('F8 closet ledger: counted pieces and the latest price per piece, per currency, owner and sample apart', () => {
  it('L-01 owner and sample totals per currency are separate and never added together', () => {
    const L = run({
      items: confirmed('A', 'B', 'C'),
      evidence: [
        ev({ evidenceId: 'a-own', itemId: 'A', amount: 100000, retrievedAt: '2026-11-01' }),
        sampleRow({ evidenceId: 'a-smp', itemId: 'A', amount: 80000, retrievedAt: '2026-11-03' }),
        sampleRow({ evidenceId: 'b-smp', itemId: 'B', amount: 50000, retrievedAt: '2026-10-30', priceType: 'TRADE' }),
      ],
    });
    const krw = side(L, 'KRW')!;
    assert.deepEqual(krw.owner, { total: 100000, pieces: 1, ask: 1, trade: 0 });
    assert.deepEqual(krw.sample, { total: 130000, pieces: 2, ask: 1, trade: 1 });
    assert.notEqual(krw.owner.total, 180000, 'the sample row of A is not in the owner total');
    assert.deepEqual([L.pieces, L.withEvidence, L.withOwnerEvidence, L.sampleOnly, L.withoutEvidence], [3, 2, 1, 1, 1]);
    assert.equal(L.byCurrency.length, 1, 'only currencies with a row');
    assert.equal(L.lines.headline, '₩100,000 on 1 of 3 pieces at the latest price you entered for each (1 asking); Sample ₩130,000 on 2 of 3 pieces at the latest sample price for each (1 traded, 1 asking), kept apart from yours.');
    assert.equal(L.lines.evidence, '2 of 3 pieces have a price (1 with a price you entered, 1 with sample prices only); the other 1 has none yet and is not counted as zero.');
    assert.equal(L.note, 'Each currency stands alone; nothing is converted. Asking prices are not sales. Sample prices are demo rows and are never added to yours.');
  });

  it('L-02 the latest row wins by retrievedAt; on the same day TRADE before ASK, then evidenceId ascending', () => {
    const rows = [
      ev({ evidenceId: 'a-1', itemId: 'A', amount: 90000, retrievedAt: '2026-10-01' }),
      ev({ evidenceId: 'a-2', itemId: 'A', amount: 70000, retrievedAt: '2026-10-20' }),
      ev({ evidenceId: 'b-ask', itemId: 'B', amount: 50000, retrievedAt: '2026-10-20' }),
      ev({ evidenceId: 'b-trade', itemId: 'B', amount: 45000, retrievedAt: '2026-10-20', priceType: 'TRADE' }),
      ev({ evidenceId: 'c-2', itemId: 'C', amount: 30000, retrievedAt: '2026-10-20' }),
      ev({ evidenceId: 'c-1', itemId: 'C', amount: 31000, retrievedAt: '2026-10-20' }),
    ];
    for (const evidence of [rows, [...rows].reverse()]) {
      const L = run({ items: confirmed('A', 'B', 'C'), evidence });
      assert.deepEqual(side(L, 'KRW')!.owner, { total: 70000 + 45000 + 31000, pieces: 3, ask: 2, trade: 1 });
      assert.deepEqual(Object.fromEntries(Object.entries(L.tags).map(([k, r]) => [k, r.evidenceId])), { A: 'a-2', B: 'b-trade', C: 'c-1' });
    }
  });

  it('L-03 KRW and USD are never mixed; USD sums round to cents (68.1 + 19.99 = 88.09)', () => {
    const L = run({
      items: confirmed('A', 'B', 'C', 'D'),
      evidence: [
        ev({ evidenceId: 'a-krw', itemId: 'A', amount: 85000, retrievedAt: '2026-10-01' }),
        ev({ evidenceId: 'a-usd', itemId: 'A', amount: 68.1, currency: 'USD', platform: 'POSHMARK', retrievedAt: '2026-11-01' }),
        ev({ evidenceId: 'b-usd', itemId: 'B', amount: 19.99, currency: 'USD', platform: 'EBAY', retrievedAt: '2026-11-02', priceType: 'TRADE' }),
        ev({ evidenceId: 'c-eur', itemId: 'C', amount: 12.5, currency: 'EUR', platform: 'VINTED', retrievedAt: '2026-11-02' }),
        ev({ evidenceId: 'd-eur', itemId: 'D', amount: 7.25, currency: 'EUR', platform: 'VINTED', retrievedAt: '2026-11-03' }),
      ],
    });
    assert.deepEqual(L.byCurrency.map((c) => c.currency), ['KRW', 'USD', 'EUR']);
    assert.deepEqual(side(L, 'KRW')!.owner, { total: 85000, pieces: 1, ask: 1, trade: 0 });
    assert.deepEqual(side(L, 'USD')!.owner, { total: 88.09, pieces: 2, ask: 1, trade: 1 });
    assert.deepEqual(side(L, 'EUR')!.owner, { total: 19.75, pieces: 2, ask: 2, trade: 0 });
    // A piece priced in two currencies is counted once in each, and its tag shows KRW (first in order) although the USD row is newer.
    assert.equal(L.tags.A.currency, 'KRW');
    assert.equal(L.tags.A.evidenceId, 'a-krw');
    assert.equal(L.tags.B.platformName, 'eBay (ebay.com)');
    assert.equal(L.withEvidence, 4);
  });

  it('L-04 pieces that are not CONFIRMED, and rows, positions or review rows for pieces not in the closet, are ignored', () => {
    const L = run({
      items: [{ itemId: 'A', ownership: 'CONFIRMED' }, { itemId: 'B', ownership: 'CANDIDATE' }, { itemId: 'R', ownership: 'REJECTED' }],
      evidence: [
        ev({ evidenceId: 'a', itemId: 'A', amount: 10000, retrievedAt: '2026-11-01' }),
        ev({ evidenceId: 'b', itemId: 'B', amount: 20000, retrievedAt: '2026-11-01' }),
        ev({ evidenceId: 'r', itemId: 'R', amount: 30000, retrievedAt: '2026-11-01' }),
        ev({ evidenceId: 'z', itemId: 'Z', amount: 40000, retrievedAt: '2026-11-01' }),
      ],
      decisions: [position('B', '2026-11-02T00:00:00.000Z', 'KRW', 15000), position('Z', '2026-11-02T00:00:00.000Z', 'KRW', 35000)],
      reviewRows: [{ itemId: 'A', status: 'CANDIDATE', windowDays: 60 }, { itemId: 'Z', status: 'RECENT_WEAR', windowDays: 60 }],
    });
    assert.deepEqual([L.pieces, L.withEvidence, L.withoutEvidence], [1, 1, 0]);
    assert.deepEqual(side(L, 'KRW')!.owner, { total: 10000, pieces: 1, ask: 1, trade: 0 });
    assert.deepEqual(Object.keys(L.tags), ['A']);
    assert.deepEqual(L.net, { byCurrency: [], pieces: 0, pricedNoNet: 1 });
    assert.deepEqual(L.wear, { windowDays: 60, recentWear: 0, candidates: 1, tooFewRecords: 0, exempt: 0 });
  });

  it('L-05 a price tag shows the owner row over a newer sample row, in the first currency that has an owner row', () => {
    const L = run({
      items: confirmed('A', 'B', 'C'),
      evidence: [
        ev({ evidenceId: 'a-own', itemId: 'A', amount: 60000, retrievedAt: '2026-10-01' }),
        sampleRow({ evidenceId: 'a-smp', itemId: 'A', amount: 90000, retrievedAt: '2026-11-03' }),
        ev({ evidenceId: 'b-own-usd', itemId: 'B', amount: 40, currency: 'USD', platform: 'GRAILED', retrievedAt: '2026-10-05' }),
        sampleRow({ evidenceId: 'b-smp-krw', itemId: 'B', amount: 55000, retrievedAt: '2026-11-03' }),
        sampleRow({ evidenceId: 'c-smp-usd', itemId: 'C', amount: 30, currency: 'USD', platform: 'POSHMARK', retrievedAt: '2026-11-01' }),
      ],
    });
    assert.deepEqual(L.tags.A, { evidenceId: 'a-own', itemId: 'A', amount: 60000, currency: 'KRW', platform: 'KARROT', platformName: 'Karrot (당근)', priceType: 'ASK', source: 'owner_entered', retrievedAt: '2026-10-01' });
    assert.equal(L.tags.B.evidenceId, 'b-own-usd', 'owner row in USD wins over a sample row in KRW');
    assert.equal(L.tags.C.source, 'sample');
    assert.equal(L.tags.C.currency, 'USD');
    assert.deepEqual(side(L, 'KRW')!.sample, { total: 145000, pieces: 2, ask: 2, trade: 0 });
  });

  it('L-06 the net sums each piece\'s latest saved position whose net is a number, per currency; pricedNoNet counts priced pieces without one', () => {
    const items = confirmed('A', 'B', 'C', 'D', 'E', 'F');
    const evidence = ['A', 'B', 'C', 'F'].map((id) => ev({ evidenceId: `p-${id}`, itemId: id, amount: 50000, retrievedAt: '2026-11-01' }));
    const L = run({
      items, evidence,
      decisions: [
        position('A', '2026-11-01T10:00:00.000Z', 'KRW', 50000),
        position('A', '2026-11-02T10:00:00.000Z', 'KRW', 60000),
        position('B', '2026-11-01T10:00:00.000Z', 'KRW', 40000),
        position('B', '2026-11-03T10:00:00.000Z', 'KRW', undefined), // latest position has no asking price: no net
        position('C', '2026-11-02T10:00:00.000Z', 'KRW', null), // a cost line not checked: net unknown
        position('D', '2026-11-02T10:00:00.000Z', 'USD', 25.5),
        position('E', '2026-11-02T10:00:00.000Z', 'KRW', 15000),
      ],
    });
    assert.deepEqual(L.net, { byCurrency: [{ currency: 'KRW', total: 75000, pieces: 2 }, { currency: 'USD', total: 25.5, pieces: 1 }], pieces: 3, pricedNoNet: 3 });
    assert.equal(L.lines.net, 'You would receive ₩75,000 on 2 pieces and $25.50 on 1 piece at the prices you tested, every cost checked. 3 other priced pieces have no net worked out yet.');
    const none = run({ items, evidence });
    assert.deepEqual(none.net, { byCurrency: [], pieces: 0, pricedNoNet: 4 });
    assert.equal(none.lines.net, 'No net worked out yet. Open Keep or let go? on a piece and check its costs.');
  });

  it('L-07 wear counts come from the review rows: recent wear, candidates, too few records (TOO_NEW + LOW_RECORDS), exempt', () => {
    const st = ['RECENT_WEAR', 'RECENT_WEAR', 'CANDIDATE', 'TOO_NEW', 'LOW_RECORDS', 'EXEMPT'];
    const ids = st.map((_, i) => `I${i}`);
    const L = run({ items: confirmed(...ids), reviewRows: st.map((status, i) => ({ itemId: ids[i], status, windowDays: 60 })) });
    assert.deepEqual(L.wear, { windowDays: 60, recentWear: 2, candidates: 1, tooFewRecords: 2, exempt: 1 });
    assert.equal(L.lines.wear, 'Last 60 days, from confirmed wear records: 2 pieces worn at least once, 1 with no confirmed wear, 2 with too few records to say, 1 left out (stored or kept until a date you set). Days without a record are unknown.');
    assert.equal(L.lines.headline, 'No prices yet on your 6 pieces. Add one you saw on any piece.');
    assert.deepEqual([L.byCurrency, L.tags, L.withEvidence, L.withoutEvidence], [[], {}, 0, 6]);
  });

  it('L-08 the ledger JSON has no key named average, median, estimate, value, worth, probability or score at any depth', () => {
    const L = run({
      items: confirmed('A', 'B'),
      evidence: [ev({ evidenceId: 'a', itemId: 'A', amount: 1000, retrievedAt: '2026-11-01' }), sampleRow({ evidenceId: 'b', itemId: 'B', amount: 9.5, currency: 'USD', platform: 'EBAY', retrievedAt: '2026-11-01' })],
      decisions: [position('A', '2026-11-02T00:00:00.000Z', 'KRW', 900)],
      reviewRows: [{ itemId: 'A', status: 'RECENT_WEAR', windowDays: 60 }],
    });
    const banned = new Set(['average', 'median', 'estimate', 'value', 'worth', 'probability', 'score']);
    const keys: string[] = [];
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.push(k); walk(v); }
    };
    walk(JSON.parse(JSON.stringify(L)));
    assert.ok(keys.length > 20);
    assert.deepEqual(keys.filter((k) => banned.has(k.toLowerCase())), []);
  });
});

describe('F8 closet ledger on the sample closet (FeatureService), relations only', () => {
  const cleanups: (() => void)[] = [];
  after(() => cleanups.forEach((f) => f()));

  it('L-09 the sample KRW total is the sum of the KRW sample tags; every piece is priced or not; the owner side is zero', () => {
    const dir = join(ROOT, '.data', 'test');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `ledger-${process.pid}.db`);
    const ledger = new SqliteLedger(path, { kill: { on: false, setAt: null, ttlMs: KILL_TTL_MS }, caps: PROVISIONAL_CAPS });
    const extras = new ExtrasStore(path);
    cleanups.push(() => {
      ledger.close();
      extras.close();
      for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
    });
    const lib = createPhotoLibrary();
    const now = new Date(`${TODAY}T09:00:00+09:00`);
    const { ports } = createMockPorts(lib, { sleep: async () => {}, nowMs: () => 0, nowIso: () => now.toISOString() }, {});
    const svc = new CloserService({ ledger, ports, photos: lib, mode: 'mock', clock: { now: () => now, today: () => TODAY } });
    const feat = new FeatureService({ ledger, extras, today: () => TODAY, now: () => now });
    const ws = 'ws-ledger';
    const since = addDays(TODAY, -75);
    ledger.createWorkspace({ workspaceId: ws, kind: 'rehearsal', publicReadOnly: false, seedRef: 'sample-closet', createdOn: since }, { items: closetItems(), since });
    let i = 0;
    for (const h of closetHistory(TODAY)) ok(svc.recordPastWear(ws, { eventId: `hist-${++i}`, actor: 'demo_script', expectedRevision: ledger.getWorkspace(ws)!.ledgerRevision, itemIds: h.itemIds, occurredAt: h.occurredAt }));

    const sample = sampleEvidence(TODAY);
    const L = feat.closetLedger(ws, sample);
    const tags = Object.values(L.tags);
    const krw = L.byCurrency.find((c) => c.currency === 'KRW');
    assert.ok(krw, 'the sample closet has KRW sample rows');
    assert.equal(krw.sample.total, tags.filter((r) => r.currency === 'KRW' && r.source === 'sample').reduce((s, r) => s + r.amount, 0));
    assert.equal(L.withEvidence + L.withoutEvidence, L.pieces);
    assert.equal(L.pieces, closetItems().filter((x) => x.ownership === 'CONFIRMED').length);
    for (const c of L.byCurrency) assert.deepEqual(c.owner, { total: 0, pieces: 0, ask: 0, trade: 0 }, `${c.currency}: no owner rows in the sample closet`);
    assert.equal(L.withOwnerEvidence, 0);
    assert.equal(L.sampleOnly, L.withEvidence);
    assert.ok(tags.every((r) => r.source === 'sample'));
    const cov = feat.coverage(ws, sample);
    assert.deepEqual([L.withEvidence, L.pieces], [cov.withEvidence, cov.total]);
    const review = feat.review(ws, 60);
    assert.equal(L.wear.recentWear + L.wear.candidates + L.wear.tooFewRecords + L.wear.exempt, review.rows.length);
    assert.equal(L.wear.candidates, review.counts.CANDIDATE ?? 0);
  });
});
