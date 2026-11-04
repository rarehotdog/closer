// Side tables for features 2 and 3: review exemptions and choices, price evidence the owner
// entered, and hand-off drafts. They live in the same database file but outside stateHash: they
// are the owner's working notes, not wardrobe facts. Every write is read back before it returns.
import { DatabaseSync } from 'node:sqlite';
import type { Exemption, ReviewAction } from '../engine/review.ts';
import type { Evidence, Handoff, HandoffState } from '../engine/market.ts';
import type { DecisionSnapshot } from '../engine/decision.ts';

type Row = Record<string, unknown>;

export type ReviewChoice = { choiceId: string; itemId: string; action: ReviewAction; note: string | null; at: string };

export class ExtrasStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_exemptions (workspace_id TEXT, item_id TEXT, reason TEXT, review_after TEXT, note TEXT, PRIMARY KEY (workspace_id, item_id));
      CREATE TABLE IF NOT EXISTS review_choices (choice_id TEXT PRIMARY KEY, workspace_id TEXT, item_id TEXT, action TEXT, note TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS evidence (evidence_id TEXT PRIMARY KEY, workspace_id TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS handoffs (draft_id TEXT PRIMARY KEY, workspace_id TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS look_targets (workspace_id TEXT, look_id TEXT, at TEXT, PRIMARY KEY (workspace_id, look_id));
      CREATE TABLE IF NOT EXISTS decisions (decision_id TEXT PRIMARY KEY, workspace_id TEXT, item_id TEXT, at TEXT, body TEXT);
    `);
  }

  // ---- keep-or-let-go decisions (insert only: a snapshot is never edited or deleted) ----
  addDecision(ws: string, d: DecisionSnapshot): DecisionSnapshot {
    const body = JSON.stringify(d);
    this.db.prepare('INSERT INTO decisions VALUES (?,?,?,?,?)').run(d.decisionId, ws, d.itemId, d.at, body);
    const back = this.decision(ws, d.decisionId);
    if (!back || JSON.stringify(back) !== body) throw new Error('READBACK_MISMATCH: decision');
    return back;
  }

  decision(ws: string, decisionId: string): DecisionSnapshot | null {
    const r = this.db.prepare('SELECT body FROM decisions WHERE workspace_id = ? AND decision_id = ?').get(ws, decisionId) as Row | undefined;
    return r ? (JSON.parse(String(r.body)) as DecisionSnapshot) : null;
  }

  decisions(ws: string, itemId?: string): DecisionSnapshot[] {
    const rows = itemId
      ? (this.db.prepare('SELECT body FROM decisions WHERE workspace_id = ? AND item_id = ? ORDER BY at, decision_id').all(ws, itemId) as Row[])
      : (this.db.prepare('SELECT body FROM decisions WHERE workspace_id = ? ORDER BY at, decision_id').all(ws) as Row[]);
    return rows.map((r) => JSON.parse(String(r.body)) as DecisionSnapshot);
  }

  // ---- style targets (looks the owner wants to be able to wear) ----
  setTarget(ws: string, lookId: string, on: boolean, at: string): string[] {
    if (on) this.db.prepare('INSERT OR REPLACE INTO look_targets VALUES (?,?,?)').run(ws, lookId, at);
    else this.db.prepare('DELETE FROM look_targets WHERE workspace_id = ? AND look_id = ?').run(ws, lookId);
    const back = this.targets(ws);
    if (back.includes(lookId) !== on) throw new Error('READBACK_MISMATCH: target');
    return back;
  }

  targets(ws: string): string[] {
    return (this.db.prepare('SELECT look_id FROM look_targets WHERE workspace_id = ? ORDER BY at, rowid').all(ws) as Row[]).map((r) => String(r.look_id));
  }

  close(): void {
    this.db.close();
  }

  // ---- exemptions ----
  putExemption(ws: string, itemId: string, e: Exemption): Exemption {
    this.db.prepare('INSERT OR REPLACE INTO review_exemptions VALUES (?,?,?,?,?)').run(ws, itemId, e.reason, e.reviewAfter, e.note);
    const back = this.exemptions(ws).get(itemId);
    if (!back || back.reason !== e.reason || back.reviewAfter !== e.reviewAfter) throw new Error('READBACK_MISMATCH: exemption');
    return back;
  }

  clearExemption(ws: string, itemId: string): void {
    this.db.prepare('DELETE FROM review_exemptions WHERE workspace_id = ? AND item_id = ?').run(ws, itemId);
  }

  exemptions(ws: string): Map<string, Exemption> {
    const rows = this.db.prepare('SELECT * FROM review_exemptions WHERE workspace_id = ?').all(ws) as Row[];
    return new Map(rows.map((r) => [String(r.item_id), { reason: r.reason as Exemption['reason'], reviewAfter: String(r.review_after), note: (r.note as string | null) ?? null }]));
  }

  // ---- review choices (a log; the latest choice per item is the current one) ----
  addChoice(ws: string, c: ReviewChoice): ReviewChoice {
    this.db.prepare('INSERT INTO review_choices VALUES (?,?,?,?,?,?)').run(c.choiceId, ws, c.itemId, c.action, c.note, c.at);
    const back = this.choices(ws).find((x) => x.choiceId === c.choiceId);
    if (!back) throw new Error('READBACK_MISMATCH: review choice');
    return back;
  }

  choices(ws: string): ReviewChoice[] {
    const rows = this.db.prepare('SELECT * FROM review_choices WHERE workspace_id = ? ORDER BY at, choice_id').all(ws) as Row[];
    return rows.map((r) => ({ choiceId: String(r.choice_id), itemId: String(r.item_id), action: r.action as ReviewAction, note: (r.note as string | null) ?? null, at: String(r.at) }));
  }

  // ---- evidence ----
  addEvidence(ws: string, e: Evidence): Evidence {
    this.db.prepare('INSERT INTO evidence VALUES (?,?,?)').run(e.evidenceId, ws, JSON.stringify(e));
    const back = this.evidence(ws).find((x) => x.evidenceId === e.evidenceId);
    if (!back || back.amount !== e.amount) throw new Error('READBACK_MISMATCH: evidence');
    return back;
  }

  evidence(ws: string): Evidence[] {
    return (this.db.prepare('SELECT body FROM evidence WHERE workspace_id = ? ORDER BY evidence_id').all(ws) as Row[]).map((r) => JSON.parse(String(r.body)) as Evidence);
  }

  // ---- hand-offs ----
  putHandoff(ws: string, h: Handoff): Handoff {
    this.db.prepare('INSERT OR REPLACE INTO handoffs VALUES (?,?,?)').run(h.draftId, ws, JSON.stringify(h));
    const back = this.handoff(ws, h.draftId);
    if (!back || back.state !== h.state || back.body !== h.body) throw new Error('READBACK_MISMATCH: hand-off');
    return back;
  }

  handoff(ws: string, draftId: string): Handoff | null {
    const r = this.db.prepare('SELECT body FROM handoffs WHERE workspace_id = ? AND draft_id = ?').get(ws, draftId) as Row | undefined;
    return r ? (JSON.parse(String(r.body)) as Handoff) : null;
  }

  handoffs(ws: string): Handoff[] {
    return (this.db.prepare('SELECT body FROM handoffs WHERE workspace_id = ? ORDER BY draft_id').all(ws) as Row[]).map((r) => JSON.parse(String(r.body)) as Handoff);
  }
}

export const HANDOFF_NEXT: Record<HandoffState, HandoffState[]> = {
  DRAFT: ['REVIEWED'],
  REVIEWED: ['OWNER_REPORTED_DONE', 'DRAFT'],
  OWNER_REPORTED_DONE: [],
};
