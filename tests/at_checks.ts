// AT-03, AT-06, AT-19, AT-21 and the next-plan pin check as functions of the rule set, so AT-28 can
// run them against mutant builds. Expected values are hand-written from plan §4-4/§4-5 (not
// produced by production functions).
import assert from 'node:assert/strict';
import { ALL_RULES, factsFromState, type RuleSet } from '../engine/rules.ts';
import { buildSolverInput } from '../engine/solver.ts';
import { FX_E } from '../fixtures/edge.ts';
import { harness, heroProposed, heroRegistered, isOp, laundry, lock, ok, sampleItem } from './helpers.ts';

/** Hand-written FX-H formality values (§4-5): high = 3, mid = 2, low = 1. */
export const FXH_FORMALITY: Record<string, number> = { J1: 3, T1: 3, T2: 2, T3: 1, B1: 3, B2: 1, B3: 2, S1: 3, S2: 1 };
export const O0_SUM = 12; // J1 + T1 + B1 + S1

/** AT-03: LAUNDRY · REPAIR · STORED item one each → 0 of them are candidates; every one has ≥1 reason code recorded. */
export async function checkAT03(rules: RuleSet = ALL_RULES): Promise<void> {
  const h = harness({ rules });
  try {
    const op = await heroRegistered(h);
    ok(laundry(h, 'B2', 'LAUNDRY'));
    ok(laundry(h, 'B3', 'REPAIR'));
    ok(laundry(h, 'S2', 'STORED'));
    const after = await h.svc.propose(h.ws, { operationId: op.operationId });
    assert.ok(isOp(after));
    // Candidate lists code builds for this decision (what Spark 2 would be allowed to use).
    const input = buildSolverInput(after.context!, factsFromState(h.state()), h.clock.today, rules);
    const candidates = input.slots.flatMap((s) => s.ranked.map((r) => r.itemId));
    const unavailable = ['B2', 'B3', 'S2'];
    assert.equal(candidates.filter((id) => unavailable.includes(id)).length, 0, `unavailable items offered as candidates: ${candidates.join(',')}`);
    for (const [id, code] of [['B2', 'LAUNDRY'], ['B3', 'REPAIR'], ['S2', 'STORED']] as const) {
      const rec: { itemId: string; codes: string[] } | undefined = after.exclusions.find((e) => e.itemId === id);
      assert.ok(rec && rec.codes.length >= 1, `${id} has no reason code recorded`);
      assert.ok(rec.codes.includes(code), `${id} codes ${rec.codes.join(',')} miss ${code}`);
    }
  } finally {
    h.cleanup();
  }
}

/** AT-06 (FX-E1): after A is locked, B2 → LAUNDRY → bottom only becomes B3; J1, T1, S1 unchanged; Spark calls 0. */
export async function checkAT06(rules: RuleSet = ALL_RULES): Promise<void> {
  const h = harness({ rules });
  try {
    const op = await heroProposed(h);
    const a = op.options.findIndex((o) => o.outfit.bottom === 'B2' && o.outfit.shoes === 'S1');
    assert.ok(a >= 0, 'option A (B1 → B2) not proposed');
    ok(lock(h, op, a));
    const callsBefore = h.calls().length;
    const res = laundry(h, 'B2', 'LAUNDRY');
    ok(res);
    assert.equal(h.calls().length - callsBefore, 0, 'model calls during the button re-plan');
    const rp = res.replans?.[0];
    assert.ok(rp, 'no re-plan produced');
    assert.equal(rp.options.length, 1);
    const o = rp.options[0].outfit;
    assert.equal(o.bottom, 'B3');
    assert.equal(o.outer, 'J1');
    assert.equal(o.top, 'T1');
    assert.equal(o.shoes, 'S1');
    assert.deepEqual(rp.options[0].changedSlots, ['bottom']);
  } finally {
    h.cleanup();
  }
}

/** AT-19 (FX-H): both options keep J1; changed slots ⊆ {bottom, shoes}; A changes 1, B ≤ 2; both formality sums < O0. */
export async function checkAT19(rules: RuleSet = ALL_RULES): Promise<void> {
  const h = harness({ rules });
  try {
    const op = await heroProposed(h);
    assert.equal(op.state, 'PROPOSED');
    assert.equal(op.options.length, 2);
    const [A, B] = op.options;
    for (const o of op.options) {
      assert.equal(o.outfit.outer, 'J1', 'J1 not kept');
      for (const s of o.changedSlots) assert.ok(s === 'bottom' || s === 'shoes', `changed slot ${s} outside {bottom, shoes}`);
      const sum = Object.values(o.outfit).reduce((acc, id) => acc + FXH_FORMALITY[id!], 0);
      assert.ok(sum < O0_SUM, `formality sum ${sum} not < ${O0_SUM}`);
    }
    assert.equal(A.changedSlots.length, 1);
    assert.ok(B.changedSlots.length <= 2);
  } finally {
    h.cleanup();
  }
}

/** AT-21 (FX-E8): the pinned J1 is not waterproof and rain is high → 0 proposals, 1 question PIN_CONFLICT, J1 never swapped. */
export async function checkAT21(rules: RuleSet = ALL_RULES): Promise<void> {
  const h = harness({ rules });
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
}

/**
 * Next plan with a second outer seeded (AT-28's pin target). After option A of FX-H is locked, the
 * next decision without a photo has no offenders, so every slot may change and only the pin rule
 * keeps J1. Returns the outer of each option so AT-28 can show the swap under the pin mutant.
 */
export async function nextPlanOuters(rules: RuleSet = ALL_RULES): Promise<string[]> {
  const h = harness({ rules, extraSeeds: [sampleItem('J2', 'outer', 'track_jacket', 'navy', 'low')] });
  try {
    const op = await heroProposed(h);
    const a = op.options.findIndex((o) => o.outfit.bottom === 'B2' && o.outfit.shoes === 'S1');
    assert.ok(a >= 0, 'option A (B1 → B2) not proposed');
    ok(lock(h, op, a));
    const next = await h.svc.startNext(h.ws, { fromPlanId: op.planId });
    assert.ok(isOp(next), JSON.stringify(next));
    assert.equal(next.state, 'PROPOSED');
    assert.ok(next.options.length >= 1, 'no next-plan option proposed');
    return next.options.map((o) => o.outfit.outer ?? '');
  } finally {
    h.cleanup();
  }
}
