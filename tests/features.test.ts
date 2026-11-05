// Features added 11/2: F1 "오늘은 이 옷" (anchor), F2 60-day review · price cards · hand-off drafts,
// F3 looks by occasion rebuilt from the owner's wardrobe. Expected values are written by hand.
import { ROOT, isOp, ok } from './helpers.ts';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteLedger } from '../store/ledger.ts';
import { ExtrasStore } from '../store/extras.ts';
import { CloserService, type Operation } from '../engine/service.ts';
import { FeatureService } from '../engine/features.ts';
import { createMockPorts } from '../adapters/index.ts';
import { textResponse, type MockScript } from '../adapters/mock/transport.ts';
import { CHIPS, createPhotoLibrary } from '../fixtures/photos.ts';
import { closetHistory, closetItems, sampleEvidence } from '../fixtures/closet.ts';
import { KILL_TTL_MS, PROVISIONAL_CAPS } from '../engine/caps.ts';
import { addDays } from '../shared/dates.ts';
import { evidenceCoverage, netScenario, priceCards, priceSeries, sellDraft, validateEvidence, HANDOFF_STATES, PLATFORMS, PLATFORM_INFO } from '../engine/market.ts';
import { countOutfits } from '../engine/looks.ts';
import { basisOf } from '../engine/decision.ts';
// @ts-expect-error plain browser module without type declarations; the same file the 3D screen imports
import { buildAnatomy } from '../web/public/anatomy.js';
import { checkIntent, INTENT_CHIPS, rulesIntent } from '../engine/intent.ts';
import { factsFromState } from '../engine/rules.ts';
import type { Item } from '../shared/wardrobe.ts';

const TODAY = '2026-11-02';
let n = 0;
const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

function setup(o: { createdOn?: string; history?: { occurredAt: string; itemIds: string[] }[]; kind?: 'real' | 'rehearsal' | 'demo'; publicReadOnly?: boolean; items?: Item[]; script?: MockScript } = {}) {
  const dir = join(ROOT, '.data', 'test');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `f-${process.pid}-${++n}.db`);
  const ledger = new SqliteLedger(path, { kill: { on: false, setAt: null, ttlMs: KILL_TTL_MS }, caps: PROVISIONAL_CAPS });
  const extras = new ExtrasStore(path);
  const lib = createPhotoLibrary();
  const now = new Date(`${TODAY}T09:00:00+09:00`);
  const { ports } = createMockPorts(lib, { sleep: async () => {}, nowMs: () => 0, nowIso: () => now.toISOString() }, o.script ?? {});
  const svc = new CloserService({ ledger, ports, photos: lib, mode: 'mock', clock: { now: () => now, today: () => TODAY } });
  const feat = new FeatureService({ ledger, extras, today: () => TODAY, now: () => now });
  const ws = 'ws-f';
  const kind = o.kind ?? (o.history ? 'rehearsal' : 'real');
  ledger.createWorkspace({ workspaceId: ws, kind, publicReadOnly: o.publicReadOnly ?? false, seedRef: 'closet', createdOn: o.createdOn ?? addDays(TODAY, -75) }, { items: o.items ?? closetItems(), since: o.createdOn ?? addDays(TODAY, -75) });
  let i = 0;
  for (const h of o.history ?? []) {
    ok(svc.recordPastWear(ws, { eventId: `hist-${++i}`, actor: 'demo_script', expectedRevision: ledger.getWorkspace(ws)!.ledgerRevision, itemIds: h.itemIds, occurredAt: h.occurredAt }));
  }
  cleanups.push(() => {
    ledger.close();
    extras.close();
    for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
  });
  const rev = () => ledger.getWorkspace(ws)!.ledgerRevision;
  return { ledger, extras, svc, feat, ws, rev };
}

const asOp = (x: unknown): Operation => {
  assert.ok(isOp(x), `expected an operation, got ${JSON.stringify(x)}`);
  return x;
};

describe('F1 anchor: keep what the owner chose, complete the rest', () => {
  it('F1-01 every option keeps J1, uses owned available items, at most two options', () => {
    const t = setup();
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: ['J1'] }));
    assert.equal(op.state, 'PROPOSED');
    assert.ok(op.options.length >= 1 && op.options.length <= 2);
    const items = factsFromState(t.ledger.readState(t.ws)).items;
    for (const o of op.options) {
      assert.equal(o.outfit.outer, 'J1');
      for (const s of ['top', 'bottom', 'shoes'] as const) assert.ok(o.outfit[s] && items.has(o.outfit[s]!), `${s} filled with an owned item`);
      assert.ok(o.reasonLines.includes('J1 kept · you chose it'));
    }
  });

  it('F1-02 an item in the laundry is never proposed; the lock stays', () => {
    const t = setup();
    ok(t.svc.setAvailability(t.ws, { eventId: 'e-l', actor: 'human', expectedRevision: t.rev(), itemId: 'B1', state: 'LAUNDRY' }));
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: ['J1'] }));
    assert.equal(op.state, 'PROPOSED');
    assert.ok(op.options.length >= 1);
    for (const o of op.options) {
      assert.equal(o.outfit.outer, 'J1');
      assert.notEqual(o.outfit.bottom, 'B1');
    }
  });

  it('F1-03 rain and a non-waterproof locked jacket: ask instead of a silent swap', () => {
    const t = setup();
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: ['J1'], rainPct: 80 }));
    assert.equal(op.state, 'HOLD');
    assert.ok(op.reasonCodes.includes('PIN_CONFLICT'));
    assert.deepEqual(op.questions[0].choices, ['keep', 'switch']);
    // The owner said yes or no to rain; no percentage is shown (there is no weather service).
    assert.equal(op.questions[0].text, 'J1 is not waterproof and you said rain is likely today. Keep it anyway, or switch it?');
    assert.doesNotMatch(op.questions[0].text, /%/);
    assert.equal(op.options.length, 0);
  });

  it('F1-04 a locked item in the laundry is a question, not a substitute', () => {
    const t = setup();
    ok(t.svc.setAvailability(t.ws, { eventId: 'e-l2', actor: 'human', expectedRevision: t.rev(), itemId: 'J1', state: 'LAUNDRY' }));
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: ['J1'] }));
    assert.equal(op.state, 'HOLD');
    assert.ok(op.reasonCodes.includes('PIN_CONFLICT'));
  });

  it('F1-05 no available shoes: hold with a link to Discover instead of a forced outfit', () => {
    const t = setup();
    for (const id of ['S1', 'S2']) ok(t.svc.setAvailability(t.ws, { eventId: `e-${id}`, actor: 'human', expectedRevision: t.rev(), itemId: id, state: 'REPAIR' }));
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: ['J1'] }));
    assert.equal(op.state, 'HOLD');
    assert.ok(op.reasonCodes.includes('NO_VALID_COMBO'));
    assert.deepEqual(op.questions[0].choices, ['discover', 'skip']);
    assert.match(op.questions[0].text, /shoes/);
  });

  it('F1-06 pick → save → read back: the plan holds J1; a later laundry change keeps J1', () => {
    const t = setup();
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: ['J1'] }));
    const res = t.svc.lock(t.ws, { eventId: 'e-lock', actor: 'human', expectedRevision: t.rev(), operationId: op.operationId, optionIndex: 0 });
    ok(res);
    const plan = t.ledger.readState(t.ws, { fresh: true }).plans.find((p) => p.planId === op.planId)!;
    assert.equal(plan.state, 'LOCKED');
    assert.equal(plan.slots.outer, 'J1');
    assert.deepEqual(plan.pinned, ['J1']);
    const changed = plan.slots.bottom!;
    const r = t.svc.setAvailability(t.ws, { eventId: 'e-wash', actor: 'human', expectedRevision: t.rev(), itemId: changed, state: 'LAUNDRY' });
    ok(r);
    assert.ok((r.replans ?? []).length >= 1, 'the locked plan using that item is re-planned');
    for (const rp of r.replans ?? []) {
      assert.ok(rp.options.length >= 1 || rp.state === 'HOLD');
      for (const o of rp.options) assert.equal(o.outfit.outer, 'J1');
    }
  });

  it('F1-07 two items in the same slot cannot both be locked', () => {
    const t = setup();
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: ['J1', 'J2'] }));
    assert.equal(op.state, 'HOLD');
  });
});

describe('F2 the 60-day review counts records, not guesses', () => {
  it('F2-01 never-recorded items with enough records become candidates; the line only speaks of records', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const r = t.feat.review(t.ws);
    const by = Object.fromEntries(r.rows.map((x) => [x.itemId, x]));
    assert.equal(by.J1.status, 'CANDIDATE');
    assert.equal(by.B3.status, 'CANDIDATE');
    assert.equal(by.J2.status, 'CANDIDATE');
    assert.equal(by.B2.status, 'RECENT_WEAR');
    assert.equal(by.J1.recordedDays, 45);
    assert.equal(by.J1.unrecordedDays, 15);
    const claimsUnused = new RegExp(['not ' + 'worn', 'never ' + 'worn', '안 ' + '입', 'un' + 'worn'].join('|'), 'i');
    for (const row of r.rows) assert.doesNotMatch(row.line, claimsUnused);
  });

  it('F2-02 a new wardrobe has too few days to judge', () => {
    const t = setup({ createdOn: addDays(TODAY, -10) });
    const r = t.feat.review(t.ws);
    assert.ok(r.rows.every((x) => x.status === 'TOO_NEW'));
  });

  it('F2-03 sparse records are reported as too few records', () => {
    const hist = closetHistory(TODAY).filter((_, i) => i % 6 === 0);
    const t = setup({ history: hist });
    const r = t.feat.review(t.ws);
    assert.equal(r.rows.find((x) => x.itemId === 'J1')!.status, 'LOW_RECORDS');
    assert.equal(r.rows.filter((x) => x.status === 'CANDIDATE').length, 0);
  });

  it('F2-04 a seasonal keep and a stored item are left out until their date', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const e = t.feat.exempt(t.ws, { itemId: 'J2', reason: 'season', reviewAfter: '2027-01-15' });
    assert.ok(!('ok' in e));
    ok(t.svc.setAvailability(t.ws, { eventId: 'e-st', actor: 'demo_script', expectedRevision: t.rev(), itemId: 'B3', state: 'STORED' }));
    const by = Object.fromEntries(t.feat.review(t.ws).rows.map((x) => [x.itemId, x]));
    assert.equal(by.J2.status, 'EXEMPT');
    assert.equal(by.B3.status, 'EXEMPT');
    assert.equal(by.J1.status, 'CANDIDATE');
    const past = t.feat.exempt(t.ws, { itemId: 'J1', reason: 'season', reviewAfter: TODAY });
    assert.equal((past as { ok: false }).ok, false);
  });

  it('F2-05 the window is the owner\'s choice within 14–365 days', () => {
    const t = setup({ history: closetHistory(TODAY) });
    assert.equal(t.feat.review(t.ws, 5).windowDays, 14);
    assert.equal(t.feat.review(t.ws, 999).windowDays, 365);
  });

  it('F2-06 review choices and notes do not touch the wardrobe ledger', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const before = t.ledger.stateHash(t.ws);
    t.feat.choose(t.ws, { itemId: 'J1', action: 'restyle' });
    t.feat.addEvidence(t.ws, { itemId: 'J1', platform: 'KARROT', priceType: 'ASK', amount: 90000, currency: 'KRW', retrievedAt: TODAY, matchLevel: 'SIMILAR' });
    t.feat.draft(t.ws, { itemId: 'J1', kind: 'DONATE' });
    assert.equal(t.ledger.stateHash(t.ws), before);
  });
});

describe('F2 price cards and hand-off drafts', () => {
  it('F2-10 one card per platform; asking prices stay separate; nothing averaged', () => {
    const cards = priceCards('J1', sampleEvidence(TODAY));
    assert.deepEqual(cards.map((c) => c.platform), ['KREAM', 'KARROT', 'BUNJANG', 'MUSINSA_USED', 'POSHMARK', 'EBAY', 'GRAILED', 'DEPOP', 'STOCKX', 'VINTED']);
    const karrot = cards.find((c) => c.platform === 'KARROT')!;
    // newest first: the 120,000 asking price (3 days ago), the 90,000 trade (10 days ago), the 85,000 asking price (21 days ago)
    assert.deepEqual(karrot.entries.map((e) => [e.amount, e.priceType]), [[120000, 'ASK'], [90000, 'TRADE'], [85000, 'ASK']]);
    assert.ok(karrot.entries.every((e) => e.source === 'sample'));
    assert.equal(cards.find((c) => c.platform === 'KREAM')!.status, 'NO_EVIDENCE');
    assert.equal(cards.find((c) => c.platform === 'POSHMARK')!.entries[0].currency, 'USD');
    for (const c of cards) assert.equal('average' in c || 'median' in c || 'range' in c, false);
  });

  it('F2-11 evidence must carry platform currency, price type, match level and an https link', () => {
    assert.match(validateEvidence({ platform: 'POSHMARK', priceType: 'ASK', amount: 50000, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: TODAY })!, /USD/);
    assert.match(validateEvidence({ platform: 'KARROT', amount: 1, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: TODAY })!, /priceType/);
    assert.match(validateEvidence({ platform: 'KARROT', priceType: 'ASK', amount: 1, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: TODAY, url: 'javascript:alert(1)' })!, /https/);
    assert.equal(validateEvidence({ platform: 'KREAM', priceType: 'TRADE', amount: 1, currency: 'KRW', matchLevel: 'SAME_ITEM', retrievedAt: TODAY, url: 'https://example.com/x' }), null);
  });

  it('F2-18 international platforms: own currency, no fee values shipped, English draft that asks to check the country', () => {
    for (const p of PLATFORMS) {
      assert.ok(['KRW', 'USD', 'EUR'].includes(PLATFORM_INFO[p].currency), p);
      assert.ok(PLATFORM_INFO[p].notes.length >= 2, p);
      // notes name what to check; they never state a fee percentage
      for (const n of PLATFORM_INFO[p].notes) assert.doesNotMatch(n, /\d+(\.\d+)?\s*%/, `${p}: ${n}`);
    }
    assert.match(validateEvidence({ platform: 'VINTED', priceType: 'ASK', amount: 40, currency: 'USD', matchLevel: 'SIMILAR', retrievedAt: TODAY })!, /EUR/);
    assert.equal(validateEvidence({ platform: 'VINTED', priceType: 'ASK', amount: 40, currency: 'EUR', matchLevel: 'SIMILAR', retrievedAt: TODAY }), null);
    const v = netScenario(40, 'EUR', [{ label: 'Shipping', kind: 'fixed', value: null }]);
    assert.equal(v.net, null);
    assert.equal(netScenario(40, 'EUR', [{ label: 'Shipping', kind: 'fixed', value: 4.5 }]).line.includes('€35.50'), true);
    const item = closetItems().find((i) => i.itemId === 'J1')!;
    const d = sellDraft(item, 'VINTED', { brand: null, size: null, condition: null, purchased: null } as never, { amount: 40, currency: 'EUR' });
    assert.match(d.body, /Price: €40\.00/);
    assert.match(d.body, /Check that Vinted accepts listings and shipping from your country/);
    const b = sellDraft(item, 'BUNJANG', { brand: null, size: null, condition: null, purchased: null } as never, null);
    assert.match(b.body, /거래 방법/);
  });

  it('F2-19 Musinsa Used (KRW) and StockX (USD): own currency only, notes without fee values, a Korean and an English draft, blank costs stay unknown', () => {
    assert.deepEqual([...PLATFORMS], ['KREAM', 'KARROT', 'BUNJANG', 'MUSINSA_USED', 'POSHMARK', 'EBAY', 'GRAILED', 'DEPOP', 'STOCKX', 'VINTED']);
    assert.deepEqual([PLATFORM_INFO.MUSINSA_USED.currency, PLATFORM_INFO.STOCKX.currency], ['KRW', 'USD']);
    assert.match(validateEvidence({ platform: 'MUSINSA_USED', priceType: 'ASK', amount: 50, currency: 'USD', matchLevel: 'SIMILAR', retrievedAt: TODAY })!, /KRW/);
    assert.equal(validateEvidence({ platform: 'MUSINSA_USED', priceType: 'ASK', amount: 70000, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: TODAY }), null);
    assert.match(validateEvidence({ platform: 'STOCKX', priceType: 'TRADE', amount: 70000, currency: 'KRW', matchLevel: 'SAME_ITEM', retrievedAt: TODAY })!, /USD/);
    assert.match(validateEvidence({ platform: 'STOCKX', priceType: 'TRADE', amount: 90, currency: 'EUR', matchLevel: 'SAME_ITEM', retrievedAt: TODAY })!, /USD/);
    assert.equal(validateEvidence({ platform: 'STOCKX', priceType: 'TRADE', amount: 90, currency: 'USD', matchLevel: 'SAME_ITEM', retrievedAt: TODAY }), null);
    for (const p of ['MUSINSA_USED', 'STOCKX'] as const) {
      assert.equal(PLATFORM_INFO[p].notes.length, 2, p);
      for (const n of PLATFORM_INFO[p].notes) {
        assert.doesNotMatch(n, /\d+(\.\d+)?\s*%/, `${p}: ${n}`);
        assert.doesNotMatch(n, /%/, `${p}: ${n}`);
      }
    }
    const cards = priceCards('J1', sampleEvidence(TODAY));
    assert.equal(cards.length, 10);
    assert.equal(cards.find((c) => c.platform === 'MUSINSA_USED')!.status, 'NO_EVIDENCE');
    assert.equal(cards.find((c) => c.platform === 'STOCKX')!.status, 'NO_EVIDENCE');
    const item = closetItems().find((i) => i.itemId === 'J1')!;
    const facts = { brand: null, size: null, condition: null, purchased: null } as never;
    const m = sellDraft(item, 'MUSINSA_USED', facts, { amount: 70000, currency: 'KRW' });
    assert.match(m.body, /가격: ₩70,000/);
    assert.match(m.body, /사이즈: \[확인\] \/ 상태: \[확인\]/);
    assert.match(m.body, /거래 방법.*\[확인\]/);
    assert.ok(m.toCheck.includes('whether Musinsa Used accepts this item'));
    const s = sellDraft(item, 'STOCKX', facts, { amount: 90, currency: 'USD' });
    assert.match(s.body, /Price: \$90\.00/);
    assert.match(s.body, /Check that StockX accepts listings and shipping from your country/);
    assert.ok(s.toCheck.includes('whether StockX serves your country'));
    const t = setup();
    const r = t.feat.net(90, 'STOCKX', [{ label: 'Transaction fee', kind: 'rate', value: null }, { label: 'Payment processing', kind: 'rate', value: null }, { label: 'Shipping to the buyer', kind: 'fixed', value: null }]) as { net: number | null; unknown: string[]; currency: string };
    assert.deepEqual({ currency: r.currency, net: r.net, unknown: r.unknown }, { currency: 'USD', net: null, unknown: ['Transaction fee', 'Payment processing', 'Shipping to the buyer'] });
    const k = t.feat.net(70000, 'MUSINSA_USED', [{ label: 'Sales fee', kind: 'rate', value: null }, { label: 'Shipping', kind: 'fixed', value: null }]) as { net: number | null; unknown: string[]; currency: string };
    assert.deepEqual({ currency: k.currency, net: k.net, unknown: k.unknown }, { currency: 'KRW', net: null, unknown: ['Sales fee', 'Shipping'] });
  });

  it('F2-12 an unknown fee makes the net unknown instead of zero', () => {
    const s = netScenario(100000, 'KRW', [{ label: 'platform fee', kind: 'rate', value: null }, { label: 'shipping', kind: 'fixed', value: 3500 }]);
    assert.equal(s.net, null);
    assert.deepEqual(s.unknown, ['platform fee']);
    const k = netScenario(100000, 'KRW', [{ label: 'shipping', kind: 'fixed', value: 3500 }]);
    assert.equal(k.net, 96500);
    assert.match(k.line, /Not a guarantee/);
  });

  it('F2-16 net calculator: blank fees stay unknown, typed 0 counts, rates are shares of the price', () => {
    const t = setup();
    const r1 = t.feat.net(100000, 'KARROT', [{ label: 'Delivery', kind: 'fixed', value: null }]) as { net: number | null; unknown: string[] };
    assert.equal(r1.net, null);
    assert.deepEqual(r1.unknown, ['Delivery']);
    const r2 = t.feat.net(100000, 'KARROT', [{ label: 'Delivery', kind: 'fixed', value: 0 }]) as { net: number | null };
    assert.equal(r2.net, 100000);
    const r3 = t.feat.net(80, 'POSHMARK', [{ label: 'Platform fee', kind: 'rate', value: 0.2 }, { label: 'Shipping', kind: 'fixed', value: 7.97 }]) as { net: number | null; currency: string };
    assert.equal(r3.currency, 'USD');
    assert.equal(r3.net, 56.03);
    const r4 = t.feat.net(99999, 'KREAM', [{ label: 'Sales fee', kind: 'rate', value: 0.075 }]) as { net: number | null };
    assert.equal(r4.net, 92499);
  });

  it('F2-17 net calculator refuses inputs it cannot read honestly', () => {
    const t = setup();
    const code = (x: unknown) => (x as { code?: string }).code;
    assert.equal(code(t.feat.net(0, 'KARROT', [])), 'INVALID_TRANSITION');
    assert.equal(code(t.feat.net(1000, 'KARROT', [{ label: 'Fee', kind: 'rate', value: 15 }])), 'INVALID_TRANSITION');
    assert.equal(code(t.feat.net(1000, 'KARROT', [{ label: 'Fee', kind: 'fixed', value: -1 }])), 'INVALID_TRANSITION');
    assert.equal(code(t.feat.net(1000, 'KARROT', [{ label: '', kind: 'fixed', value: 1 }])), 'INVALID_TRANSITION');
    assert.equal(code(t.feat.net(1000, 'NOT_A_PLATFORM' as never, [])), 'INVALID_TRANSITION');
    assert.equal(code(t.feat.net(1000, 'KARROT', Array.from({ length: 11 }, () => ({ label: 'x', kind: 'fixed', value: 1 })))), 'INVALID_TRANSITION');
    // Cost lines in any other shape are refused, not read as "no cost lines".
    assert.match((t.feat.net(1000, 'KARROT', 'x') as { detail: string }).detail, /fees must be a list/);
    assert.match((t.feat.net(1000, 'KARROT', { label: 'Fee' }) as { detail: string }).detail, /fees must be a list/);
  });

  it('F2-13 a sale draft keeps [확인] placeholders; it cannot be marked reviewed until they are filled', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const d = t.feat.draft(t.ws, { itemId: 'J1', kind: 'SELL', platform: 'KARROT', facts: { size: 'M' } });
    assert.ok(!('ok' in d));
    assert.match(d.body, /\[확인\]/);
    assert.ok(d.toCheck.includes('brand'));
    const refused = t.feat.moveDraft(t.ws, { draftId: d.draftId, to: 'REVIEWED' });
    assert.equal((refused as { code: string }).code, 'NEEDS_CHECK');
    const skip = t.feat.moveDraft(t.ws, { draftId: d.draftId, to: 'OWNER_REPORTED_DONE' });
    assert.equal((skip as { ok: false }).ok, false);
    const edited = d.body.replace(/\[확인\]/g, '확인함').replace('[브랜드]', '브랜드A');
    const rv = t.feat.moveDraft(t.ws, { draftId: d.draftId, to: 'REVIEWED', body: edited });
    assert.equal((rv as { state: string }).state, 'REVIEWED');
    const done = t.feat.moveDraft(t.ws, { draftId: d.draftId, to: 'OWNER_REPORTED_DONE' });
    assert.equal((done as { state: string }).state, 'OWNER_REPORTED_DONE');
    assert.deepEqual([...HANDOFF_STATES], ['DRAFT', 'REVIEWED', 'OWNER_REPORTED_DONE']);
  });

  it('F2-14 donation drafts promise nothing about acceptance, pickup or tax', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const d = t.feat.draft(t.ws, { itemId: 'J2', kind: 'DONATE' });
    assert.ok(!('ok' in d));
    assert.match(d.body, /does not confirm acceptance, pickup, receipts or any tax benefit/);
  });

  it('F2-15 a read-only showcase refuses every owner write', () => {
    const t = setup({ kind: 'demo', publicReadOnly: true });
    assert.equal((t.feat.choose(t.ws, { itemId: 'J1', action: 'keep' }) as { code: string }).code, 'SCOPE_DENIED');
    assert.equal((t.feat.draft(t.ws, { itemId: 'J1', kind: 'DONATE' }) as { code: string }).code, 'SCOPE_DENIED');
    assert.equal((t.feat.addEvidence(t.ws, { itemId: 'J1' }) as { code: string }).code, 'SCOPE_DENIED');
  });
});

describe('F3 looks by occasion: rebuild with what you own first', () => {
  it('F3-01 wedding look: three pieces from the closet, shoes left as one optional gap', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const m = t.feat.matchLook(t.ws, 'L-WG1');
    assert.ok(!('ok' in m));
    assert.deepEqual(m.pieces.map((p) => [p.piece.slot, p.level, p.itemId]), [
      ['outer', 'SAME', 'J1'], ['top', 'SAME', 'T1'], ['bottom', 'SAME', 'B1'], ['shoes', 'NONE', null],
    ]);
    assert.equal(m.reused, 3);
    assert.equal(m.gaps.length, 1);
    assert.deepEqual(m.gaps[0].choices, ['use_mine', 'skip', 'later', 'open_link']);
    assert.ok(m.gaps[0].alternatives.includes('S1'));
  });

  it('F3-02 workout look: same pieces, a similar one, and a gap', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const m = t.feat.matchLook(t.ws, 'L-WO1');
    assert.ok(!('ok' in m));
    const lv = Object.fromEntries(m.pieces.map((p) => [p.piece.slot, [p.level, p.itemId]]));
    assert.deepEqual(lv.outer, ['SAME', 'J3']);
    assert.deepEqual(lv.bottom, ['SAME', 'B4']);
    assert.deepEqual(lv.shoes, ['SIMILAR', 'S2']);
    assert.equal(lv.top[0], 'NONE');
  });

  it('F3-03 "outfits added" is a count on this wardrobe, and no shop link is invented', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const m = t.feat.matchLook(t.ws, 'L-WG1');
    assert.ok(!('ok' in m));
    const pool = [...factsFromState(t.ledger.readState(t.ws)).items.values()];
    const gap = m.gaps[0];
    const hypo: Item = { itemId: 'NEW', slot: 'shoes', type: gap.piece.type, color: gap.piece.color, formality: gap.piece.formality, ownership: 'CONFIRMED', cutoutRef: null, origin: 'seed', waterproof: null, sample: true };
    assert.equal(gap.outfitsAdded, countOutfits([...pool, hypo]) - countOutfits(pool));
    assert.ok(m.fullLook.every((p) => p.shop.url === null && p.shop.price === null));
  });

  it('F3-04 an item in the laundry is not used to rebuild a look', () => {
    const t = setup({ history: closetHistory(TODAY) });
    ok(t.svc.setAvailability(t.ws, { eventId: 'e-t1', actor: 'demo_script', expectedRevision: t.rev(), itemId: 'T1', state: 'LAUNDRY' }));
    const m = t.feat.matchLook(t.ws, 'L-WG1');
    assert.ok(!('ok' in m));
    assert.notEqual(m.pieces.find((p) => p.piece.slot === 'top')!.itemId, 'T1');
  });

  it('F3-05 a rebuilt look becomes locks for "오늘은 이 옷"', () => {
    const t = setup();
    const m = t.feat.matchLook(t.ws, 'L-OF1');
    assert.ok(!('ok' in m));
    const anchors = Object.values(m.ownOutfit) as string[];
    const op = asOp(t.svc.startAnchor(t.ws, { anchorItemIds: anchors }));
    assert.equal(op.state, 'PROPOSED');
    assert.ok(op.options.length >= 1);
    for (const id of anchors) assert.ok(Object.values(op.options[0].outfit).includes(id));
  });
});

describe('F3 style targets: a counted match and an item box, nothing estimated', () => {
  it('F3-06 one target: coverage is a count of same + similar pieces over the pieces of the look', () => {
    const t = setup({ history: closetHistory(TODAY) });
    assert.deepEqual(t.feat.setTarget(t.ws, { lookId: 'L-WG1', on: true }), { targets: ['L-WG1'] });
    const c = t.feat.collection(t.ws);
    assert.deepEqual(c.targets, ['L-WG1']);
    assert.equal(c.looks.length, 1);
    assert.deepEqual(c.looks[0].coverage, { matched: 3, total: 4, exact: 3, similar: 0, missing: 1, pct: 75, line: '3 of 4 pieces from your closet (3 same, 0 similar, 1 missing)' });
    assert.equal(c.matched, 3);
    assert.equal(c.total, 4);
    assert.equal(c.pct, 75);
    assert.equal(c.complete, 0);
    assert.match(c.basis, /^Counted on the \d+ available items/);
  });

  it('F3-07 two targets aggregate; the box merges the navy jacket both looks ask for into one FILLED cell', () => {
    const t = setup({ history: closetHistory(TODAY) });
    t.feat.setTarget(t.ws, { lookId: 'L-WG1', on: true });
    assert.deepEqual(t.feat.setTarget(t.ws, { lookId: 'L-OF1', on: true }), { targets: ['L-WG1', 'L-OF1'] });
    const c = t.feat.collection(t.ws);
    const of1 = t.feat.matchLook(t.ws, 'L-OF1');
    assert.ok(!('ok' in of1));
    assert.equal(c.total, 8);
    assert.equal(c.matched, 3 + of1.reused);
    assert.equal(c.pct, Math.round((100 * c.matched) / 8));
    assert.ok(c.pct <= 100);
    const jacket = c.box.find((e) => e.key === 'outer:jacket:navy');
    assert.ok(jacket);
    assert.equal(jacket.state, 'FILLED');
    assert.equal(jacket.itemId, 'J1');
    assert.deepEqual(jacket.lookIds, ['L-WG1', 'L-OF1']);
    assert.equal(jacket.outfitsAdded, null);
    // 7 distinct pieces across the two looks: the jacket is shared
    assert.equal(c.box.length, 7);
    // every EMPTY cell carries the counted "outfits added" number from its gap card, never an estimate
    for (const e of c.box) {
      if (e.state === 'EMPTY') assert.equal(typeof e.outfitsAdded, 'number');
      else assert.equal(e.outfitsAdded, null);
    }
    const shoes = c.box.find((e) => e.key === 'shoes:loafers:brown');
    assert.ok(shoes && shoes.state === 'EMPTY');
    const wg1 = c.looks.find((l) => l.lookId === 'L-WG1');
    assert.equal(shoes.outfitsAdded, wg1!.gaps[0].outfitsAdded);
    assert.ok(c.nextUp.length >= 1 && c.nextUp.length <= 3);
    assert.ok(c.nextUp.every((e) => e.state === 'EMPTY'));
  });

  it('F3-08 removing a target and asking with no targets gives counts of zero, not a made-up number', () => {
    const t = setup({ history: closetHistory(TODAY) });
    t.feat.setTarget(t.ws, { lookId: 'L-WG1', on: true });
    assert.deepEqual(t.feat.setTarget(t.ws, { lookId: 'L-WG1', on: false }), { targets: [] });
    const c = t.feat.collection(t.ws);
    assert.deepEqual(c.targets, []);
    assert.equal(c.total, 0);
    assert.equal(c.pct, 0);
    assert.deepEqual(c.box, []);
    assert.deepEqual(c.nextUp, []);
  });

  it('F3-09 an unknown look is refused; a read-only showcase cannot set targets', () => {
    const t = setup({ history: closetHistory(TODAY) });
    assert.equal((t.feat.setTarget(t.ws, { lookId: 'L-NOPE', on: true }) as { code: string }).code, 'INVALID_TRANSITION');
    const ro = setup({ kind: 'demo', publicReadOnly: true });
    assert.equal((ro.feat.setTarget(ro.ws, { lookId: 'L-WG1', on: true }) as { code: string }).code, 'SCOPE_DENIED');
    assert.deepEqual(ro.feat.collection(ro.ws).targets, []);
  });

  it('F3-10 the count moves only when the closet does: laundry takes a piece out, the match falls', () => {
    const t = setup({ history: closetHistory(TODAY) });
    t.feat.setTarget(t.ws, { lookId: 'L-WG1', on: true });
    assert.equal(t.feat.collection(t.ws).pct, 75);
    ok(t.svc.setAvailability(t.ws, { eventId: 'e-tg', actor: 'human', expectedRevision: t.rev(), itemId: 'T1', state: 'LAUNDRY' }));
    const c = t.feat.collection(t.ws);
    assert.equal(c.matched, 2);
    assert.equal(c.pct, 50);
    const top = c.box.find((e) => e.slot === 'top');
    assert.ok(top && top.state !== 'FILLED');
    assert.notEqual(top.itemId, 'T1');
  });
});

describe('F4 closet in 3D: same pieces and states as My closet, nothing computed of its own', () => {
  const anatomyOf = (t: ReturnType<typeof setup>) => {
    const v = t.svc.view(t.ws) as unknown as { items: { itemId: string; slot: string; availability: string; wearCount: number }[] };
    const r = t.feat.review(t.ws, 60);
    return { v, r, a: buildAnatomy(v.items, r.rows) };
  };

  it('F4-01 every piece appears once, on its own layer, with the counts My closet shows', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const { v, r, a } = anatomyOf(t);
    const drawn = a.layers.flatMap((l: { slot: string; items: { itemId: string; slot: string }[] }) => l.items.map((c) => { assert.equal(c.slot, l.slot); return c.itemId; }));
    assert.equal(a.counts.total, v.items.length);
    assert.deepEqual([...drawn].sort(), v.items.map((i) => i.itemId).sort());
    assert.deepEqual(a.counts.unplaced, []);
    for (const slot of ['outer', 'top', 'bottom', 'shoes']) assert.equal(a.counts.bySlot[slot], v.items.filter((i) => i.slot === slot).length);
    const avail: Record<string, number> = {};
    for (const i of v.items) avail[i.availability] = (avail[i.availability] ?? 0) + 1;
    assert.deepEqual(a.counts.byAvailability, avail);
    const rev: Record<string, number> = {};
    for (const row of r.rows) rev[row.status] = (rev[row.status] ?? 0) + 1;
    assert.deepEqual(a.counts.byReview, rev);
  });

  it('F4-02 the 3D view follows the closet: laundry shows on the piece, the total does not change', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const before = anatomyOf(t).a;
    ok(t.svc.setAvailability(t.ws, { eventId: 'e-3d', actor: 'human', expectedRevision: t.rev(), itemId: 'B1', state: 'LAUNDRY' }));
    const after = anatomyOf(t).a;
    assert.equal(after.counts.total, before.counts.total);
    const b1 = after.layers.flatMap((l: { items: { itemId: string; availability: string }[] }) => l.items).find((c: { itemId: string }) => c.itemId === 'B1');
    assert.equal(b1.availability, 'LAUNDRY');
    assert.equal(after.counts.byAvailability.LAUNDRY, (before.counts.byAvailability.LAUNDRY ?? 0) + 1);
  });

  it('F4-03 the 3D data carries no prices, values or estimates', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const keys = new Set<string>();
    const walk = (o: unknown) => { if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { keys.add(k); walk(x); } };
    walk(anatomyOf(t).a);
    for (const k of keys) assert.doesNotMatch(k, /price|amount|value|net|estimate|worth/i, `unexpected key ${k}`);
  });
});

describe('F1 sentence path: Spark reads the words, code checks them', () => {
  const items = closetItems().map((i) => ({ itemId: i.itemId, slot: i.slot, type: i.type, color: i.color }));

  it('F1-10 Korean sentence → keep J1, more relaxed; options keep J1', async () => {
    const t = setup();
    const op = asOp(await t.svc.startAnchorFromSentence(t.ws, { sentence: '오늘은 이 네이비 재킷 입고 싶어. 나머지는 좀 편하게.' }));
    assert.deepEqual(op.intent, { anchors: ['J1'], direction: 'less_formal', rain: false });
    assert.equal(op.modelCalls, 1);
    assert.equal(op.state, 'PROPOSED', JSON.stringify(op.questions));
    assert.ok(op.options.length >= 1);
    const facts = factsFromState(t.ledger.readState(t.ws));
    assert.deepEqual(op.options.map((o) => o.label), ['A gentler step', 'Closer to what you said']);
    for (const o of op.options) {
      assert.equal(o.outfit.outer, 'J1');
      // below an all-high outfit (jacket level × 4 pieces)
      assert.ok(o.sum! < 3 * 4);
    }
    // the option closest to the words: no other piece is as formal as the jacket
    const closest = op.options[1];
    for (const s of ['top', 'bottom', 'shoes'] as const) assert.notEqual(facts.items.get(closest.outfit[s]!)!.formality, 'high');
  });

  it('F1-11 "the jacket" with two jackets is a question, not a guess', async () => {
    const extra = { ...closetItems().find((i) => i.itemId === 'J1')!, itemId: 'J4', color: 'gray' as const };
    const u = setup({ items: [...closetItems(), extra] });
    const op = asOp(await u.svc.startAnchorFromSentence(u.ws, { sentence: 'Keep the jacket today' }));
    assert.equal(op.state, 'HOLD');
    assert.ok(op.reasonCodes.includes('AMBIGUOUS_REFERENCE'));
    assert.deepEqual(op.questions[0].choices.sort(), ['J1', 'J4']);
  });

  it('F1-12 a model answer naming an item the owner does not have is rejected', () => {
    const c = checkIntent({ keep: ['J9'], direction: 'none', rain: false, unclear: [] }, items);
    assert.equal(c.ok, false);
    assert.equal((c as { kind: string }).kind, 'invalid');
  });

  it('F1-13 two locks in one slot are sent back as a question', () => {
    const c = checkIntent({ keep: ['J1', 'J2'], direction: 'none', rain: false, unclear: [] }, items);
    assert.deepEqual(c, { ok: false, kind: 'unclear', phrase: 'two outer pieces', candidates: ['J1', 'J2'] });
  });

  it('F1-18 "white sneakers, something smart": the rest is dressier than the sneakers', async () => {
    const t = setup();
    const op = asOp(await t.svc.startAnchorFromSentence(t.ws, { sentence: 'I want to wear the white sneakers, something smart for dinner.' }));
    assert.deepEqual(op.intent, { anchors: ['S2'], direction: 'more_formal', rain: false });
    assert.equal(op.state, 'PROPOSED');
    for (const o of op.options) assert.equal(o.outfit.shoes, 'S2');
  });

  it('F1-14 rain in the sentence reaches the rain rule (locked jacket is not waterproof → ask)', async () => {
    const t = setup();
    const op = asOp(await t.svc.startAnchorFromSentence(t.ws, { sentence: '네이비 재킷 입을래, 비 온대' }));
    assert.equal(op.state, 'HOLD');
    assert.ok(op.reasonCodes.includes('PIN_CONFLICT'));
  });

  it('F1-15 keyword baseline: explicit IDs win; "track jacket" is not "jacket"', () => {
    assert.deepEqual(rulesIntent('keep T1 and S2', items).keep, ['T1', 'S2']);
    assert.deepEqual(rulesIntent('black track jacket for a run', items).keep, ['J3']);
  });

  it('F1-16 a model output that breaks the schema is held, never applied', async () => {
    const t = setup({ script: { intent: () => textResponse('muse-spark-1.3', JSON.stringify({ keep: 'J1', direction: 'very_formal' }), 'intent') } });
    const op = asOp(await t.svc.startAnchorFromSentence(t.ws, { sentence: 'navy jacket' }));
    assert.equal(op.state, 'HOLD');
    assert.ok(op.reasonCodes.includes('INVALID_MODEL_OUTPUT'));
    assert.equal(op.options.length, 0);
  });

  it('F1-17 keyword baseline does not read 네이비 as rain', () => {
    assert.equal(rulesIntent('오늘은 네이비 재킷', items).rain, false);
    assert.equal(rulesIntent('네이비 재킷, 비 온대', items).rain, true);
  });
});

describe('F5 keep or let go: two sides of counted facts, a position saved as a snapshot, no probability', () => {
  const fees = (v: number | null, s: number | null) => [{ label: 'Platform fee', kind: 'rate' as const, value: v }, { label: 'Shipping', kind: 'fixed' as const, value: s }];

  it('F5-01 no cost line at all is "nothing checked", not "no costs": the net stays unknown', () => {
    const s = netScenario(100000, 'KRW', []);
    assert.equal(s.net, null);
    assert.equal(s.costStatus, 'NO_LINES');
    assert.match(s.line, /no cost line/i);
    assert.deepEqual(s.unknown, []);
  });

  it('F5-02 a typed 0 is a confirmed free line; a deleted line is simply absent', () => {
    const zero = netScenario(100000, 'KRW', [{ label: 'Shipping', kind: 'fixed', value: 0 }]);
    assert.equal(zero.net, 100000);
    assert.equal(zero.costStatus, 'CONFIRMED');
    assert.equal(zero.costs[0].status, 'CONFIRMED_ZERO');
    const blank = netScenario(100000, 'KRW', [{ label: 'Shipping', kind: 'fixed', value: null }]);
    assert.equal(blank.costs[0].status, 'UNKNOWN');
    assert.equal(blank.net, null);
    assert.notEqual(netScenario(100000, 'KRW', []).costStatus, zero.costStatus);
  });

  it('F5-03 100,000 at 5% plus 3,000 shipping leaves 92,000; the arithmetic is listed line by line', () => {
    const s = netScenario(100000, 'KRW', fees(0.05, 3000));
    assert.equal(s.net, 92000);
    assert.deepEqual(s.deductions, [{ label: 'Platform fee', amount: 5000 }, { label: 'Shipping', amount: 3000 }]);
    assert.equal(s.costs[0].status, 'CONFIRMED_VALUE');
  });

  it('F5-04 a negative net is kept as a negative number and said plainly', () => {
    const s = netScenario(1000, 'KRW', [{ label: 'Shipping', kind: 'fixed', value: 3000 }]);
    assert.equal(s.net, -2000);
    assert.match(s.line, /short/);
    const e = netScenario(10, 'EUR', [{ label: 'Shipping', kind: 'fixed', value: 12.5 }]);
    assert.equal(e.net, -2.5);
  });

  it('F5-05 the keep side repeats the review counts for the same window and shows no probability', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const v = t.feat.decisionView(t.ws, { itemId: 'J2', horizonDays: 60 }, sampleEvidence(TODAY));
    assert.ok(!('ok' in v));
    const row = t.feat.review(t.ws, 60).rows.find((r) => r.itemId === 'J2')!;
    assert.equal(v.keep.wearsCounted, row.wearsInWindow);
    assert.equal(v.keep.recordedDays, row.recordedDays);
    assert.equal(v.keep.trackedDays, row.trackedDays);
    assert.equal(v.keep.unrecordedDays, row.unrecordedDays);
    assert.equal(v.keep.horizonDays, 60);
    assert.equal(v.keep.resolvesOn, addDays(TODAY, 60));
    assert.match(v.keep.question, /Will I wear J2 \(beige coat\) in the next 60 days, by 2027-01-01\?/);
    assert.equal(v.keep.wearOutlook.value, null);
    assert.equal(v.keep.wearOutlook.status, 'NOT_COMPUTED');
    assert.doesNotMatch(v.keep.wearOutlook.line, /0 wears on record|chance/, 'the outlook line never states a count of its own');
    assert.doesNotMatch(JSON.stringify(v.keep), /%/);
    // no field carries a chance, score or estimate; the note may say in words that none is shown
    assert.doesNotMatch(JSON.stringify(v), /"(prob|chance|likelihood|estimate|score|pWear|pSell)[A-Za-z]*":/i);
    assert.ok(v.keep.missing.some((m) => /unknown/.test(m)));
    assert.ok(v.keep.missing.some((m) => /No upcoming use/.test(m)));
    const b3 = t.feat.decisionView(t.ws, { itemId: 'B3' }, sampleEvidence(TODAY));
    assert.ok(!('ok' in b3));
    assert.equal(b3.keep.horizonDays, 90);
    assert.ok(b3.evidence.every((e) => e.owner.count === 0 && e.sample.count === 0));
  });

  it('F5-06 prices the owner entered and sample prices are counted apart and never pooled', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const e = t.feat.addEvidence(t.ws, { itemId: 'J1', platform: 'KARROT', priceType: 'ASK', amount: 90000, currency: 'KRW', retrievedAt: TODAY, matchLevel: 'SIMILAR' });
    assert.ok(!('ok' in e));
    const v = t.feat.decisionView(t.ws, { itemId: 'J1' }, sampleEvidence(TODAY));
    assert.ok(!('ok' in v));
    const k = v.evidence.find((x) => x.platform === 'KARROT')!;
    assert.deepEqual({ c: k.owner.count, min: k.owner.min, max: k.owner.max }, { c: 1, min: 90000, max: 90000 });
    assert.deepEqual({ c: k.sample.count, min: k.sample.min, max: k.sample.max }, { c: 3, min: 85000, max: 120000 });
    assert.equal(k.owner.ids.some((id) => k.sample.ids.includes(id)), false);
    assert.doesNotMatch(JSON.stringify(v.evidence), /average|median|pooled/i);
    assert.match(k.line, /1 price you entered and 3 sample prices/);
    const kream = v.evidence.find((x) => x.platform === 'KREAM')!;
    assert.match(kream.line, /No price seen on KREAM yet/);
  });

  it('F5-07 a position is saved as a snapshot, read back, and comes back identical on every later read', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const before = t.ledger.stateHash(t.ws);
    const r = t.feat.decide(t.ws, { itemId: 'J2', choice: 'KEEP', horizonDays: 90, platform: 'KARROT', askPrice: 60000, fees: fees(null, 3000), namedUses: [{ label: 'Wedding', on: addDays(TODAY, 18) }] }, sampleEvidence(TODAY));
    assert.ok(!('ok' in r), JSON.stringify(r));
    const d = r.decision;
    assert.match(d.decisionId, /^d_/);
    assert.equal(d.choice, 'KEEP');
    assert.equal(d.schema, 'closer.decision.1');
    assert.equal(d.sell.calculatorVersion, 'closer.decision.1');
    assert.equal(typeof d.sourceRevision, 'string');
    assert.deepEqual(d.keep.namedUses, [{ label: 'Wedding', on: addDays(TODAY, 18) }]);
    assert.equal(d.sell.askStatus, 'ASSUMED');
    assert.equal(d.sell.scenario!.net, null);
    assert.deepEqual(d.sell.scenario!.unknown, ['Platform fee']);
    assert.deepEqual(d.sell.evidence.sample.ids, ['sample-4', 'sample-6']);
    const again = t.feat.decisions(t.ws, 'J2');
    assert.equal(again.length, 1);
    const { outcome: _o, ...stored } = again[0];
    assert.deepEqual(stored, d);
    assert.equal(JSON.stringify(t.feat.decisions(t.ws, 'J2')), JSON.stringify(again));
    const v = t.feat.decisionView(t.ws, { itemId: 'J2' }, sampleEvidence(TODAY));
    assert.ok(!('ok' in v));
    assert.equal(v.history[0].decisionId, d.decisionId);
    assert.deepEqual(v.keep.namedUses, d.keep.namedUses);
    assert.equal(t.ledger.stateHash(t.ws), before);
  });

  it('F5-08 the net inside a snapshot is computed here from the cost lines; typed costs give a number, blank or none stay unknown', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const a = t.feat.decide(t.ws, { itemId: 'J2', choice: 'SELL_PREPARE', platform: 'KREAM', askPrice: 100000, fees: fees(0.05, 3000) });
    assert.ok(!('ok' in a));
    assert.equal(a.decision.sell.scenario!.net, 92000);
    assert.equal(a.decision.sell.currency, 'KRW');
    assert.deepEqual(a.decision.sell.missing, ['No price seen on KREAM']);
    const b = t.feat.decide(t.ws, { itemId: 'J2', choice: 'DEFER', platform: 'VINTED', askPrice: 40, fees: [] });
    assert.ok(!('ok' in b));
    assert.equal(b.decision.sell.currency, 'EUR');
    assert.equal(b.decision.sell.scenario!.costStatus, 'NO_LINES');
    assert.equal(b.decision.sell.scenario!.net, null);
    assert.ok(b.decision.sell.missing.includes('No cost line checked'));
    const c = t.feat.decide(t.ws, { itemId: 'J2', choice: 'WEAR_ONCE', platform: 'KARROT' });
    assert.ok(!('ok' in c));
    assert.equal(c.decision.sell.askStatus, 'NOT_SET');
    assert.equal(c.decision.sell.scenario, null);
    assert.ok(c.decision.sell.missing.includes('No asking price chosen'));
    assert.equal(t.feat.decisions(t.ws).length, 3);
    assert.equal(t.feat.decisions(t.ws, 'J1').length, 0);
  });

  it('F5-09 a position needs a known piece, a listed choice, a listed horizon, a listed platform, sane uses, and a writable wardrobe', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const bad = (a: Parameters<typeof t.feat.decide>[1]) => (t.feat.decide(t.ws, a) as { ok: false; code: string; detail: string });
    assert.equal(bad({ itemId: 'NOPE', choice: 'KEEP', platform: 'KARROT' }).code, 'INVALID_TRANSITION');
    assert.match(bad({ itemId: 'J2', choice: 'SELL_NOW', platform: 'KARROT' }).detail, /choice must be one of KEEP, WEAR_ONCE, SELL_PREPARE, DEFER/);
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', horizonDays: 45, platform: 'KARROT' }).detail, /30, 60, 90/);
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', platform: 'MUSINSA' }).detail, /unknown platform/);
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', platform: 'KARROT', askPrice: -5 }).detail, /askPrice/);
    // A price or cost lines in the wrong shape are refused instead of being dropped from the saved position.
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', platform: 'KARROT', askPrice: '100000' }).detail, /askPrice must be a positive number or blank/);
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', platform: 'KARROT', fees: 'x' }).detail, /fees must be a list/);
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', platform: 'KARROT', namedUses: [{ label: 'Trip', on: addDays(TODAY, -1) }] }).detail, /in the past/);
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', platform: 'KARROT', namedUses: Array.from({ length: 6 }, (_, i) => ({ label: `u${i}`, on: null })) }).detail, /up to 5/);
    assert.match(bad({ itemId: 'J2', choice: 'KEEP', platform: 'KARROT', fees: [{ label: 'Fee', kind: 'rate', value: 5 }] }).detail, /share of the price/);
    const ro = setup({ publicReadOnly: true });
    assert.equal((ro.feat.decide(ro.ws, { itemId: 'J2', choice: 'KEEP', platform: 'KARROT' }) as { ok: false; code: string }).code, 'SCOPE_DENIED');
    const view = t.feat.decisionView(t.ws, { itemId: 'J2', horizonDays: 7 }) as { ok: false; detail: string };
    assert.match(view.detail, /30, 60, 90/);
  });

  it('F5-10 a position resolves by counted wear records after it, open until its date and closed on it', () => {
    const t = setup({ history: closetHistory(TODAY) });
    // A position taken 10 days ago on a 30-day horizon: still open today.
    const earlier = new FeatureService({ ledger: t.ledger, extras: t.extras, today: () => addDays(TODAY, -10), now: () => new Date(`${addDays(TODAY, -10)}T09:00:00+09:00`) });
    const open = earlier.decide(t.ws, { itemId: 'J2', choice: 'KEEP', horizonDays: 30, platform: 'KARROT' });
    assert.ok(!('ok' in open));
    // A position taken 40 days ago on a 30-day horizon: closed 10 days ago.
    const older = new FeatureService({ ledger: t.ledger, extras: t.extras, today: () => addDays(TODAY, -40), now: () => new Date(`${addDays(TODAY, -40)}T09:00:00+09:00`) });
    const closed = older.decide(t.ws, { itemId: 'J2', choice: 'DEFER', horizonDays: 30, platform: 'KARROT' });
    assert.ok(!('ok' in closed));
    for (const [i, d] of [[1, -35], [2, -7], [3, -2]] as const) {
      ok(t.svc.recordPastWear(t.ws, { eventId: `w-j2-${i}`, actor: 'demo_script', expectedRevision: t.rev(), itemIds: ['J2'], occurredAt: addDays(TODAY, d) }));
    }
    const by = Object.fromEntries(t.feat.decisions(t.ws, 'J2').map((d) => [d.decisionId, d.outcome]));
    const o = by[open.decision.decisionId];
    assert.equal(o.status, 'OPEN');
    assert.equal(o.wearsSince, 2);
    assert.equal(o.daysElapsed, 10);
    assert.equal(o.daysTotal, 30);
    assert.match(o.line, /^Open: 2 confirmed wears since the decision, 10 of 30 days passed/);
    const c = by[closed.decision.decisionId];
    assert.equal(c.status, 'CLOSED');
    assert.equal(c.wearsSince, 1);
    assert.equal(c.daysElapsed, 30);
    assert.match(c.line, /^Closed on 2026-10-23: 1 confirmed wear in the 30 days after the decision/);
    assert.match(c.line, /Days without a record stay unknown/);
    // The snapshots themselves did not change when the wears were recorded.
    assert.equal(t.extras.decision(t.ws, open.decision.decisionId)!.keep.wearsCounted, open.decision.keep.wearsCounted);
  });
});

describe('F7 re-check and idempotent save: a saved position says when its facts moved, and one key saves once', () => {
  const KEY = 'tap-0123456789ab';
  const take = (t: ReturnType<typeof setup>, extra: { clientKey?: string; askPrice?: number } = {}, feat: FeatureService = t.feat) =>
    feat.decide(t.ws, { itemId: 'J2', choice: 'KEEP', horizonDays: 90, platform: 'KARROT', askPrice: 60000, fees: [{ label: 'Delivery', kind: 'fixed', value: 3000 }], ...extra }, sampleEvidence(TODAY));

  it('F7-01 the same clientKey twice is one row: the second call returns the saved snapshot with duplicate: true', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const a = take(t, { clientKey: KEY });
    assert.ok(!('ok' in a), JSON.stringify(a));
    assert.equal(a.duplicate, undefined);
    const b = take(t, { clientKey: KEY });
    assert.ok(!('ok' in b), JSON.stringify(b));
    assert.equal(b.duplicate, true);
    assert.deepEqual(b.decision, a.decision);
    assert.equal(b.outcome.status, 'OPEN');
    assert.equal(t.feat.decisions(t.ws, 'J2').length, 1);
    assert.equal(t.extras.decisionByKey(t.ws, KEY)!.decisionId, a.decision.decisionId);
  });

  it('F7-02 the same key on different facts (another asking price) is refused, never saved over; a malformed key is refused', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const a = take(t, { clientKey: KEY });
    assert.ok(!('ok' in a));
    const b = take(t, { clientKey: KEY, askPrice: 70000 }) as { ok: false; code: string; detail: string };
    assert.equal(b.ok, false);
    assert.equal(b.code, 'INVALID_TRANSITION');
    assert.match(b.detail, /already saved on different facts; open it again/);
    assert.equal(t.feat.decisions(t.ws, 'J2').length, 1);
    assert.equal(t.extras.decisionByKey(t.ws, KEY)!.sell.askPrice, 60000);
    const bad = take(t, { clientKey: 'short' }) as { ok: false; code: string };
    assert.equal(bad.code, 'INVALID_TRANSITION');
    assert.equal(t.feat.decisions(t.ws, 'J2').length, 1);
  });

  it('F7-03 without a key, two saves are two rows as before; the basis is a stable fingerprint of the counted facts', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const a = take(t);
    const b = take(t);
    assert.ok(!('ok' in a) && !('ok' in b));
    assert.notEqual(a.decision.decisionId, b.decision.decisionId);
    assert.equal(t.feat.decisions(t.ws, 'J2').length, 2);
    assert.match(a.decision.basis, /^[0-9a-f]{64}$/);
    assert.equal(a.decision.basis, b.decision.basis);
    assert.equal(basisOf(a.decision.keep, a.decision.sell), a.decision.basis);
    const other = take(t, { askPrice: 70000 });
    assert.ok(!('ok' in other));
    assert.notEqual(other.decision.basis, a.decision.basis);
  });

  it('F7-04 a wear and a new price after a position are listed as moved facts; a fresh position starts clean; another horizon on screen is not a change', () => {
    const t = setup({ history: closetHistory(TODAY) });
    const a = take(t);
    assert.ok(!('ok' in a));
    const v0 = t.feat.decisionView(t.ws, { itemId: 'J2', horizonDays: 30 }, sampleEvidence(TODAY));
    assert.ok(!('ok' in v0));
    assert.deepEqual(v0.history[0].recheck, { needed: false, changed: [] });
    ok(t.svc.recordPastWear(t.ws, { eventId: 'w-f7', actor: 'demo_script', expectedRevision: t.rev(), itemIds: ['J2'], occurredAt: addDays(TODAY, -1) }));
    const e = t.feat.addEvidence(t.ws, { itemId: 'J2', platform: 'KARROT', priceType: 'ASK', amount: 55000, currency: 'KRW', retrievedAt: TODAY, matchLevel: 'SIMILAR' });
    assert.ok(!('ok' in e));
    const v1 = t.feat.decisionView(t.ws, { itemId: 'J2' }, sampleEvidence(TODAY));
    assert.ok(!('ok' in v1));
    const r = v1.history[0].recheck;
    assert.equal(r.needed, true);
    assert.ok(r.changed.some((c) => c.includes('1 more confirmed wear')), JSON.stringify(r));
    assert.ok(r.changed.some((c) => c.includes('1 new price on KARROT')), JSON.stringify(r));
    // counted facts only: no chance, advice or estimate in the words
    for (const c of r.changed) assert.doesNotMatch(c, /%|chance|likely|should|estimate/i);
    // the snapshot itself did not change when the facts did
    assert.equal(t.extras.decision(t.ws, a.decision.decisionId)!.keep.wearsCounted, 0);
    // a fresh position an hour later (history is ordered by its saved-at time, newest first on screen)
    const later = new FeatureService({ ledger: t.ledger, extras: t.extras, today: () => TODAY, now: () => new Date(`${TODAY}T10:00:00+09:00`) });
    const b = take(t, {}, later);
    assert.ok(!('ok' in b));
    const v2 = t.feat.decisionView(t.ws, { itemId: 'J2' }, sampleEvidence(TODAY));
    assert.ok(!('ok' in v2));
    assert.equal(v2.history[0].decisionId, b.decision.decisionId);
    assert.deepEqual(v2.history[0].recheck, { needed: false, changed: [] });
    assert.equal(v2.history[1].recheck.needed, true);
  });

  it('F7-05 a database file from before client_key opens, keeps its rows, and takes keyed saves', () => {
    const dir = join(ROOT, '.data', 'test');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `f-old-${process.pid}-${++n}.db`);
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE IF NOT EXISTS decisions (decision_id TEXT PRIMARY KEY, workspace_id TEXT, item_id TEXT, at TEXT, body TEXT)');
    raw.prepare('INSERT INTO decisions VALUES (?,?,?,?,?)').run('d_old', 'ws-f', 'J2', '2026-10-01T00:00:00.000Z', JSON.stringify({ decisionId: 'd_old', itemId: 'J2' }));
    raw.close();
    const store = new ExtrasStore(path);
    cleanups.push(() => { store.close(); for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true }); });
    assert.equal(store.decisions('ws-f').length, 1);
    assert.equal(store.decisionByKey('ws-f', KEY), null);
    const t = setup({ history: closetHistory(TODAY) });
    const a = take(t);
    assert.ok(!('ok' in a));
    const d = { ...a.decision, decisionId: 'd_new' };
    assert.deepEqual(store.addDecision('ws-f', d, KEY), d);
    assert.equal(store.decisionByKey('ws-f', KEY)!.decisionId, 'd_new');
    assert.equal(store.decisions('ws-f').length, 2);
    // the unique index holds: a second row under the same key cannot be inserted
    assert.throws(() => store.addDecision('ws-f', { ...d, decisionId: 'd_new2' }, KEY));
    assert.equal(store.decisions('ws-f').length, 2);
    // the same file opened again, now with the column, is fine too
    const again = new ExtrasStore(path);
    assert.equal(again.decisionByKey('ws-f', KEY)!.decisionId, 'd_new');
    again.close();
  });
});

describe('F6 price chart series and coverage', () => {
  it('F6-01 priceSeries: one series per platform in its own currency, points in date order, first and latest, nothing averaged', () => {
    const S = priceSeries('J1', sampleEvidence(TODAY));
    assert.deepEqual(S.map((s) => s.platform), [...PLATFORMS]);
    const k = S.find((s) => s.platform === 'KARROT')!;
    assert.deepEqual(k.points.map((p) => [p.amount, p.priceType, p.retrievedAt]), [[85000, 'ASK', addDays(TODAY, -21)], [90000, 'TRADE', addDays(TODAY, -10)], [120000, 'ASK', addDays(TODAY, -3)]]);
    assert.equal(k.count, 3);
    assert.equal(k.first!.evidenceId, 'sample-1');
    assert.equal(k.latest!.evidenceId, 'sample-2');
    assert.deepEqual([k.currency, k.min, k.max], ['KRW', 85000, 120000]);
    assert.ok(k.points.every((p) => p.source === 'sample'));
    assert.match(k.line, /3 prices seen on Karrot/);
    const posh = S.find((s) => s.platform === 'POSHMARK')!;
    assert.deepEqual([posh.count, posh.currency, posh.first!.amount, posh.first === posh.latest], [1, 'USD', 68, true]);
    const kream = S.find((s) => s.platform === 'KREAM')!;
    assert.deepEqual([kream.count, kream.first, kream.latest, kream.min, kream.max], [0, null, null, null, null]);
    assert.doesNotMatch(JSON.stringify(S), /"(average|median|trend)[A-Za-z]*":/i);
  });

  it('F6-02 evidenceCoverage counts pieces with any price row and keeps sample-only pieces apart; an empty list has no percentage', () => {
    const t = setup({ history: closetHistory(TODAY) });
    assert.deepEqual(t.feat.coverage(t.ws, sampleEvidence(TODAY)), { withEvidence: 2, total: 12, pct: 17, sampleOnly: 2, line: 'Price evidence on 2 of 12 pieces' });
    const e = t.feat.addEvidence(t.ws, { itemId: 'B3', platform: 'KREAM', priceType: 'TRADE', amount: 30000, currency: 'KRW', retrievedAt: TODAY, matchLevel: 'SAME_ITEM' });
    assert.ok(!('ok' in e));
    const c = t.feat.coverage(t.ws, sampleEvidence(TODAY));
    assert.deepEqual([c.withEvidence, c.total, c.sampleOnly, c.line], [3, 12, 2, 'Price evidence on 3 of 12 pieces']);
    assert.deepEqual([t.feat.coverage(t.ws).withEvidence, t.feat.coverage(t.ws).sampleOnly], [1, 0]);
    assert.deepEqual(evidenceCoverage([], sampleEvidence(TODAY)), { withEvidence: 0, total: 0, pct: null, sampleOnly: 0, line: 'Price evidence on 0 of 0 pieces' });
  });
});

describe('Money caps: a sample closet is a public copy, counted and gated like a visitor fork', () => {
  const SAMPLE = 'closet-sample';
  const liveCall = (ws: string, callId: string, costMicroUsd: number) => ({
    callId, operationId: null, workspaceId: ws, sessionId: ws, model: 'muse-spark-1.3', http: 200, latencyMs: 1, usage: null,
    costMicroUsd, estLiveCostMicroUsd: 0, source: 'live' as const, createdAt: new Date(`${TODAY}T09:00:00+09:00`).toISOString(),
  });
  /** t.ws is a private rehearsal closet (seedRef 'closet'); SAMPLE is a public sample-closet copy, as /api/closet/start creates it. */
  function withSampleCloset() {
    const t = setup({ kind: 'rehearsal' });
    const since = addDays(TODAY, -75);
    t.ledger.createWorkspace({ workspaceId: SAMPLE, kind: 'rehearsal', publicReadOnly: false, seedRef: 'sample-closet', createdOn: since }, { items: closetItems(), since });
    return t;
  }

  it('CAP-01 a live call in a sample closet counts toward the visitor day and its own session; a private closet counts toward the app total only', () => {
    const t = withSampleCloset();
    t.ledger.insertCall(liveCall(t.ws, 'live-private', 500));
    t.ledger.insertCall(liveCall(SAMPLE, 'live-sample', 838));
    assert.deepEqual(t.ledger.spend({ sessionId: SAMPLE, kstDate: TODAY }), { appTotal: 1338, visitorDay: 838, session: 838 });
    assert.deepEqual(t.ledger.spend({ sessionId: t.ws, kstDate: TODAY }), { appTotal: 1338, visitorDay: 838, session: 500 });
    assert.deepEqual(t.ledger.spend({ sessionId: null, kstDate: addDays(TODAY, 1) }), { appTotal: 1338, visitorDay: 0, session: 0 });
  });

  it('CAP-02 both model paths hold a sample closet at the visitor day cap ($0 here) and let the private closet run', async () => {
    const t = withSampleCloset();
    t.ledger.insertCall(liveCall(SAMPLE, 'live-sample', 838));
    const photo = asOp(await t.svc.startPhoto(SAMPLE, { photoId: 'p1', sentence: CHIPS[0].text, sessionId: SAMPLE }));
    assert.equal(photo.state, 'HOLD');
    assert.deepEqual(photo.reasonCodes, ['CALL_CAP_REACHED']);
    assert.equal(photo.detail, 'visitor day cap');
    assert.equal(photo.modelCalls, 0);
    const said = asOp(await t.svc.startAnchorFromSentence(SAMPLE, { sentence: INTENT_CHIPS[1], sessionId: SAMPLE }));
    assert.deepEqual([said.state, said.reasonCodes, said.modelCalls], ['HOLD', ['CALL_CAP_REACHED'], 0]);
    const own = asOp(await t.svc.startPhoto(t.ws, { photoId: 'p1', sentence: CHIPS[0].text, sessionId: t.ws }));
    assert.ok(!own.reasonCodes.includes('CALL_CAP_REACHED'), own.detail);
    assert.ok(own.modelCalls >= 1);
  });
});

describe('F4b the asset overlay on the 3D stage: owner totals first, sample apart, never added', () => {
  const side = (total: number, pieces: number, ask = pieces, trade = 0) => ({ total, pieces, ask, trade });
  const none = side(0, 0, 0, 0);
  it('F4-04 owner total alone with no sample mark; the sample total only when the owner side is empty; nothing added; no evidence, no rows', async () => {
    // @ts-expect-error plain browser module without type declarations; the same file the 3D screen imports
    const { overlayRows } = await import('../web/public/anatomy.js');
    const L = {
      pieces: 12, withEvidence: 3,
      byCurrency: [
        { currency: 'KRW', owner: side(90000, 1, 0, 1), sample: side(178000, 2) },
        { currency: 'USD', owner: none, sample: side(68, 1) },
      ],
    };
    const rows = overlayRows(L);
    assert.deepEqual(rows.map((r: { currency: string; total: number; sample: boolean }) => [r.currency, r.total, r.sample]), [['KRW', 90000, false], ['USD', 68, true]]);
    assert.equal(rows[0].seen, 'latest price seen on 1 of 12 pieces');
    assert.deepEqual(rows[0].kinds, ['1 traded']);
    assert.ok(rows.every((r: { total: number }) => r.total !== 90000 + 178000), 'owner and sample never added');
    assert.deepEqual(overlayRows({ pieces: 12, withEvidence: 0, byCurrency: [] }), []);
    assert.deepEqual(overlayRows(null), []);
    assert.doesNotMatch(JSON.stringify(rows), /"(average|median|estimate|value|worth|probability)"/);
  });
});
