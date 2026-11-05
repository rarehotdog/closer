// Trimmed copy of closer adapters/types.ts at dba9ff3 (github.com/rarehotdog/closer): only what photo -> cards needs.
import type { ReasonCode } from '../shared/reasons.ts';
import type { CallRow } from '../shared/ledger.ts';
import type { SamRecord } from '../engine/validate.ts';

export type CallDraft = Omit<CallRow, 'operationId' | 'workspaceId' | 'sessionId'>;

export type PortResult<T> =
  | { ok: true; value: T; calls: CallDraft[]; notes?: string[] }
  | { ok: false; http: number; code: ReasonCode; detail: string; calls: CallDraft[] };

export type Spark1Request = { imageUrl: string; sentence: string };
export type SamRequest = { imageUrl: string; prompt: string };

export interface Spark1Port {
  perceive(req: Spark1Request): Promise<PortResult<unknown>>;
}
export interface SamPort {
  segment(req: SamRequest): Promise<PortResult<SamRecord[]>>;
}
