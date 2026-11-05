// Unit tests for the frozen contract pieces (not acceptance tests).
import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABILITY_CONSTRAINT_CODES, LEDGER_CODES, MODEL_CALL_CODES, REASON_CODES, REMOVED_CODES } from '../shared/reasons.ts';
import { AVAILABILITY_STATES, OWNERSHIP_STATES, PLAN_STATES, SAVE_RESULTS } from '../shared/states.ts';
import { LEDGER_ACTIONS, PLAN_TRANSITIONS } from '../shared/transitions.ts';
import { checkTransition } from '../engine/stateMachine.ts';
import { canonicalHash, canonicalize } from '../shared/canonical.ts';
import { buildBoxPrompt, decodeMockRle, encodeMockRle, normToPixelBox, parseSegmentation } from '../engine/coords.ts';
import { nearestColor, rgbToLab } from '../engine/color.ts';
import { FXH_ROLES } from '../fixtures/fxh.ts';
import { capBlocks, capsFromEnv, killActive, PROVISIONAL_CAPS, visitorDayCap } from '../engine/caps.ts';
import { createRealTransport, RealModeRefused, resolveMode } from '../adapters/transport.ts';
import { harness, ok, startHero, newId } from './helpers.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';
import { liveChip } from '../shared/labels.ts';

test('reason codes: 30 verbatim (13 + 10 + 7), unique, removed codes absent', () => {
  assert.equal(AVAILABILITY_CONSTRAINT_CODES.length, 13);
  assert.equal(MODEL_CALL_CODES.length, 10);
  assert.equal(LEDGER_CODES.length, 7);
  assert.equal(REASON_CODES.length, 30);
  assert.equal(new Set(REASON_CODES).size, 30);
  for (const r of REMOVED_CODES) assert.ok(!(REASON_CODES as readonly string[]).includes(r));
});

test('states (§4-1)', () => {
  assert.deepEqual([...OWNERSHIP_STATES], ['CANDIDATE', 'CONFIRMED', 'REJECTED']);
  assert.deepEqual([...AVAILABILITY_STATES], ['AVAILABLE', 'LAUNDRY', 'REPAIR', 'STORED']);
  assert.deepEqual([...PLAN_STATES], ['DRAFT', 'PROPOSED', 'LOCKED', 'WORN', 'HOLD', 'NEEDS_REPLAN', 'CANCELLED']);
  assert.deepEqual([...SAVE_RESULTS], ['COMMITTED', 'SAVE_UNCONFIRMED', 'READBACK_MISMATCH']);
});

test('transition table rows 1–13 and illegal transitions are rejected with the right code', () => {
  assert.deepEqual(PLAN_TRANSITIONS.map((t) => t.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(LEDGER_ACTIONS.map((t) => t.n), [12, 13]);
  const bad: [Parameters<typeof checkTransition>[0], Parameters<typeof checkTransition>[1]][] = [
    ['DRAFT', 'LOCKED'], ['PROPOSED', 'WORN'], ['HOLD', 'PROPOSED'], ['NEEDS_REPLAN', 'LOCKED'], ['CANCELLED', 'DRAFT'], ['NONE', 'PROPOSED'],
  ];
  for (const [from, to] of bad) {
    const r = checkTransition(from, to, 'human', 'real');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'INVALID_TRANSITION', `${from}→${to}`);
  }
  const worn = checkTransition('WORN', 'WORN', 'human', 'real');
  assert.equal(!worn.ok && worn.code, 'ALREADY_WORN');
  assert.equal(checkTransition('PROPOSED', 'LOCKED', 'system', 'real').ok, false, 'row 5 is human-only');
  assert.equal(checkTransition('DRAFT', 'PROPOSED', 'human', 'real').ok, false, 'row 2 is system-only');
  assert.equal(checkTransition('PROPOSED', 'LOCKED', 'demo_script', 'rehearsal').ok, true);
  assert.equal(checkTransition('PROPOSED', 'LOCKED', 'demo_script', 'visitor').ok, false);
  assert.equal(checkTransition('LOCKED', 'CANCELLED', 'human', 'real').ok, true, 'row 11 from any state');
  assert.equal(checkTransition('CANCELLED', 'CANCELLED', 'human', 'real').ok, false);
});

test('canonical JSON: key order and NFC do not change the hash; non-integers rejected', () => {
  assert.equal(canonicalHash({ b: 1, a: [1, 2] }), canonicalHash({ a: [1, 2], b: 1 }));
  assert.equal(canonicalize({ s: 'é' }), canonicalize({ s: 'é' }));
  assert.throws(() => canonicalize({ x: 0.5 }));
});

test('SAM box prompt matches the doc example token; Spark 0–1000 → pixels uses floor and stays inside', () => {
  assert.equal(buildBoxPrompt([{ id: 1, box: { x1: 444, y1: 626, x2: 675, y2: 849 } }], 1800, 1200), '<0f>1<|box;x1=444;y1=626;x2=675;y2=849;w=1800;h=1200|>');
  assert.deepEqual(normToPixelBox([0, 0, 1000, 1000], 1200, 1600), { x1: 0, y1: 0, x2: 1199, y2: 1599 });
  assert.deepEqual(normToPixelBox([333, 333, 667, 667], 1000, 1000), { x1: 333, y1: 333, x2: 667, y2: 667 });
  assert.deepEqual(normToPixelBox([1, 1, 2, 2], 1599, 1599), { x1: 1, y1: 1, x2: 3, y2: 3 });
  assert.throws(() => buildBoxPrompt(Array.from({ length: 17 }, (_, i) => ({ id: i + 1, box: { x1: 0, y1: 0, x2: 1, y2: 1 } })), 10, 10));
});

test('SAM output parser reads the doc example records (box, frame size, mask H,W,encoding)', () => {
  const doc = "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>,1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>";
  const r = parseSegmentation(doc);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].box, { x1: 211, y1: 228, x2: 270, y2: 254 });
  assert.equal(r[0].mask!.h, 27);
  assert.equal(r[0].mask!.w, 60);
  assert.equal(r[0].mask!.enc, '~');
  assert.equal(r[1].id, 1);
  const bits = new Uint8Array([0, 0, 1, 1, 1, 0, 1]);
  assert.deepEqual(decodeMockRle(encodeMockRle(bits), bits.length), bits);
});

test('fixture colors map to their declared color family (12 named colors)', () => {
  for (const r of FXH_ROLES) assert.equal(nearestColor(rgbToLab(r.rgb)), r.color, r.role);
});

test('caps: visitor cap is $0 from 2026-11-19 00:00 KST; kill TTL; free mock calls pass a $0 cap', () => {
  const caps = { ...PROVISIONAL_CAPS, visitorDayMicroUsd: 3_000_000 };
  assert.equal(visitorDayCap(caps, new Date('2026-11-18T23:59:59+09:00')), 3_000_000);
  assert.equal(visitorDayCap(caps, new Date('2026-11-19T00:00:00+09:00')), 0);
  const k = { on: true, setAt: '2026-10-31T01:00:00Z', ttlMs: 600_000 };
  assert.equal(killActive(k, new Date('2026-10-31T01:09:59Z')), true);
  assert.equal(killActive(k, new Date('2026-10-31T01:10:00Z')), false);
  assert.equal(capBlocks(0, 0, 0), false);
  assert.equal(capBlocks(0, 50_000, 0), true);
  assert.equal(capBlocks(250_000, 0, 250_000), true);
});

test('caps: environment can raise the visitor day cap and the app total, within ceilings; bad values keep the defaults', () => {
  assert.deepEqual(capsFromEnv({}), PROVISIONAL_CAPS);
  assert.deepEqual(capsFromEnv({ CLOSER_VISITOR_DAY_USD: '3', CLOSER_APP_TOTAL_USD: '20' }), { ...PROVISIONAL_CAPS, visitorDayMicroUsd: 3_000_000, appTotalMicroUsd: 20_000_000 });
  assert.equal(capsFromEnv({ CLOSER_VISITOR_DAY_USD: '0.5' }).visitorDayMicroUsd, 500_000);
  for (const bad of ['', ' ', 'abc', '-1', '11', 'Infinity']) assert.equal(capsFromEnv({ CLOSER_VISITOR_DAY_USD: bad }).visitorDayMicroUsd, 0, `visitor ${JSON.stringify(bad)}`);
  assert.equal(capsFromEnv({ CLOSER_APP_TOTAL_USD: '201' }).appTotalMicroUsd, 20_000_000);
  // The $0-from date is not an environment setting: a raised cap still falls to $0 on 11/19.
  assert.equal(visitorDayCap(capsFromEnv({ CLOSER_VISITOR_DAY_USD: '3' }), new Date('2026-11-19T00:00:00+09:00')), 0);
});

test('mode: mock is the default; real refuses without MODEL_API_KEY and in test processes; fetch is blocked here', async () => {
  assert.equal(resolveMode({}), 'mock');
  assert.throws(() => createRealTransport({}), RealModeRefused);
  assert.throws(() => createRealTransport({ CLOSER_FORBID_REAL: '1' }), RealModeRefused);
  await assert.rejects(() => fetch('https://example.invalid/'), /forbidden/);
});

test('live chip only for live + callId + 2xx', () => {
  const base = { callId: 'c1', model: 'sam-3.1', latencyMs: 10 };
  assert.equal(liveChip({ ...base, source: 'mock', http: 200 }), null);
  assert.equal(liveChip({ ...base, source: 'live', http: 503 }), null);
  assert.equal(liveChip({ ...base, source: 'live', http: 200, callId: '' }), null);
  assert.ok(liveChip({ ...base, source: 'live', http: 200 })!.startsWith('LIVE'));
});

test('read-only workspace (/w/demo-rc1): every write → SCOPE_DENIED', async () => {
  const h = harness({ kind: 'demo', publicReadOnly: true });
  try {
    const r = h.svc.recordPastWear(h.ws, { itemIds: ['T2'], occurredAt: '2026-10-30', eventId: newId('x'), actor: 'human', expectedRevision: 0 });
    assert.equal(!r.ok && r.code, 'SCOPE_DENIED');
    const p = await h.svc.startPhoto(h.ws, { photoId: 'p1', sentence: 'x' });
    assert.equal('code' in p && p.code, 'SCOPE_DENIED');
  } finally {
    h.cleanup();
  }
});

test('stale expectedRevision → STALE_STATE; item IDs use the lowest free number per slot', async () => {
  const h = harness();
  try {
    const op = await startHero(h);
    const r = h.svc.confirmCards(h.ws, { operationId: op.operationId, eventIds: op.cards.map((c) => newId(`s${c.cardId}`)), actor: 'human', expectedRevision: 99 });
    assert.equal(!r.ok && r.code, 'STALE_STATE');
    const r2 = h.svc.confirmCards(h.ws, { operationId: op.operationId, eventIds: op.cards.map((c) => newId(`s${c.cardId}`)), actor: 'human', expectedRevision: h.rev() });
    ok(r2);
    assert.deepEqual((r2.result as { itemIds: string[] }).itemIds, ['J1', 'T1', 'B1', 'S1']);
  } finally {
    h.cleanup();
  }
});

test('every adapters/ file carries the live-record header, and the record it names exists', () => {
  assert.ok(existsSync(join(ROOT, 'docs', 'live', 'live_check.json')));
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(join(ROOT, 'adapters'))) {
    assert.equal(readFileSync(f, 'utf8').split('\n')[0], '// 실호출 기록: docs/live/live_check.json (2026-11-05, 1회) — 그 기록 밖의 응답 형태는 문서 예시 기반', f);
  }
});
