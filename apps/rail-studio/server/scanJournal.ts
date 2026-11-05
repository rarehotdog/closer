import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GarmentPiece } from '../src/types/closet.ts';
import { isGarmentType, isColorFamily, FORMALITY_LEVELS, type GarmentType, type ColorFamily, type Formality } from '../../../shared/wardrobe.ts';
import type { ScanOk } from './scan.ts';
import type { Transport } from './closer/adapters/transport.ts';
import { EST_MICRO_USD, SAM_MODEL, readUsage, sparkCostMicroUsd } from './closer/adapters/responses.ts';
import { decodePng } from './closer/engine/png.ts';
import { InvalidWardrobe } from './wardrobeSchema.ts';

type ReceiptCard = { cardId: string; imageHash: string; cutoutSource: 'sam-mask' | 'box-crop'; type: GarmentType; color: ColorFamily; allowedColors?: ColorFamily[]; formality: Formality };
type CallSummary = { model: string; http: number; latencyMs: number; source: 'live'; costMicroUsd: number };
type ClaimedPiece = GarmentPiece & { scanReceiptId?: string; scanCardId?: string; scanColor?: string };

/** Digest pixels, not PNG metadata or compression. A browser may safely re-encode a cut-out. */
function imageHash(url: string | undefined): string | null {
  if (!url?.startsWith('data:image/png;base64,')) return null;
  try {
    const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    if (png.length < 33 || png.length > 4 * 1024 * 1024 || png.toString('ascii',12,16)!=='IHDR' || png.readUInt32BE(16)>512 || png.readUInt32BE(20)>512) return null;
    const pixels = decodePng(png);
    if (pixels.w > 512 || pixels.h > 512) return null;
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i + 3] === 0) pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 0;
    }
    return createHash('sha256').update(`${pixels.w}:${pixels.h}:`).update(pixels.data).digest('hex');
  } catch { return null; }
}

/**
 * The journal shares the account DB, never a different app's data. Reservations are durable:
 * an interrupted request keeps its allocation until an operator investigates it. Amounts are
 * conservative local estimates, not a provider invoice or a promise of the final billed amount.
 */
export class ScanJournal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY, operation_id TEXT, workspace_id TEXT, session_id TEXT, model TEXT NOT NULL,
        http INTEGER NOT NULL, latency_ms INTEGER NOT NULL, usage_json TEXT, cost_micro_usd INTEGER NOT NULL,
        est_live_cost_micro_usd INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rail_scan_attempts (
        attempt_id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        model TEXT NOT NULL, state TEXT NOT NULL, reserved_micro_usd INTEGER NOT NULL,
        estimated_micro_usd INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS rail_scan_attempts_scan ON rail_scan_attempts(scan_id);
      CREATE TABLE IF NOT EXISTS rail_scan_receipts (
        receipt_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, cards_json TEXT NOT NULL,
        source TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  status() {
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(reserved_micro_usd),0) AS reserved,
      COALESCE(SUM(estimated_micro_usd),0) AS estimated,
      COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) AS pending
      FROM rail_scan_attempts`).get() as { reserved: number; estimated: number; pending: number };
    const receipts = this.db.prepare('SELECT COUNT(*) AS n FROM rail_scan_receipts').get() as { n: number };
    const calls = this.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE source='live' AND http BETWEEN 200 AND 299").get() as { n: number };
    return { reservedMicroUsd: Number(row.reserved), estimatedCostMicroUsd: Number(row.estimated), pendingAttempts: Number(row.pending), scans: Number(receipts.n), successfulLiveCalls: Number(calls.n) };
  }
  private reserve(scanId: string, workspaceId: string, model: string, capMicroUsd: number): string | null {
    const estimate = model === SAM_MODEL ? EST_MICRO_USD.sam : EST_MICRO_USD.spark1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT COALESCE(SUM(reserved_micro_usd+estimated_micro_usd),0) AS used FROM rail_scan_attempts').get() as { used: number };
      if (!Number.isFinite(capMicroUsd) || Number(row.used) + estimate > capMicroUsd) { this.db.exec('ROLLBACK'); return null; }
      const attemptId = `scan-call-${randomUUID()}`;
      this.db.prepare('INSERT INTO rail_scan_attempts VALUES (?,?,?,?,?,?,?,?,NULL)').run(attemptId,scanId,workspaceId,model,'pending',estimate,0,new Date().toISOString());
      this.db.exec('COMMIT');
      return attemptId;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private finish(attemptId: string, status: number, latencyMs: number, json: unknown) {
    const usage = readUsage(json);
    const validUsage = usage && Object.values(usage).every(v => Number.isSafeInteger(v) && v >= 0) ? usage : null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM rail_scan_attempts WHERE attempt_id=?').get(attemptId) as { scan_id:string; workspace_id:string; model:string; reserved_micro_usd:number; state:string } | undefined;
      if (!row || row.state !== 'pending') throw new Error('Attempt was already recorded');
      const estimate = Number(row.reserved_micro_usd);
      // An error or timeout can still have been processed remotely. Do not release its allowance.
      const cost = status >= 200 && status < 300 && row.model !== SAM_MODEL ? sparkCostMicroUsd(validUsage,estimate) : estimate;
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptId,row.scan_id,row.workspace_id,null,row.model,status,Math.max(0,Math.round(latencyMs)),validUsage ? JSON.stringify(validUsage) : null,cost,estimate,'live',now);
      this.db.prepare("UPDATE rail_scan_attempts SET state=?,reserved_micro_usd=0,estimated_micro_usd=?,finished_at=? WHERE attempt_id=?").run(status === 0 || status === 504 ? 'uncertain' : 'complete',cost,now,attemptId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Each real HTTP attempt has its own durable reservation and call row, including failures. */
  transport(scanId: string, workspaceId: string, capMicroUsd: number, raw: Transport, deadline: number, onRefusal?: (reason: 'budget' | 'deadline') => void): Transport {
    return async (request) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { onRefusal?.('deadline'); return {status:504,headers:{},json:null}; }
      const model = String(request.body.model ?? 'unknown');
      const attemptId = this.reserve(scanId,workspaceId,model,capMicroUsd);
      // 402 is not retried. This refusal is local, and intentionally creates no provider call row.
      if (!attemptId) { onRefusal?.('budget'); return {status:402,headers:{},json:null}; }
      const start = Date.now();
      let response;
      try {
        response = await raw({...request,signal:AbortSignal.timeout(Math.max(1,Math.min(45_000,remaining)))});
      } catch (error) {
        // Do not propagate network exception strings: they may contain request details.
        const timedOut = (error as {name?:string})?.name === 'TimeoutError' || (error as {name?:string})?.name === 'AbortError';
        response = {status:timedOut ? 504 : 0,headers:{},json:null};
      }
      this.finish(attemptId,response.status,Date.now()-start,response.json);
      const headers: Record<string,string> = {...response.headers};
      if ('retry-after' in headers) headers['retry-after'] = String(Math.min(2,Math.max(0,Number(headers['retry-after']) || 0)));
      return {...response,headers};
    };
  }
  calls(scanId: string, workspaceId: string): CallSummary[] {
    return (this.db.prepare('SELECT model,http,latency_ms,cost_micro_usd FROM calls WHERE operation_id=? AND workspace_id=? ORDER BY rowid').all(scanId,workspaceId) as {model:string;http:number;latency_ms:number;cost_micro_usd:number}[]).map(r=>({model:r.model,http:Number(r.http),latencyMs:Number(r.latency_ms),source:'live',costMicroUsd:Number(r.cost_micro_usd)}));
  }
  receipt(scanId: string, workspaceId: string, result: ScanOk): string {
    const calls = this.calls(scanId,workspaceId);
    if (!calls.some(c=>c.model==='muse-spark-1.3' && c.http>=200 && c.http<300)) throw new Error('No verified Spark response');
    const cards: ReceiptCard[] = result.cards.map(c=>{
      const digest = imageHash(c.cutout);
      if (!digest) throw new Error('Cut-out could not be bound to the scan');
      if (c.cutoutKind === 'mask' && !calls.some(call=>call.model===SAM_MODEL && call.http>=200 && call.http<300)) throw new Error('No verified SAM response');
      return {cardId:String(c.cardId),imageHash:digest,cutoutSource:c.cutoutKind==='mask'?'sam-mask':'box-crop',type:c.type,color:c.maskColor??c.sparkColor,allowedColors:[...new Set([c.maskColor??c.sparkColor,...(c.colorChoices??[])])],formality:c.formality};
    });
    this.db.prepare('INSERT INTO rail_scan_receipts VALUES (?,?,?,?,?)').run(scanId,workspaceId,JSON.stringify(cards),'live',new Date().toISOString());
    return scanId;
  }
  /** Canonical classification comes from the account's stored result, not the UI silhouette. */
  resolveItem(workspaceId: string, piece: GarmentPiece): {type:GarmentType;color:ColorFamily;formality:Formality} | null {
    const claim = piece as ClaimedPiece;
    if (claim.scanMode !== 'live' || !claim.scanReceiptId || !claim.scanCardId) return null;
    this.validatePieces(workspaceId,[piece],[]);
    const row=this.db.prepare("SELECT cards_json FROM rail_scan_receipts WHERE receipt_id=? AND workspace_id=? AND source='live'").get(claim.scanReceiptId,workspaceId) as {cards_json:string}|undefined;
    const card=row ? (JSON.parse(row.cards_json) as ReceiptCard[]).find(c=>c.cardId===claim.scanCardId) : undefined;
    if (!card || !isGarmentType(card.type) || !isColorFamily(card.color) || !(FORMALITY_LEVELS as readonly string[]).includes(card.formality)) throw new InvalidWardrobe('This scan classification is not supported. Scan the photo again.');
    return {type:card.type,color:claim.scanColor as ColorFamily ?? card.color,formality:card.formality};
  }
  validatePieces(workspaceId: string, pieces: GarmentPiece[], previousPieces: GarmentPiece[]) {
    const previous = new Map(previousPieces.map(p=>[p.id,p as ClaimedPiece]));
    const seen = new Set<string>();
    for (const piece0 of pieces) {
      const piece = piece0 as ClaimedPiece;
      if (piece.scanMode !== 'live') {
        if (piece.scanReceiptId || piece.scanCardId || piece.scanColor !== undefined) throw new InvalidWardrobe('A scan receipt can only describe its original live scan.');
        continue;
      }
      const old = previous.get(piece.id);
      if (!piece.scanReceiptId && !piece.scanCardId && old?.scanMode==='live' && !old.scanReceiptId &&
        old.imageUrl===piece.imageUrl && old.frontImageUrl===piece.frontImageUrl && old.cutoutSource===piece.cutoutSource && piece.scanColor===old.scanColor) continue;
      const claimKey = `${piece.scanReceiptId}:${piece.scanCardId}`;
      if (seen.has(claimKey)) throw new InvalidWardrobe('A scanned garment can only appear once in this wardrobe.');
      seen.add(claimKey);
      const row = piece.scanReceiptId ? this.db.prepare("SELECT cards_json FROM rail_scan_receipts WHERE receipt_id=? AND workspace_id=? AND source='live'").get(piece.scanReceiptId,workspaceId) as {cards_json:string}|undefined : undefined;
      const card = row ? (JSON.parse(row.cards_json) as ReceiptCard[]).find(c=>c.cardId===piece.scanCardId) : undefined;
      if (!card || card.cutoutSource !== piece.cutoutSource || imageHash(piece.imageUrl)!==card.imageHash ||
        (piece.frontImageUrl !== undefined && imageHash(piece.frontImageUrl)!==card.imageHash)) {
        throw new InvalidWardrobe('This photo has no matching Meta scan receipt for this account. Scan it again or add it as a manual photo.');
      }
      const allowedColors = card.allowedColors ?? [card.color];
      if (piece.scanColor !== undefined && (!isColorFamily(piece.scanColor) || !allowedColors.includes(piece.scanColor))) {
        throw new InvalidWardrobe('Choose one of the colors returned by this scan.');
      }
    }
  }
}
