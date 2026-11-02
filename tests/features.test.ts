// Features added 11/2: F1 "오늘은 이 옷" (anchor), F2 60-day review · price cards · hand-off drafts,
// F3 looks by occasion rebuilt from the owner's wardrobe. Expected values are written by hand.
import { ROOT, isOp, ok } from './helpers.ts';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteLedger } from '../store/ledger.ts';
import { ExtrasStore } from '../store/extras.ts';
import { CloserService, type Operation } from '../engine/service.ts';
import { FeatureService } from '../engine/features.ts';
import { createMockPorts } from '../adapters/index.ts';
import { createPhotoLibrary } from '../fixtures/photos.ts';
import { closetHistory, closetItems, sampleEvidence } from '../fixtures/closet.ts';
import { KILL_TTL_MS, PROVISIONAL_CAPS } from '../engine/caps.ts';
import { addDays } from '../shared/dates.ts';
import { netScenario, priceCards, validateEvidence, HANDOFF_STATES } from '../engine/market.ts';
import { countOutfits } from '../engine/looks.ts';
import { factsFromState } from '../engine/rules.ts';
import type { Item } from '../shared/wardrobe.ts';

const TODAY = '2026-11-02';
let n = 0;
const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

function setup(o: { createdOn?: string; history?: { occurredAt: string; itemIds: string[] }[]; kind?: 'real' | 'rehearsal' | 'demo'; publicReadOnly?: boolean; items?: Item[] } = {}) {
  const dir = join(ROOT, '.data', 'test');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `f-${process.pid}-${++n}.db`);
  const ledger = new SqliteLedger(path, { kill: { on: false, setAt: null, ttlMs: KILL_TTL_MS }, caps: PROVISIONAL_CAPS });
  const extras = new ExtrasStore(path);
  const lib = createPhotoLibrary();
  const now = new Date(`${TODAY}T09:00:00+09:00`);
  const { ports } = createMockPorts(lib, { sleep: async () => {}, nowMs: () => 0, nowIso: () => now.toISOString() }, {});
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
    for (const rp of r.replans ?? []) for (const o of rp.options) assert.equal(o.outfit.outer, 'J1');
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
    assert.deepEqual(cards.map((c) => c.platform), ['KREAM', 'KARROT', 'POSHMARK']);
    const karrot = cards.find((c) => c.platform === 'KARROT')!;
    assert.deepEqual(karrot.entries.map((e) => e.amount).sort(), [120000, 85000].sort());
    assert.ok(karrot.entries.every((e) => e.priceType === 'ASK' && e.source === 'sample'));
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

  it('F2-12 an unknown fee makes the net unknown instead of zero', () => {
    const s = netScenario(100000, 'KRW', [{ label: 'platform fee', kind: 'rate', value: null }, { label: 'shipping', kind: 'fixed', value: 3500 }]);
    assert.equal(s.net, null);
    assert.deepEqual(s.unknown, ['platform fee']);
    const k = netScenario(100000, 'KRW', [{ label: 'shipping', kind: 'fixed', value: 3500 }]);
    assert.equal(k.net, 96500);
    assert.match(k.line, /Not a guarantee/);
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
    for (const id of anchors) assert.ok(Object.values(op.options[0].outfit).includes(id));
  });
});
