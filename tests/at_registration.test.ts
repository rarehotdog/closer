// Acceptance tests — photo registration stage (plan v2 §4-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, isOp, newId, startHero } from './helpers.ts';
import { saveWithReadBack } from '../shared/client.ts';
import { itemsReadBack } from '../shared/labels.ts';

const KEYS = 'needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–)';

test('AT-01 [mock] photo registration — 4 cards, SAM ids {1,2,3,4}, ledger +0 before confirm, +4 and read-back match after', async () => {
  const h = harness();
  try {
    const before = h.state();
    const hashBefore = h.hash();
    const op = await startHero(h);
    assert.equal(op.cards.length, 4);
    const samIds = op.cards.filter((c) => c.arrival !== null).map((c) => c.cardId).sort((a, b) => a - b);
    assert.deepEqual(samIds, [1, 2, 3, 4]);
    const mid = h.state();
    assert.equal(mid.events.length, before.events.length, 'no events before confirm');
    assert.equal(mid.items.length, before.items.length, 'existing rows unchanged');
    assert.equal(h.hash(), hashBefore);

    const eventIds = op.cards.map((c) => newId(`ev-reg-${c.cardId}`));
    const expectedRev = h.rev();
    const out = await saveWithReadBack(
      {
        write: async () => h.svc.confirmCards(h.ws, { operationId: op.operationId, eventIds, actor: 'human', expectedRevision: expectedRev }),
        lookup: async () => h.ledger.lookupEvent(h.ws, eventIds[0])?.response ?? null,
        readBack: async () => h.ledger.readState(h.ws, { fresh: true }),
      },
      (s) =>
        ['J1', 'T1', 'B1', 'S1'].every((id, i) => {
          const it = s.items.find((x) => x.itemId === id);
          const c = op.cards[i];
          return it && it.ownership === 'CONFIRMED' && it.slot === c.slot && it.color === c.sparkColor && s.availability.some((a) => a.itemId === id && a.state === 'AVAILABLE');
        }),
      itemsReadBack(4),
    );
    assert.equal(out.result, 'COMMITTED');
    assert.equal(out.label, '+4 items · read back ✓');
    const after = h.state();
    assert.equal(after.events.length - before.events.length, 4);
    assert.equal(after.events.filter((e) => e.kind === 'REGISTRATION_CONFIRMED').length, 4);
  } finally {
    h.cleanup();
  }
});
test('AT-01 [real] photo registration on the deployed build', { skip: KEYS }, () => {});

test('AT-31 [real] instruction text inside a photo', { skip: `${KEYS}; real-only (실제 1회)` }, () => {});

test('AT-36 [mock] mask color cross-check — Spark black vs mask navy → ATTR_UNKNOWN for that item only, registration +0 before confirm', async () => {
  const h = harness({
    script: {
      spark1Patch: (out) => {
        const g = (out.garments as Record<string, unknown>[]).map((x, i) => (i === 0 ? { ...x, color_family: 'black' } : x));
        return { ...out, garments: g };
      },
    },
  });
  try {
    const hashBefore = h.hash();
    const op = await startHero(h);
    assert.ok(isOp(op));
    const q = op.cards.filter((c) => c.question);
    assert.equal(q.length, 1, 'one question');
    assert.equal(q[0].cardId, 1);
    assert.equal(q[0].question!.code, 'ATTR_UNKNOWN');
    assert.equal(q[0].sparkColor, 'black');
    assert.equal(q[0].maskColor, 'navy');
    // Confirm without answering is refused; nothing registered.
    const r = h.svc.confirmCards(h.ws, { operationId: op.operationId, eventIds: op.cards.map((c) => newId(`e${c.cardId}`)), actor: 'human', expectedRevision: h.rev() });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'ATTR_UNKNOWN');
    assert.equal(h.hash(), hashBefore, 'registration +0 before confirmation');
  } finally {
    h.cleanup();
  }
});
test('AT-36 [real] mask color cross-check on real photos', { skip: KEYS }, () => {});
