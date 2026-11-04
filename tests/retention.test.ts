// Retention of visitor workspaces (Try forks): swept 24 hours after creation with every row keyed
// by them, except the call rows that count toward the spend caps; owner, demo and rehearsal rows
// are never touched. Mirrors sweepVisitorWorkspaces() in web/server.ts.
import { ROOT } from './helpers.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteLedger } from '../store/ledger.ts';
import { ExtrasStore } from '../store/extras.ts';
import { KILL_TTL_MS, PROVISIONAL_CAPS } from '../engine/caps.ts';
import { OUTSIDE_PHOTO_ROLES, seedItems } from '../fixtures/fxh.ts';
import type { CallRow } from '../shared/ledger.ts';
import type { WorkspaceKind } from '../shared/states.ts';

const dir = join(ROOT, '.data', 'test');
mkdirSync(dir, { recursive: true });
const files: string[] = [];
after(() => {
  for (const f of files) for (const suf of ['', '-wal', '-shm']) rmSync(f + suf, { force: true });
});
const dbPath = (tag: string) => {
  const p = join(dir, `rt-${process.pid}-${tag}.db`);
  files.push(p);
  return p;
};
const FLAGS = { kill: { on: false, setAt: null, ttlMs: KILL_TTL_MS }, caps: PROVISIONAL_CAPS };
const CUTOFF = '2026-11-03T12:00:00.000Z'; // "now" − 24 h
const OLD = '2026-11-02T08:00:00.000Z';
const RECENT = '2026-11-04T09:00:00.000Z';

const callAt = (ws: string, createdAt: string): CallRow => ({
  callId: `call-${ws}-${createdAt}`, operationId: null, workspaceId: ws, sessionId: null, model: 'muse-spark-1.3', http: 200, latencyMs: 1,
  usage: null, costMicroUsd: 1000, estLiveCostMicroUsd: 1000, source: 'mock', createdAt,
});

/** One workspace with a row in every table keyed by it: items, availability, events, a plan, a wear row, a run record, a call, two side-table rows. */
function fill(ledger: SqliteLedger, extras: ExtrasStore, ws: string, kind: WorkspaceKind, createdAt: string) {
  ledger.createWorkspace({ workspaceId: ws, kind, publicReadOnly: false, seedRef: 'fx-h', createdOn: '2026-11-01' }, { items: seedItems(OUTSIDE_PHOTO_ROLES), since: '2026-11-01' }, createdAt);
  const w = ledger.write(
    { workspaceId: ws, expectedRevision: 0, events: [{ eventId: `${ws}-wear`, kind: 'WEAR_CONFIRMED', actor: 'human', occurredAt: '2026-11-02', correctsEventId: null, payload: { itemIds: ['J1'] } }] },
    () => ({
      ok: true,
      mutations: [
        { op: 'insertWear', row: { eventId: `${ws}-wear`, planId: `${ws}-plan`, itemIds: ['J1'], occurredAt: '2026-11-02' } },
        { op: 'putPlan', plan: { planId: `${ws}-plan`, occasionDate: '2026-11-02', state: 'WORN', slots: { outer: 'J1' }, pinned: ['J1'], context: {} as never, baseRevision: 0 } },
        { op: 'putAvailability', row: { itemId: 'J1', state: 'LAUNDRY', since: '2026-11-02' } },
      ],
    }),
    createdAt,
  );
  assert.equal(w.ok, true, `${ws}: ${JSON.stringify(w)}`);
  ledger.saveOperation({ operationId: `${ws}-op`, workspaceId: ws, generation: 1, state: 'PROPOSED', kind: 'photo' }, createdAt);
  ledger.insertCall(callAt(ws, createdAt));
  extras.addChoice(ws, { choiceId: `${ws}-choice`, itemId: 'J1', action: 'keep', note: null, at: createdAt });
  extras.setTarget(ws, 'look-1', true, createdAt);
}

test('RT-01 visitor sweep: only visitor forks older than 24 h with no call since; every row keyed by them goes, call rows stay', () => {
  const path = dbPath('sweep');
  const ledger = new SqliteLedger(path, FLAGS);
  const extras = new ExtrasStore(path);
  try {
    fill(ledger, extras, 'try-old', 'visitor', OLD);
    fill(ledger, extras, 'try-new', 'visitor', RECENT);
    fill(ledger, extras, 'try-busy', 'visitor', OLD);
    ledger.insertCall(callAt('try-busy', RECENT)); // a call since the cutoff keeps the row (its cost still counts for the day)
    fill(ledger, extras, 'owner', 'real', OLD);
    fill(ledger, extras, 'demo-rc1', 'demo', OLD);
    fill(ledger, extras, 'closet-old', 'rehearsal', OLD);
    const spendBefore = ledger.spend({ sessionId: null, kstDate: '2026-11-04' }).appTotal;

    assert.deepEqual(ledger.staleVisitorWorkspaces(CUTOFF), ['try-old']);
    for (const id of ['owner', 'demo-rc1', 'closet-old']) {
      assert.equal(ledger.deleteVisitorWorkspace(id), false, `${id} is refused even when asked directly`);
      assert.ok(ledger.getWorkspace(id), id);
    }

    assert.equal(ledger.deleteVisitorWorkspace('try-old'), true);
    extras.deleteWorkspace('try-old');
    assert.equal(ledger.getWorkspace('try-old'), null);
    const gone = ledger.readState('try-old', { fresh: true });
    assert.deepEqual([gone.events.length, gone.items.length, gone.availability.length, gone.plans.length, gone.wearRows.length], [0, 0, 0, 0, 0]);
    assert.equal(ledger.getOperation('try-old-op'), null);
    assert.deepEqual(extras.choices('try-old'), []);
    assert.deepEqual(extras.targets('try-old'), []);
    // The money ledger is untouched: the call row stays and the app total does not move.
    assert.ok(ledger.listCalls(100).some((c) => c.workspaceId === 'try-old'));
    assert.equal(ledger.spend({ sessionId: null, kstDate: '2026-11-04' }).appTotal, spendBefore);
    // Everything else keeps every row.
    for (const id of ['try-new', 'try-busy', 'owner', 'demo-rc1', 'closet-old']) {
      const st = ledger.readState(id, { fresh: true });
      assert.equal(st.items.length, seedItems(OUTSIDE_PHOTO_ROLES).length, id);
      assert.deepEqual([st.events.length, st.plans.length, st.wearRows.length], [1, 1, 1], id);
      assert.ok(ledger.getOperation(`${id}-op`), id);
      assert.equal(extras.choices(id).length, 1, id);
      assert.deepEqual(extras.targets(id), ['look-1'], id);
    }
    assert.deepEqual(ledger.staleVisitorWorkspaces(CUTOFF), [], 'nothing left to sweep');
    assert.equal(ledger.deleteVisitorWorkspace('try-old'), false, 'already gone');
  } finally {
    ledger.close();
    extras.close();
  }
});

test('RT-02 a database file from before the created_at column gets the column; its rows are dated at the upgrade, not swept at once', () => {
  const path = dbPath('migrate');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, kind TEXT NOT NULL, public_read_only INTEGER NOT NULL, seed_ref TEXT, ledger_revision INTEGER NOT NULL, created_on TEXT NOT NULL);');
  raw.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?)').run('try-legacy', 'visitor', 0, 'fx-h', 0, '2026-10-01');
  raw.close();
  const before = new Date().toISOString();
  const ledger = new SqliteLedger(path, FLAGS);
  try {
    const row = ledger.getWorkspace('try-legacy');
    assert.ok(row && row.kind === 'visitor');
    assert.deepEqual(ledger.staleVisitorWorkspaces(before), [], 'dated at the upgrade, so not stale yet');
    assert.deepEqual(ledger.staleVisitorWorkspaces('2999-01-01T00:00:00.000Z'), ['try-legacy']);
    assert.equal(ledger.deleteVisitorWorkspace('try-legacy'), true);
  } finally {
    ledger.close();
  }
});
