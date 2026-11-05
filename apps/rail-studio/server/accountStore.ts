import { DatabaseSync } from 'node:sqlite';
import type { GarmentPiece } from '../src/types/closet.ts';

export interface WardrobeDocument {
  workspaceId: string;
  revision: number;
  pieces: GarmentPiece[];
  updatedAt: string | null;
}

/** Presentation records belong to an account; they are separate from the event ledger. */
export class AccountWardrobeStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS rail_studio_wardrobes (
      workspace_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      pieces_json TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }
  close() { this.db.close(); }
  read(workspaceId: string): WardrobeDocument {
    const row = this.db.prepare('SELECT revision,pieces_json,updated_at FROM rail_studio_wardrobes WHERE workspace_id=?').get(workspaceId) as
      { revision: number; pieces_json: string; updated_at: string } | undefined;
    return row ? { workspaceId, revision: Number(row.revision), pieces: JSON.parse(row.pieces_json), updatedAt: row.updated_at }
      : { workspaceId, revision: 0, pieces: [], updatedAt: null };
  }
  save(workspaceId: string, expectedRevision: number, pieces: GarmentPiece[]): WardrobeDocument | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(workspaceId);
      if (current.revision !== expectedRevision) { this.db.exec('ROLLBACK'); return null; }
      const json = JSON.stringify(pieces);
      const revision = expectedRevision + 1;
      const updatedAt = new Date().toISOString();
      this.db.prepare(`INSERT INTO rail_studio_wardrobes VALUES (?,?,?,?)
        ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,pieces_json=excluded.pieces_json,updated_at=excluded.updated_at`)
        .run(workspaceId, revision, json, updatedAt);
      const saved = this.read(workspaceId);
      if (saved.revision !== revision || JSON.stringify(saved.pieces) !== json) throw new Error('READBACK_MISMATCH');
      this.db.exec('COMMIT');
      return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
