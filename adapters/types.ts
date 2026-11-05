// 실호출 기록: docs/live/live_check.json (2026-11-05, 1회) — 그 기록 밖의 응답 형태는 문서 예시 기반
// Ports the engine uses. Real and mock share the same request builders and parsers; only the
// transport differs (adapters/transport.ts real, adapters/mock/transport.ts mock).
import type { ReasonCode } from '../shared/reasons.ts';
import type { CallRow } from '../shared/ledger.ts';
import type { Offender, Direction } from '../shared/wardrobe.ts';
import type { SamRecord, Spark2Raw } from '../engine/validate.ts';
import type { SolverInput } from '../engine/solver.ts';
import type { Fact } from '../engine/facts.ts';

export type CallDraft = Omit<CallRow, 'operationId' | 'workspaceId' | 'sessionId'>;

export type PortResult<T> =
  /** notes: parser diagnostics worth a line in the call panel (live SAM); never model text. */
  | { ok: true; value: T; calls: CallDraft[]; notes?: string[] }
  | { ok: false; http: number; code: ReasonCode; detail: string; calls: CallDraft[] };

export type Spark1Request = { imageUrl: string; sentence: string; scan?: boolean };
export type SamRequest = { imageUrl: string; prompt: string };

/** Facts code sends to Spark 2: candidate IDs per slot, fact IDs, item facts. No free text from visitors. */
export type Spark2Facts = {
  solver: SolverInput;
  factIds: string[];
  factLines: Fact[];
  items: { itemId: string; slot: string; type: string; color: string; formality: string; availability: string; lastWorn: string | null }[];
  pinned: string[];
  offenders: Offender[];
  direction: Direction;
};

export type Spark2Request = {
  facts: Spark2Facts;
  /** Mask-cut thumbnails (long side 256 px). Not produced in this build (see docs/status.md). */
  thumbnails: { itemId: string; imageUrl: string }[];
  /** Correction call: the rejection reasons go into a fresh input (no previous_response_id). */
  correction: { rejectedCodes: ReasonCode[]; detail: string } | null;
};

export interface Spark1Port {
  perceive(req: Spark1Request): Promise<PortResult<unknown>>;
}
export interface SamPort {
  segment(req: SamRequest): Promise<PortResult<SamRecord[]>>;
}
export interface Spark2Port {
  propose(req: Spark2Request): Promise<PortResult<Spark2Raw>>;
}

export type Ports = { spark1: Spark1Port; sam: SamPort; spark2: Spark2Port; intent: import('./intent.ts').IntentPort; wonder: import('./wonder.ts').WonderPort };
