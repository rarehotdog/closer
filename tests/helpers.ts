// Test harness. Installs the no-network guard before anything else runs in the test process.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.CLOSER_FORBID_REAL = '1';
delete process.env.MODEL_API_KEY;
globalThis.fetch = (async () => {
  throw new Error('network access is forbidden in tests');
}) as typeof fetch;

import { SqliteLedger } from '../store/ledger.ts';
import { CloserService, type Operation } from '../engine/service.ts';
import { createMockPorts } from '../adapters/index.ts';
import type { MockScript } from '../adapters/mock/transport.ts';
import { createPhotoLibrary } from '../fixtures/photos.ts';
import { HERO_SENTENCE, OUTSIDE_PHOTO_ROLES, seedItems } from '../fixtures/fxh.ts';
import { KILL_TTL_MS, PROVISIONAL_CAPS, type Caps } from '../engine/caps.ts';
import type { RuleSet } from '../engine/rules.ts';
import type { WorkspaceKind } from '../shared/states.ts';
import type { HardRule, Item } from '../shared/wardrobe.ts';
import type { WriteResponse } from '../shared/ledger.ts';

export const ROOT = new URL('..', import.meta.url).pathname;

let counter = 0;
const uid = () => `${process.pid}-${++counter}`;

export type HarnessOptions = {
  kind?: WorkspaceKind;
  publicReadOnly?: boolean;
  seeds?: readonly string[];
  today?: string;
  now?: string;
  script?: MockScript;
  rules?: RuleSet;
  caps?: Caps;
  spark2Mode?: 'model' | 'code';
  /** Extra sample items (e.g. a second outer for AT-08, a new item for AT-26). */
  extraSeeds?: Item[];
  /** Attribute overrides on seeded items (e.g. FX-E4 unknown formality). */
  itemPatch?: Record<string, Partial<Item>>;
};

export function harness(opts: HarnessOptions = {}) {
  const dir = join(ROOT, '.data', 'test');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `t-${uid()}.db`);
  const ledger = new SqliteLedger(path, { kill: { on: false, setAt: null, ttlMs: KILL_TTL_MS }, caps: opts.caps ?? PROVISIONAL_CAPS });
  const clock = { now: new Date(opts.now ?? '2026-10-31T10:00:00+09:00'), today: opts.today ?? '2026-10-31' };
  const lib = createPhotoLibrary();
  const sleeps: number[] = [];
  const { ports, transport } = createMockPorts(
    lib,
    { sleep: async (ms) => void sleeps.push(ms), nowMs: () => performance.now(), nowIso: () => clock.now.toISOString() },
    opts.script ?? {},
  );
  const svc = new CloserService({
    ledger, ports, photos: lib, mode: 'mock', rules: opts.rules, spark2Mode: opts.spark2Mode,
    clock: { now: () => clock.now, today: () => clock.today },
  });
  const ws = 'ws-test';
  ledger.createWorkspace(
    { workspaceId: ws, kind: opts.kind ?? 'real', publicReadOnly: opts.publicReadOnly ?? false, seedRef: 'fx-h', createdOn: '2026-10-27' },
    {
      items: [...seedItems(opts.seeds ?? OUTSIDE_PHOTO_ROLES), ...(opts.extraSeeds ?? [])].map((it) => ({ ...it, ...(opts.itemPatch?.[it.itemId] ?? {}) })),
      since: '2026-10-27',
    },
  );
  return {
    ledger, svc, ws, clock, transport, sleeps, lib,
    rev: () => ledger.getWorkspace(ws)!.ledgerRevision,
    hash: () => ledger.stateHash(ws),
    state: () => ledger.readState(ws),
    calls: () => transport.log,
    cleanup() {
      ledger.close();
      for (const suf of ['', '-wal', '-shm']) rmSync(path + suf, { force: true });
    },
  };
}
export type Harness = ReturnType<typeof harness>;

export function isOp(x: unknown): x is Operation {
  return !!x && typeof x === 'object' && 'operationId' in x;
}

export function ok(r: WriteResponse): asserts r is Extract<WriteResponse, { ok: true }> {
  assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.detail}`);
}

export async function startHero(h: Harness, extra: { sentence?: string; photoId?: string; hardRules?: HardRule[]; weather?: { rainPct: number } | null } = {}): Promise<Operation> {
  const op = await h.svc.startPhoto(h.ws, { photoId: extra.photoId ?? 'p1', sentence: extra.sentence ?? HERO_SENTENCE, hardRules: extra.hardRules, weather: extra.weather });
  assert.ok(isOp(op), JSON.stringify(op));
  return op;
}

export async function heroRegistered(h: Harness, extra: Parameters<typeof startHero>[1] = {}): Promise<Operation> {
  const op = await startHero(h, extra);
  const r = h.svc.confirmCards(h.ws, { operationId: op.operationId, eventIds: op.cards.map((c) => `ev-reg-${c.cardId}-${uid()}`), actor: 'human', expectedRevision: h.rev() });
  ok(r);
  return h.svc.getOperation(op.operationId)!;
}

export async function heroProposed(h: Harness, extra: Parameters<typeof startHero>[1] = {}): Promise<Operation> {
  const op = await heroRegistered(h, extra);
  const p = await h.svc.propose(h.ws, { operationId: op.operationId });
  assert.ok(isOp(p), JSON.stringify(p));
  return p;
}

export function lock(h: Harness, op: Operation, optionIndex: number, eventId = `ev-lock-${uid()}`): WriteResponse {
  return h.svc.lock(h.ws, { operationId: op.operationId, optionIndex, eventId, actor: 'human', expectedRevision: h.rev() });
}

export function newId(prefix: string): string {
  return `${prefix}-${uid()}`;
}

export function laundry(h: Harness, itemId: string, state: 'LAUNDRY' | 'REPAIR' | 'STORED' | 'AVAILABLE' = 'LAUNDRY') {
  return h.svc.setAvailability(h.ws, { itemId, state, eventId: newId(`ev-av-${itemId}`), actor: 'human', expectedRevision: h.rev() });
}

export { HERO_SENTENCE };

export function sampleItem(itemId: string, slot: Item['slot'], type: Item['type'], color: Item['color'], formality: Item['formality']): Item {
  return { itemId, slot, type, color, formality, ownership: 'CONFIRMED', cutoutRef: null, origin: 'seed', waterproof: null, sample: true };
}
