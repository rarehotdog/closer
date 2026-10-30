// Acceptance tests — proposal stage (plan v2 §4-4). Expected values are hand-written from the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, heroProposed, heroRegistered, isOp, laundry, lock, newId, ok, sampleItem } from './helpers.ts';
import { checkAT03, checkAT19 } from './at_checks.ts';
import { toolResponse } from '../adapters/mock/transport.ts';
import { FX_E } from '../fixtures/edge.ts';
import { AMBIGUOUS_SENTENCE } from '../fixtures/photos.ts';
import { ALL_RULES, factsFromState } from '../engine/rules.ts';
import { rankSlot } from '../engine/solver.ts';

const KEYS = 'needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–)';

test('AT-02 [mock] unknown question 1 — only the unknown that changes the result is asked (FX-E4)', async () => {
  // FX-E4 fixture [가정]: offenders {T1} (top slot open). P1 garment index 1 = T1.
  const h2 = harness({
    itemPatch: { T2: { formality: 'unknown' }, S2: { formality: 'unknown' } },
    script: { spark1Patch: (out) => ({ ...out, offenders: [{ index: 1, why: FX_E.E4.offenders[0].why }] }) },
  });
  try {
    const op = await heroRegistered(h2);
    const r = await h2.svc.propose(h2.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.equal(r.state, 'HOLD');
    assert.equal(r.questions.length, 1, 'exactly one question');
    assert.equal(r.questions[0].code, 'ATTR_UNKNOWN');
    assert.deepEqual(r.questions[0].itemIds, ['T2']);
    assert.ok(!r.questions.some((q) => q.itemIds.includes('S2')), 'no question for the non-deciding unknown S2');
  } finally {
    h2.cleanup();
  }
});

test('AT-03 [mock] exclusion ledger — LAUNDRY/REPAIR/STORED: 0 candidates, ≥1 reason code each', async () => {
  await checkAT03();
});

test('AT-04 [mock] proposal and state are separate — PROPOSED ≤ 2, availability unchanged', async () => {
  const h = harness();
  try {
    const op = await heroRegistered(h);
    const availBefore = JSON.stringify(h.state().availability);
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.equal(r.state, 'PROPOSED');
    assert.ok(r.options.length <= 2);
    assert.equal(JSON.stringify(h.state().availability), availBefore);
  } finally {
    h.cleanup();
  }
});

test('AT-05 bottleneck badge', { skip: 'archived (보관, number kept) — plan §4-4/§7' }, () => {});

test('AT-07 [mock] nothing saved before confirmation — LOCKED 0, ledger +0 right after proposal', async () => {
  const h = harness();
  try {
    const op = await heroRegistered(h);
    const hashBefore = h.hash();
    const evBefore = h.state().events.length;
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    const s = h.state();
    assert.equal(s.plans.filter((p) => p.state === 'LOCKED').length, 0);
    assert.equal(s.events.length, evBefore);
    assert.equal(h.hash(), hashBefore);
  } finally {
    h.cleanup();
  }
});

test('AT-08 [mock] model output check — unknown itemId, LAUNDRY item, J1 swap → INVALID_MODEL_OUTPUT, ledger +0, HOLD after one correction', async () => {
  const seen: unknown[] = [];
  const bad = { options: [
    { changes: [{ slot: 'bottom', itemId: 'B9' }], reasonFactIds: ['dir:less_formal'], visual_match: [] },
    { changes: [{ slot: 'bottom', itemId: 'B3' }, { slot: 'outer', itemId: 'J2' }], reasonFactIds: ['dir:less_formal'], visual_match: [] },
  ] };
  const h = harness({
    extraSeeds: [sampleItem('J2', 'outer', 'coat', 'gray', 'mid')],
    script: { spark2: (_n, facts) => { seen.push(facts.correction); return toolResponse('muse-spark-1.3', 'propose_edit', bad); } },
  });
  try {
    const op = await heroRegistered(h);
    ok(laundry(h, 'B3', 'LAUNDRY'));
    const hashBefore = h.hash();
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.equal(r.state, 'HOLD');
    assert.ok(r.reasonCodes.includes('INVALID_MODEL_OUTPUT'));
    assert.equal(h.calls().filter((c) => c.kind === 'spark2').length, 2, 'original call + exactly one correction');
    assert.equal(seen[0], null);
    assert.ok(seen[1] && typeof seen[1] === 'object', 'correction carries the rejection reasons as new input');
    const codes = r.rejections[0].codes;
    for (const c of ['INVALID_MODEL_OUTPUT', 'LAUNDRY', 'PIN_CONFLICT'] as const) assert.ok(codes.includes(c), `missing ${c} in ${codes.join(',')}`);
    assert.equal(r.options.length, 0);
    assert.equal(h.hash(), hashBefore, 'ledger +0');
  } finally {
    h.cleanup();
  }
});

test('AT-19 [mock] intent kept (FX-H) — J1 kept, changes ⊆ {bottom, shoes}, A = 1, B ≤ 2, sums < O0', async () => {
  await checkAT19();
});
test('AT-19 [real] intent kept on the deployed build', { skip: KEYS }, () => {});

test('FX-H pre-registered answer (§4-5) — A = B1→B2, B = B1→B2 + S1→S2, E1 → J1+T1+B3+S1', async () => {
  const h = harness();
  try {
    const op = await heroProposed(h);
    assert.deepEqual(op.options.map((o) => o.outfit), [
      { outer: 'J1', top: 'T1', bottom: 'B2', shoes: 'S1' },
      { outer: 'J1', top: 'T1', bottom: 'B2', shoes: 'S2' },
    ]);
    ok(lock(h, op, 0));
    const res = laundry(h, 'B2', 'LAUNDRY');
    ok(res);
    assert.deepEqual(res.replans?.[0].options[0].outfit, { outer: 'J1', top: 'T1', bottom: 'B3', shoes: 'S1' });
  } finally {
    h.cleanup();
  }
});

test('AT-20 [mock] zero-change trap — unchanged O0 from the model → NO_CHANGE; "keep as is" saves via its own button', async () => {
  const same = { options: [{ changes: [], reasonFactIds: ['dir:less_formal'], visual_match: [] }] };
  const h = harness({ script: { spark2: () => toolResponse('muse-spark-1.3', 'propose_edit', same) } });
  try {
    const op = await heroRegistered(h);
    const hashBefore = h.hash();
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.ok(r.rejections.length >= 1 && r.rejections[0].codes.includes('NO_CHANGE'), 'NO_CHANGE rejection recorded');
    assert.equal(r.options.length, 0);
    assert.equal(h.hash(), hashBefore);
    const kept = h.svc.keepAsIs(h.ws, { operationId: op.operationId, eventId: newId('ev-keep'), actor: 'human', expectedRevision: h.rev() });
    ok(kept);
    const plan = h.state().plans[0];
    assert.equal(plan.state, 'LOCKED');
    assert.deepEqual(plan.slots, { outer: 'J1', top: 'T1', bottom: 'B1', shoes: 'S1' });
  } finally {
    h.cleanup();
  }
});

test('AT-21 [mock] pin vs hard rule (FX-E8) — 0 proposals, 1 question PIN_CONFLICT, J1 never swapped', async () => {
  const h = harness();
  try {
    const op = await heroRegistered(h, { weather: FX_E.E8.weather, hardRules: FX_E.E8.hardRules });
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.equal(r.options.length, 0);
    assert.equal(r.questions.length, 1);
    assert.equal(r.questions[0].code, 'PIN_CONFLICT');
    assert.ok(r.reasonCodes.includes('PIN_CONFLICT'));
    assert.ok(h.state().plans.every((p) => p.slots.outer === 'J1'));
  } finally {
    h.cleanup();
  }
});

test('AT-24 whole-condition change', { skip: 'archived (보관, number kept) — sentence-change path is v1.1' }, () => {});

test('AT-26 [mock] item with no record — "no confirmed wear yet", rank bonus 0', async () => {
  const h = harness({ extraSeeds: [sampleItem('T4', 'top', 'knit', 'green', 'mid')] });
  try {
    const op = await heroRegistered(h);
    const v = h.svc.view(h.ws);
    assert.equal(v.items.find((i) => i.itemId === 'T4')!.wearLabel, 'no confirmed wear yet');
    const facts = factsFromState(h.state());
    const noRecord = rankSlot('top', 'T1', op.context!, facts, h.clock.today, ALL_RULES).ranked.find((r) => r.itemId === 'T4')!.rank;
    // Same item with an old (30 days ago) wear: the rank must be identical → no bonus for having no record.
    const lastWorn = new Map(facts.lastWorn);
    lastWorn.set('T4', '2026-10-01');
    const withOld = rankSlot('top', 'T1', op.context!, { ...facts, lastWorn }, h.clock.today, ALL_RULES).ranked.find((r) => r.itemId === 'T4')!.rank;
    assert.equal(noRecord, withOld);
    assert.notEqual(noRecord, 0, 'a new item must not jump to the top');
  } finally {
    h.cleanup();
  }
});

test('AT-29 [mock] ambiguous reference "그거 말고 다른 거" — AMBIGUOUS_REFERENCE, 1 question, 0 guesses', async () => {
  const h = harness({ script: { spark2: () => toolResponse('muse-spark-1.3', 'ask_owner', { questionCode: 'AMBIGUOUS_REFERENCE', itemIds: ['B1', 'S1'] }) } });
  try {
    const op = await heroRegistered(h, { sentence: AMBIGUOUS_SENTENCE });
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.equal(r.state, 'HOLD');
    assert.ok(r.reasonCodes.includes('AMBIGUOUS_REFERENCE'));
    assert.equal(r.questions.length, 1);
    assert.equal(r.questions[0].code, 'AMBIGUOUS_REFERENCE');
    assert.ok(r.questions[0].itemIds.length >= 2);
    assert.equal(r.options.length, 0, 'no guessed proposal');
  } finally {
    h.cleanup();
  }
});

test('AT-30 [mock] unrequested relaxation — option breaking an owner hard rule → UNREQUESTED_RELAXATION', async () => {
  const relax = { options: [{ changes: [{ slot: 'shoes', itemId: 'S2' }], reasonFactIds: ['dir:less_formal'], visual_match: [] }] };
  const h = harness({ script: { spark2: () => toolResponse('muse-spark-1.3', 'propose_edit', relax) } });
  try {
    const op = await heroRegistered(h, { hardRules: [{ kind: 'exclude_item', itemId: 'S2' }] });
    const hashBefore = h.hash();
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.ok(r.rejections[0].codes.includes('UNREQUESTED_RELAXATION'), r.rejections[0].codes.join(','));
    assert.equal(r.options.length, 0);
    assert.equal(h.hash(), hashBefore);
  } finally {
    h.cleanup();
  }
});

test('AT-33 [mock] record → next suggestion — yesterday T1 WORN: T1 ranks lower (not excluded), reason "T1 worn {MM/DD} · your record"', async () => {
  const h = harness();
  try {
    const op = await heroProposed(h);
    ok(lock(h, op, 0));
    const plan = h.state().plans[0];
    ok(h.svc.wore(h.ws, { planId: plan.planId, eventId: newId('ev-wear'), actor: 'human', expectedRevision: h.rev() }));
    h.clock.today = '2026-11-01';
    h.clock.now = new Date('2026-11-01T10:00:00+09:00');
    const next = await h.svc.startNext(h.ws, { fromPlanId: plan.planId });
    assert.ok(isOp(next), JSON.stringify(next));
    const ctx = next.context!;
    assert.equal(ctx.offenders.length, 0);
    const s = h.state();
    const withRecord = rankSlot('top', 'T1', ctx, factsFromState(s), '2026-11-01', ALL_RULES);
    const without = rankSlot('top', 'T1', ctx, factsFromState({ ...s, wearRows: [] }), '2026-11-01', ALL_RULES);
    const r1 = withRecord.ranked.find((r) => r.itemId === 'T1');
    const r0 = without.ranked.find((r) => r.itemId === 'T1');
    assert.ok(r1, 'T1 must stay a candidate (not excluded)');
    assert.ok(r1.rank > r0!.rank, `T1 rank ${r0!.rank} → ${r1.rank} should drop`);
    const lines = next.options.flatMap((o) => o.reasonLines);
    assert.ok(lines.includes('T1 worn 10/31 · your record'), lines.join(' | '));
  } finally {
    h.cleanup();
  }
});

test('AT-34 [mock] no substitute (FX-E2) — NO_VALID_COMBO + 1 relaxation question, no silent relaxation', async () => {
  const h = harness();
  try {
    const op = await heroProposed(h);
    ok(lock(h, op, 0)); // option A, bottom B2
    ok(laundry(h, 'B3', 'LAUNDRY'));
    const res = laundry(h, 'B2', 'LAUNDRY');
    ok(res);
    const rp = res.replans![0];
    assert.ok(rp.reasonCodes.includes('NO_VALID_COMBO'));
    assert.equal(rp.questions.length, 1);
    assert.equal(rp.questions[0].text, 'Keep B1 (more formal) or skip?');
    assert.equal(rp.options.length, 0);
    const plan = h.state().plans[0];
    assert.equal(plan.state, 'NEEDS_REPLAN');
    assert.equal(plan.slots.bottom, 'B2', 'plan not silently relaxed to B1');
  } finally {
    h.cleanup();
  }
});

test('AT-35 [mock] no change outside offenders — offenders {B1, S1}, option changing T1 → OUTSIDE_OFFENDERS, ledger +0', async () => {
  const outside = { options: [{ changes: [{ slot: 'top', itemId: 'T3' }], reasonFactIds: ['dir:less_formal'], visual_match: [] }] };
  const h = harness({ script: { spark2: () => toolResponse('muse-spark-1.3', 'propose_edit', outside) } });
  try {
    const op = await heroRegistered(h);
    assert.deepEqual(op.context!.offenders.map((o) => o.itemId), ['B1', 'S1']);
    const hashBefore = h.hash();
    const r = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(r));
    assert.ok(r.rejections[0].codes.includes('OUTSIDE_OFFENDERS'), r.rejections[0].codes.join(','));
    assert.equal(r.options.length, 0);
    assert.equal(h.hash(), hashBefore);
  } finally {
    h.cleanup();
  }
});
