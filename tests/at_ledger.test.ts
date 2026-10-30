// Acceptance tests — ledger, transitions and saves (plan v2 §4-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, heroProposed, heroRegistered, isOp, laundry, lock, newId, ok, startHero, type Harness } from './helpers.ts';
import { checkAT06 } from './at_checks.ts';
import { saveWithReadBack } from '../shared/client.ts';
import { LABELS } from '../shared/labels.ts';
import type { LedgerState, WriteResponse } from '../shared/ledger.ts';
import type { WorkspaceKind } from '../shared/states.ts';
import { FX_E } from '../fixtures/edge.ts';
import { toolResponse, type MockReply } from '../adapters/mock/transport.ts';

const KEYS = 'needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–)';

async function lockedHero(h: Harness) {
  const op = await heroProposed(h);
  ok(lock(h, op, 0));
  return { op, plan: h.state().plans[0] };
}

test('AT-06 [mock] slot re-plan (FX-E1) — bottom only B3, J1/T1/S1 same, Spark calls 0', async () => {
  await checkAT06();
});

test('AT-11 [mock] selection save then wear, each shown only after a matching fresh read', async () => {
  const h = harness();
  try {
    const op = await heroProposed(h);
    const chosen = op.options[0].outfit;
    const lockId = newId('ev-lock');
    const rev0 = h.rev();
    const fresh = async () => h.ledger.readState(h.ws, { fresh: true });
    const sel = await saveWithReadBack(
      {
        write: async () => h.svc.lock(h.ws, { operationId: op.operationId, optionIndex: 0, eventId: lockId, actor: 'human', expectedRevision: rev0 }),
        lookup: async () => h.ledger.lookupEvent(h.ws, lockId)?.response ?? null,
        readBack: fresh,
      },
      (s) => s.plans.some((p) => p.planId === op.planId && p.state === 'LOCKED' && JSON.stringify(p.slots) === JSON.stringify(chosen)),
      LABELS.selectionSaved,
    );
    assert.equal(sel.result, 'COMMITTED');
    assert.ok(sel.label!.startsWith('Selection saved'));
    assert.equal(h.state().plans.filter((p) => p.state === 'WORN').length, 0, 'WORN 0 at selection time');

    const wearId = newId('ev-wear');
    const rev1 = h.rev();
    const worn = await saveWithReadBack(
      {
        write: async () => h.svc.wore(h.ws, { planId: op.planId, eventId: wearId, actor: 'human', expectedRevision: rev1 }),
        lookup: async () => h.ledger.lookupEvent(h.ws, wearId)?.response ?? null,
        readBack: fresh,
      },
      (s) => s.wearRows.some((w) => w.eventId === wearId) && s.plans.some((p) => p.planId === op.planId && p.state === 'WORN'),
      LABELS.wearSaved,
    );
    assert.equal(worn.result, 'COMMITTED');
    assert.equal(worn.label, '+1 wear · read back ✓');
    assert.equal(h.state().events.filter((e) => e.kind === 'WEAR_CONFIRMED').length, 1);

    // "일치 때만": a mismatching read-back shows no label.
    const h2 = harness();
    try {
      const op2 = await heroProposed(h2);
      const id2 = newId('ev-lock');
      const rev = h2.rev();
      const mism = await saveWithReadBack(
        {
          write: async () => h2.svc.lock(h2.ws, { operationId: op2.operationId, optionIndex: 0, eventId: id2, actor: 'human', expectedRevision: rev }),
          lookup: async () => null,
          readBack: async () => ({ ...h2.ledger.readState(h2.ws), plans: [] }) as LedgerState, // injected stale read
        },
        (s) => s.plans.some((p) => p.planId === op2.planId && p.state === 'LOCKED'),
        LABELS.selectionSaved,
      );
      assert.equal(mism.result, 'READBACK_MISMATCH');
      assert.equal(mism.label, null);
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});
test('AT-11 [real] selection save and wear on the deployed build', { skip: KEYS }, () => {});

test('AT-12 [mock] idempotency — same eventId twice → one record, second response = first', async () => {
  const h = harness();
  try {
    const { plan } = await lockedHero(h);
    const id = newId('ev-wear');
    const rev = h.rev();
    const first = h.svc.wore(h.ws, { planId: plan.planId, eventId: id, actor: 'human', expectedRevision: rev });
    ok(first);
    const second = h.svc.wore(h.ws, { planId: plan.planId, eventId: id, actor: 'human', expectedRevision: rev });
    assert.deepEqual(second, first);
    const s = h.state();
    assert.equal(s.events.filter((e) => e.eventId === id).length, 1);
    assert.equal(s.wearRows.length, 1);
    // A second tap with a new eventId is not a second wear either.
    const again = h.svc.wore(h.ws, { planId: plan.planId, eventId: newId('ev-wear'), actor: 'human', expectedRevision: h.rev() });
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.code, 'ALREADY_WORN');
  } finally {
    h.cleanup();
  }
});

test('AT-13 [mock] wear undo — one correctsEventId event, count −1, original event kept', async () => {
  const h = harness();
  try {
    const { plan } = await lockedHero(h);
    const wearId = newId('ev-wear');
    ok(h.svc.wore(h.ws, { planId: plan.planId, eventId: wearId, actor: 'human', expectedRevision: h.rev() }));
    const countBefore = h.state().wearRows.length;
    ok(h.svc.undoWear(h.ws, { wearEventId: wearId, eventId: newId('ev-undo'), actor: 'human', expectedRevision: h.rev() }));
    const s = h.state();
    assert.equal(s.events.filter((e) => e.correctsEventId === wearId).length, 1);
    assert.equal(s.wearRows.length, countBefore - 1);
    assert.ok(s.events.some((e) => e.eventId === wearId && e.kind === 'WEAR_CONFIRMED'), 'original event preserved');
    assert.equal(s.plans[0].state, 'LOCKED');
  } finally {
    h.cleanup();
  }
});

test('AT-14 [mock] save result unknown — SAVE_UNCONFIRMED → look up eventId → found: success / missing: resend same eventId; new eventId 0', async () => {
  for (const lostAfterCommit of [true, false]) {
    const h = harness();
    try {
      const { plan } = await lockedHero(h);
      const id = newId('ev-wear');
      const rev = h.rev();
      const sentIds: string[] = [];
      let sends = 0;
      const doWrite = (): WriteResponse => {
        sentIds.push(id);
        return h.svc.wore(h.ws, { planId: plan.planId, eventId: id, actor: 'human', expectedRevision: rev });
      };
      const out = await saveWithReadBack(
        {
          write: async () => {
            sends++;
            if (sends === 1) {
              if (lostAfterCommit) doWrite(); // committed, response lost on the way back
              throw new Error('response lost');
            }
            return doWrite();
          },
          lookup: async () => h.ledger.lookupEvent(h.ws, id)?.response ?? null,
          readBack: async () => h.ledger.readState(h.ws, { fresh: true }),
        },
        (s) => s.wearRows.some((w) => w.eventId === id),
        LABELS.wearSaved,
      );
      assert.equal(out.trail[0], 'SAVE_UNCONFIRMED');
      assert.equal(out.result, 'COMMITTED');
      assert.ok(out.trail.includes(lostAfterCommit ? 'FOUND_BY_EVENT_ID' : 'RESEND_SAME_EVENT_ID'));
      assert.deepEqual([...new Set(sentIds)], [id], 'no new eventId');
      assert.equal(h.state().events.filter((e) => e.kind === 'WEAR_CONFIRMED').length, 1);
    } finally {
      h.cleanup();
    }
  }
});

test('AT-15 [deploy] new-session persistence of /w/demo-rc1', { skip: 'deploy-only, judged at RC2 (plan §4-4)' }, () => {});
test('AT-16 [real] real Meta path on the deployed hero', { skip: KEYS }, () => {});

test('AT-22 [mock] same id, different content (FX-E6) — EVENT_CONFLICT, ledger hash unchanged', async () => {
  const h = harness();
  try {
    await heroRegistered(h);
    const id = FX_E.E6.eventId;
    ok(h.svc.recordPastWear(h.ws, { itemIds: [...FX_E.E6.first], occurredAt: '2026-10-30', eventId: id, actor: 'human', expectedRevision: h.rev() }));
    const hashBefore = h.hash();
    const r = h.svc.recordPastWear(h.ws, { itemIds: [...FX_E.E6.second], occurredAt: '2026-10-30', eventId: id, actor: 'human', expectedRevision: h.rev() });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'EVENT_CONFLICT');
    assert.equal(h.hash(), hashBefore);
  } finally {
    h.cleanup();
  }
});

test('AT-23 [mock] late response (FX-E7) — cancel during Spark 2 → STALE_RESPONSE, 0 candidates', async () => {
  let release!: (r: MockReply) => void;
  let requested!: () => void;
  const sent = new Promise<void>((res) => (requested = res));
  const h = harness({
    script: {
      spark2: () => {
        requested();
        return new Promise<MockReply>((res) => (release = res));
      },
    },
  });
  try {
    const op = await heroRegistered(h);
    const pending = h.svc.propose(h.ws, { operationId: op.operationId });
    await sent;
    const c = h.svc.cancel(h.ws, { operationId: op.operationId, actor: 'human' });
    assert.ok(isOp(c));
    release(toolResponse('muse-spark-1.3', 'propose_edit', { options: [{ changes: [{ slot: 'bottom', itemId: 'B2' }], reasonFactIds: ['dir:less_formal'], visual_match: [] }] }));
    const r = await pending;
    assert.ok(!isOp(r) && r.code === 'STALE_RESPONSE', JSON.stringify(r));
    const after = h.svc.getOperation(op.operationId)!;
    assert.equal(after.state, 'CANCELLED');
    assert.equal(after.options.length, 0);
    assert.ok(after.reasonCodes.includes('STALE_RESPONSE'));
  } finally {
    h.cleanup();
  }
});

test('AT-25 [mock] past wear (FX-E5) — recorded; availability stays LAUNDRY', async () => {
  const h = harness();
  try {
    await heroRegistered(h);
    ok(laundry(h, 'B2', 'LAUNDRY'));
    const r = h.svc.recordPastWear(h.ws, { itemIds: [...FX_E.E5.itemIds], occurredAt: '2026-10-30', eventId: newId('ev-past'), actor: 'human', expectedRevision: h.rev() });
    ok(r);
    const s = h.state();
    assert.ok(s.wearRows.some((w) => w.itemIds.includes('B2') && w.occurredAt === '2026-10-30'));
    assert.equal(s.availability.find((a) => a.itemId === 'B2')!.state, 'LAUNDRY');
  } finally {
    h.cleanup();
  }
});

test('AT-27 [mock] actor check — demo_script confirm/lock/wear → INVALID_TRANSITION in real·demo·visitor, hash unchanged', async () => {
  for (const kind of ['real', 'demo', 'visitor'] as WorkspaceKind[]) {
    const h = harness({ kind });
    try {
      const op = await startHero(h);
      const ids = () => op.cards.map((c) => newId(`e${c.cardId}`));
      let hash = h.hash();
      const c1 = h.svc.confirmCards(h.ws, { operationId: op.operationId, eventIds: ids(), actor: 'demo_script', expectedRevision: h.rev() });
      assert.equal(!c1.ok && c1.code, 'INVALID_TRANSITION', `${kind} confirm`);
      assert.equal(h.hash(), hash);
      ok(h.svc.confirmCards(h.ws, { operationId: op.operationId, eventIds: ids(), actor: 'human', expectedRevision: h.rev() }));
      const p = await h.svc.propose(h.ws, { operationId: op.operationId });
      assert.ok(isOp(p));
      hash = h.hash();
      const l1 = h.svc.lock(h.ws, { operationId: op.operationId, optionIndex: 0, eventId: newId('l'), actor: 'demo_script', expectedRevision: h.rev() });
      assert.equal(!l1.ok && l1.code, 'INVALID_TRANSITION', `${kind} lock`);
      assert.equal(h.hash(), hash);
      ok(lock(h, p, 0));
      hash = h.hash();
      const w1 = h.svc.wore(h.ws, { planId: p.planId, eventId: newId('w'), actor: 'demo_script', expectedRevision: h.rev() });
      assert.equal(!w1.ok && w1.code, 'INVALID_TRANSITION', `${kind} wear`);
      assert.equal(h.hash(), hash);
    } finally {
      h.cleanup();
    }
  }
  // rehearsal alone accepts demo_script
  const r = harness({ kind: 'rehearsal' });
  try {
    const op = await startHero(r);
    ok(r.svc.confirmCards(r.ws, { operationId: op.operationId, eventIds: op.cards.map((c) => newId(`r${c.cardId}`)), actor: 'demo_script', expectedRevision: r.rev() }));
  } finally {
    r.cleanup();
  }
});

test('AT-32 [mock] NEEDS_REPLAN — locked plan B2 → LAUNDRY: plan NEEDS_REPLAN, new option PROPOSED, LOCKED 0 before the tap', async () => {
  const h = harness();
  try {
    const { plan } = await lockedHero(h);
    assert.equal(plan.slots.bottom, 'B2');
    const res = laundry(h, 'B2', 'LAUNDRY');
    ok(res);
    const s = h.state();
    assert.equal(s.plans.find((p) => p.planId === plan.planId)!.state, 'NEEDS_REPLAN');
    assert.equal(res.replans![0].state, 'PROPOSED');
    assert.equal(s.plans.filter((p) => p.state === 'LOCKED').length, 0, 'nothing locked before the owner taps');
  } finally {
    h.cleanup();
  }
});
