// Acceptance tests — failure honesty, kill switch, caps (plan v2 §4-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, heroProposed, isOp, laundry, lock, ok, startHero } from './helpers.ts';
import { errorResponse } from '../adapters/mock/transport.ts';
import { KILL_TTL_MS } from '../engine/caps.ts';

test('AT-09 [mock] failure honesty — 503 + Retry-After 60: wait, ≤ 2 retries, then HOLD META_API_UNAVAILABLE; 400: no retry; no LIVE on screen', async () => {
  const h = harness({ script: { spark1: () => errorResponse(503, 60) } });
  try {
    const op = await startHero(h);
    assert.equal(op.state, 'HOLD');
    assert.deepEqual(op.reasonCodes, ['META_API_UNAVAILABLE']);
    assert.equal(h.calls().filter((c) => c.kind === 'spark1').length, 3, '1 try + 2 retries');
    assert.deepEqual(h.sleeps, [60_000, 60_000], 'Retry-After honored');
    assert.equal(op.liveChips.length, 0);
    assert.ok(![...op.labels, ...op.callLines].some((l) => l.includes('LIVE')));
  } finally {
    h.cleanup();
  }
  const h2 = harness({ script: { spark1: () => errorResponse(400) } });
  try {
    const op = await startHero(h2);
    assert.equal(op.state, 'HOLD');
    assert.equal(h2.calls().filter((c) => c.kind === 'spark1').length, 1, '400 is not retried');
    assert.deepEqual(h2.sleeps, []);
    assert.ok(op.reasonCodes.includes('META_REQUEST_REJECTED'));
    assert.ok(![...op.labels, ...op.callLines].some((l) => l.includes('LIVE')));
  } finally {
    h2.cleanup();
  }
});

test('AT-10 [mock] caps and kill switch — K1 on: new photo → META_DISABLED, button re-plan and read-back still work; session $0.25 → CALL_CAP_REACHED; TTL 10 min → off', async () => {
  const h = harness();
  try {
    const op = await heroProposed(h);
    ok(lock(h, op, 0));
    const setAt = h.clock.now.toISOString();
    h.ledger.setFlag('kill', { on: true, setAt, ttlMs: KILL_TTL_MS });
    const callsBefore = h.calls().length;
    const blocked = await startHero(h);
    assert.equal(blocked.state, 'HOLD');
    assert.deepEqual(blocked.reasonCodes, ['META_DISABLED']);
    assert.equal(h.calls().length, callsBefore, 'no model call while K1 is on');
    const res = laundry(h, 'B2', 'LAUNDRY');
    ok(res);
    assert.equal(res.replans![0].state, 'PROPOSED', 'button re-plan works with K1 on');
    assert.equal(h.ledger.readState(h.ws, { fresh: true }).plans[0].state, 'NEEDS_REPLAN', 'read-back works');

    // TTL: 10 minutes after setAt the switch is off.
    h.clock.now = new Date(new Date(setAt).getTime() + KILL_TTL_MS);
    const after = await startHero(h);
    assert.ok(!after.reasonCodes.includes('META_DISABLED'));
    assert.equal(after.state, 'DRAFT');
  } finally {
    h.cleanup();
  }

  const h2 = harness();
  try {
    // Session spend reaches $0.25 (input of this test).
    h2.ledger.insertCall({ callId: 'spent-1', operationId: null, workspaceId: h2.ws, sessionId: 'sess-1', model: 'muse-spark-1.3', http: 200, latencyMs: 1, usage: null, costMicroUsd: 250_000, estLiveCostMicroUsd: 0, source: 'live', createdAt: h2.clock.now.toISOString() });
    const r = await h2.svc.startPhoto(h2.ws, { photoId: 'p1', sentence: 'Keep this jacket. The whole outfit feels too dressed-up for tonight.', sessionId: 'sess-1' });
    assert.ok(isOp(r));
    assert.deepEqual(r.reasonCodes, ['CALL_CAP_REACHED']);
    assert.equal(h2.calls().length, 0);
  } finally {
    h2.cleanup();
  }
});
