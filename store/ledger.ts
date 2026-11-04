// Mock server DB (SQLite file via node:sqlite) implementing the §3-6 ledger contract.
// Write path: ① eventId+payloadHash ② expectedRevision ③ transition conditions (decide callback,
// evaluated inside the transaction) ④ commit. ⑤ read-back uses a separate connection and a new read
// transaction. Model calls never happen inside a transaction (the store has no model access).
import { DatabaseSync } from 'node:sqlite';
import { canonicalHash } from '../shared/canonical.ts';
import type {
  AvailabilityRow, CallRow, Decision, EventInput, EventRow, FlagsRow, ItemRow, LedgerState, Mutation,
  PlanRow, WearRow, WorkspaceRow, WriteRequest, WriteResponse,
} from '../shared/ledger.ts';
import type { IsoDate } from '../shared/dates.ts';
import type { Item } from '../shared/wardrobe.ts';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY, kind TEXT NOT NULL, public_read_only INTEGER NOT NULL,
  seed_ref TEXT, ledger_revision INTEGER NOT NULL, created_on TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  workspace_id TEXT NOT NULL, ledger_revision INTEGER NOT NULL, occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL, corrects_event_id TEXT, payload_json TEXT NOT NULL, response_json TEXT,
  UNIQUE (workspace_id, ledger_revision));
CREATE TABLE IF NOT EXISTS items (
  workspace_id TEXT NOT NULL, item_id TEXT NOT NULL, slot TEXT NOT NULL, type TEXT NOT NULL,
  color TEXT NOT NULL, formality TEXT NOT NULL, ownership TEXT NOT NULL, cutout_ref TEXT,
  origin TEXT NOT NULL, waterproof INTEGER, sample INTEGER NOT NULL, PRIMARY KEY (workspace_id, item_id));
CREATE TABLE IF NOT EXISTS availability (
  workspace_id TEXT NOT NULL, item_id TEXT NOT NULL, state TEXT NOT NULL, since TEXT NOT NULL,
  PRIMARY KEY (workspace_id, item_id));
CREATE TABLE IF NOT EXISTS plans (
  workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL, occasion_date TEXT NOT NULL, state TEXT NOT NULL,
  slots_json TEXT NOT NULL, pinned_json TEXT NOT NULL, context_json TEXT NOT NULL, base_revision INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plan_id));
CREATE TABLE IF NOT EXISTS wear_rows (
  workspace_id TEXT NOT NULL, event_id TEXT PRIMARY KEY, plan_id TEXT, item_ids_json TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
  kind TEXT NOT NULL, updated_at TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY, operation_id TEXT, workspace_id TEXT, session_id TEXT, model TEXT NOT NULL,
  http INTEGER NOT NULL, latency_ms INTEGER NOT NULL, usage_json TEXT, cost_micro_usd INTEGER NOT NULL,
  est_live_cost_micro_usd INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

export type StoredOperation = { operationId: string; workspaceId: string; generation: number; state: string; kind: string } & Record<string, unknown>;

export class SqliteLedger {
  readonly path: string;
  private readonly db: DatabaseSync;
  private reader: DatabaseSync | null = null;
  private readonly defaultFlags: FlagsRow;

  constructor(path: string, defaultFlags: FlagsRow) {
    this.path = path;
    this.defaultFlags = defaultFlags;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.reader?.close();
    this.db.close();
  }

  // ---------- workspaces ----------
  createWorkspace(ws: Omit<WorkspaceRow, 'ledgerRevision'>, seeds: { items: Item[]; since: IsoDate } | null): WorkspaceRow {
    this.tx(() => {
      this.db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,0,?)').run(ws.workspaceId, ws.kind, ws.publicReadOnly ? 1 : 0, ws.seedRef, ws.createdOn);
      for (const it of seeds?.items ?? []) {
        this.putItem(ws.workspaceId, it);
        this.putAvailability(ws.workspaceId, { itemId: it.itemId, state: 'AVAILABLE', since: seeds!.since });
      }
    });
    return this.getWorkspace(ws.workspaceId)!;
  }

  getWorkspace(id: string): WorkspaceRow | null {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(id) as Row | undefined;
    return r ? toWorkspace(r) : null;
  }

  listWorkspaces(): WorkspaceRow[] {
    return (this.db.prepare('SELECT * FROM workspaces ORDER BY workspace_id').all() as Row[]).map(toWorkspace);
  }

  // ---------- reads ----------
  /** fresh=true: separate connection + new read transaction (step ⑤). */
  readState(workspaceId: string, opts: { fresh: boolean } = { fresh: true }): LedgerState {
    const conn = opts.fresh ? this.readerConn() : this.db;
    if (conn === this.db) return this.readWith(conn, workspaceId);
    conn.exec('BEGIN');
    try {
      return this.readWith(conn, workspaceId);
    } finally {
      conn.exec('COMMIT');
    }
  }

  stateHash(workspaceId: string): string {
    return stateHashOf(this.readState(workspaceId, { fresh: true }));
  }

  lookupEvent(workspaceId: string, eventId: string): { event: EventRow; response: WriteResponse | null } | null {
    const r = this.readerConn().prepare('SELECT * FROM events WHERE event_id = ? AND workspace_id = ?').get(eventId, workspaceId) as Row | undefined;
    if (!r) return null;
    return { event: toEvent(r), response: r.response_json ? (JSON.parse(String(r.response_json)) as WriteResponse) : null };
  }

  // ---------- write ----------
  write(req: WriteRequest, decide: (state: LedgerState, ws: WorkspaceRow) => Decision, recordedAt: string): WriteResponse {
    const ws = this.getWorkspace(req.workspaceId);
    if (!ws) return { ok: false, code: 'SCOPE_DENIED', detail: 'unknown workspace' };
    if (ws.publicReadOnly) return { ok: false, code: 'SCOPE_DENIED', detail: 'read-only workspace' };
    if (req.events.length === 0) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no events' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // ① eventId + payloadHash
      const hashes = req.events.map((e) => payloadHash(req.workspaceId, e));
      const existing = req.events.map((e) => this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(e.eventId) as Row | undefined);
      if (existing.some(Boolean)) {
        const allSame = existing.every((x, i) => x && x.payload_hash === hashes[i] && x.workspace_id === req.workspaceId);
        this.db.exec('ROLLBACK');
        if (allSame && existing[0]!.response_json) return JSON.parse(String(existing[0]!.response_json)) as WriteResponse;
        return { ok: false, code: 'EVENT_CONFLICT', detail: 'same eventId with a different payload' };
      }
      // ② expectedRevision
      const cur = this.getWorkspace(req.workspaceId)!;
      if (req.expectedRevision !== cur.ledgerRevision) {
        this.db.exec('ROLLBACK');
        return { ok: false, code: 'STALE_STATE', detail: `expected revision ${req.expectedRevision}, ledger is at ${cur.ledgerRevision}` };
      }
      // ③ transition conditions (incl. actor), on the state inside this transaction
      const d = decide(this.readWith(this.db, req.workspaceId), cur);
      if (!d.ok) {
        this.db.exec('ROLLBACK');
        return { ok: false, code: d.code, detail: d.detail };
      }
      // ④ commit
      let rev = cur.ledgerRevision;
      for (const [i, e] of req.events.entries()) {
        rev++;
        this.db
          .prepare('INSERT INTO events (event_id,payload_hash,kind,actor,workspace_id,ledger_revision,occurred_at,recorded_at,corrects_event_id,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(e.eventId, hashes[i], e.kind, e.actor, req.workspaceId, rev, e.occurredAt, recordedAt, e.correctsEventId, JSON.stringify(e.payload ?? null));
      }
      for (const m of d.mutations) this.apply(req.workspaceId, m);
      this.db.prepare('UPDATE workspaces SET ledger_revision = ? WHERE workspace_id = ?').run(rev, req.workspaceId);
      const response: WriteResponse = { ok: true, workspaceId: req.workspaceId, eventIds: req.events.map((e) => e.eventId), ledgerRevision: rev, result: d.result ?? null };
      const json = JSON.stringify(response);
      for (const e of req.events) this.db.prepare('UPDATE events SET response_json = ? WHERE event_id = ?').run(json, e.eventId);
      this.db.exec('COMMIT');
      return JSON.parse(json) as WriteResponse;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  // ---------- operations (run records, outside stateHash) ----------
  saveOperation(op: StoredOperation, updatedAt: string): void {
    this.db
      .prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET generation=excluded.generation, state=excluded.state, updated_at=excluded.updated_at, data_json=excluded.data_json')
      .run(op.operationId, op.workspaceId, op.generation, op.state, op.kind, updatedAt, JSON.stringify(op));
  }

  getOperation(operationId: string): StoredOperation | null {
    const r = this.db.prepare('SELECT data_json FROM operations WHERE operation_id = ?').get(operationId) as Row | undefined;
    return r ? (JSON.parse(String(r.data_json)) as StoredOperation) : null;
  }

  listOperations(workspaceId: string, limit = 20): StoredOperation[] {
    return (this.db.prepare('SELECT data_json FROM operations WHERE workspace_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?').all(workspaceId, limit) as Row[]).map(
      (r) => JSON.parse(String(r.data_json)) as StoredOperation,
    );
  }

  // ---------- calls (outside stateHash) ----------
  insertCall(c: CallRow): void {
    this.db
      .prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(c.callId, c.operationId, c.workspaceId, c.sessionId, c.model, c.http, c.latencyMs, c.usage ? JSON.stringify(c.usage) : null, c.costMicroUsd, c.estLiveCostMicroUsd, c.source, c.createdAt);
  }

  listCalls(limit = 50): CallRow[] {
    return (this.db.prepare('SELECT * FROM calls ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(toCall);
  }

  /** Live model calls that came back 2xx (the same rows the live chips are made from). Counted, never estimated. */
  countLiveCalls(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE source = 'live' AND http BETWEEN 200 AND 299").get() as Row | undefined;
    return Number(r?.n ?? 0);
  }

  callsForOperation(operationId: string): CallRow[] {
    return (this.db.prepare('SELECT * FROM calls WHERE operation_id = ? ORDER BY rowid').all(operationId) as Row[]).map(toCall);
  }

  /**
   * Spend in micro-USD: app total, public copies on the given KST date, one session. Public copies are
   * the visitor forks and the sample closets (seed_ref 'sample-closet'): the same rows that
   * isPublicCopy() in engine/service.ts gates with the visitor day cap.
   */
  spend(args: { sessionId: string | null; kstDate: IsoDate }): { appTotal: number; visitorDay: number; session: number } {
    const n = (r: unknown) => Number((r as Row | undefined)?.s ?? 0);
    const appTotal = n(this.db.prepare('SELECT COALESCE(SUM(cost_micro_usd),0) AS s FROM calls').get());
    const visitorDay = n(
      this.db
        .prepare("SELECT COALESCE(SUM(c.cost_micro_usd),0) AS s FROM calls c JOIN workspaces w ON w.workspace_id = c.workspace_id WHERE (w.kind = 'visitor' OR w.seed_ref = 'sample-closet') AND date(c.created_at, '+9 hours') = ?")
        .get(args.kstDate),
    );
    const session = args.sessionId ? n(this.db.prepare('SELECT COALESCE(SUM(cost_micro_usd),0) AS s FROM calls WHERE session_id = ?').get(args.sessionId)) : 0;
    return { appTotal, visitorDay, session };
  }

  // ---------- flags (outside stateHash) ----------
  getFlags(): FlagsRow {
    const get = (k: string) => this.db.prepare('SELECT value_json FROM flags WHERE key = ?').get(k) as Row | undefined;
    const kill = get('kill');
    const caps = get('caps');
    return {
      kill: kill ? JSON.parse(String(kill.value_json)) : this.defaultFlags.kill,
      caps: caps ? JSON.parse(String(caps.value_json)) : this.defaultFlags.caps,
    };
  }

  setFlag(key: 'kill' | 'caps', value: unknown): void {
    this.db.prepare('INSERT INTO flags VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(key, JSON.stringify(value));
  }

  // ---------- internals ----------
  private readerConn(): DatabaseSync {
    if (this.path === ':memory:') return this.db;
    if (!this.reader) this.reader = new DatabaseSync(this.path);
    return this.reader;
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private readWith(conn: DatabaseSync, workspaceId: string): LedgerState {
    const ws = conn.prepare('SELECT ledger_revision FROM workspaces WHERE workspace_id = ?').get(workspaceId) as Row | undefined;
    const all = (sql: string) => conn.prepare(sql).all(workspaceId) as Row[];
    return {
      workspaceId,
      revision: Number(ws?.ledger_revision ?? 0),
      events: all('SELECT * FROM events WHERE workspace_id = ? ORDER BY ledger_revision').map(toEvent),
      items: all('SELECT * FROM items WHERE workspace_id = ? ORDER BY item_id').map(toItem),
      availability: all('SELECT * FROM availability WHERE workspace_id = ? ORDER BY item_id').map((r) => ({ itemId: String(r.item_id), state: r.state as AvailabilityRow['state'], since: String(r.since) })),
      plans: all('SELECT * FROM plans WHERE workspace_id = ? ORDER BY plan_id').map(toPlan),
      wearRows: all('SELECT * FROM wear_rows WHERE workspace_id = ? ORDER BY event_id').map((r) => ({
        eventId: String(r.event_id), planId: r.plan_id === null ? null : String(r.plan_id), itemIds: JSON.parse(String(r.item_ids_json)) as string[], occurredAt: String(r.occurred_at),
      })),
    };
  }

  private apply(ws: string, m: Mutation): void {
    switch (m.op) {
      case 'putItem':
        return this.putItem(ws, m.item);
      case 'putAvailability':
        return this.putAvailability(ws, m.row);
      case 'putPlan':
        this.db
          .prepare('INSERT INTO plans VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id, plan_id) DO UPDATE SET occasion_date=excluded.occasion_date, state=excluded.state, slots_json=excluded.slots_json, pinned_json=excluded.pinned_json, context_json=excluded.context_json, base_revision=excluded.base_revision')
          .run(ws, m.plan.planId, m.plan.occasionDate, m.plan.state, JSON.stringify(m.plan.slots), JSON.stringify(m.plan.pinned), JSON.stringify(m.plan.context), m.plan.baseRevision);
        return;
      case 'insertWear':
        this.db.prepare('INSERT INTO wear_rows VALUES (?,?,?,?,?)').run(ws, m.row.eventId, m.row.planId, JSON.stringify(m.row.itemIds), m.row.occurredAt);
        return;
      case 'deleteWear':
        this.db.prepare('DELETE FROM wear_rows WHERE workspace_id = ? AND event_id = ?').run(ws, m.eventId);
        return;
    }
  }

  private putItem(ws: string, it: ItemRow): void {
    this.db
      .prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id, item_id) DO UPDATE SET slot=excluded.slot, type=excluded.type, color=excluded.color, formality=excluded.formality, ownership=excluded.ownership, cutout_ref=excluded.cutout_ref, origin=excluded.origin, waterproof=excluded.waterproof, sample=excluded.sample')
      .run(ws, it.itemId, it.slot, it.type, it.color, it.formality, it.ownership, it.cutoutRef, it.origin, it.waterproof === null ? null : it.waterproof ? 1 : 0, it.sample ? 1 : 0);
  }

  private putAvailability(ws: string, a: AvailabilityRow): void {
    this.db.prepare('INSERT INTO availability VALUES (?,?,?,?) ON CONFLICT(workspace_id, item_id) DO UPDATE SET state=excluded.state, since=excluded.since').run(ws, a.itemId, a.state, a.since);
  }
}

export function payloadHash(workspaceId: string, e: EventInput): string {
  return canonicalHash({ kind: e.kind, actor: e.actor, workspaceId, occurredAt: e.occurredAt, correctsEventId: e.correctsEventId, payload: e.payload ?? null });
}

/** SHA-256 of canonical JSON of the ledger state only (§3-6). Run records and call ledger are outside. */
export function stateHashOf(s: LedgerState): string {
  return canonicalHash({
    events: s.events.map((e) => ({ ...e })),
    items: s.items,
    availability: s.availability,
    plans: s.plans,
    wearRows: s.wearRows,
  });
}

function toWorkspace(r: Row): WorkspaceRow {
  return {
    workspaceId: String(r.workspace_id), kind: r.kind as WorkspaceRow['kind'], publicReadOnly: Number(r.public_read_only) === 1,
    seedRef: r.seed_ref === null ? null : String(r.seed_ref), ledgerRevision: Number(r.ledger_revision), createdOn: String(r.created_on),
  };
}

function toEvent(r: Row): EventRow {
  return {
    eventId: String(r.event_id), payloadHash: String(r.payload_hash), kind: r.kind as EventRow['kind'], actor: r.actor as EventRow['actor'],
    workspaceId: String(r.workspace_id), ledgerRevision: Number(r.ledger_revision), occurredAt: String(r.occurred_at), recordedAt: String(r.recorded_at),
    correctsEventId: r.corrects_event_id === null ? null : String(r.corrects_event_id), payload: JSON.parse(String(r.payload_json)),
  };
}

function toItem(r: Row): ItemRow {
  return {
    itemId: String(r.item_id), slot: r.slot as ItemRow['slot'], type: r.type as ItemRow['type'], color: r.color as ItemRow['color'],
    formality: r.formality as ItemRow['formality'], ownership: r.ownership as ItemRow['ownership'], cutoutRef: r.cutout_ref === null ? null : String(r.cutout_ref),
    origin: r.origin as ItemRow['origin'], waterproof: r.waterproof === null ? null : Number(r.waterproof) === 1, sample: Number(r.sample) === 1,
  };
}

function toPlan(r: Row): PlanRow {
  return {
    planId: String(r.plan_id), occasionDate: String(r.occasion_date), state: r.state as PlanRow['state'], slots: JSON.parse(String(r.slots_json)),
    pinned: JSON.parse(String(r.pinned_json)), context: JSON.parse(String(r.context_json)), baseRevision: Number(r.base_revision),
  };
}

function toCall(r: Row): CallRow {
  return {
    callId: String(r.call_id), operationId: r.operation_id === null ? null : String(r.operation_id), workspaceId: r.workspace_id === null ? null : String(r.workspace_id),
    sessionId: r.session_id === null ? null : String(r.session_id), model: String(r.model), http: Number(r.http), latencyMs: Number(r.latency_ms),
    usage: r.usage_json ? JSON.parse(String(r.usage_json)) : null, costMicroUsd: Number(r.cost_micro_usd), estLiveCostMicroUsd: Number(r.est_live_cost_micro_usd),
    source: r.source as CallRow['source'], createdAt: String(r.created_at),
  };
}

export type { WearRow, PlanRow };
