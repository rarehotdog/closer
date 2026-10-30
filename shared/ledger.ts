// Ledger contract — plan v2 §3-6. One server DB; the store implements this contract.
import type { ReasonCode } from './reasons.ts';
import type { Actor, AvailabilityState, PlanState, WorkspaceKind } from './states.ts';
import type { IsoDate } from './dates.ts';
import type { DecisionContext, Item, Outfit } from './wardrobe.ts';

/** Tables whose rows are inside stateHash (§3-6 "stateHash 안 = 예"). */
export const STATE_HASH_TABLES = ['events', 'items', 'availability', 'plans', 'wear_rows'] as const;
/** Tables outside stateHash (run records, call ledger, flags, workspace metadata). */
export const OUTSIDE_STATE_HASH_TABLES = ['workspaces', 'operations', 'calls', 'flags'] as const;

/** Write path check order (§3-6). Model calls are never inside the transaction. */
export const WRITE_CHECK_ORDER = [
  '1 eventId + payloadHash (idempotent replay / EVENT_CONFLICT)',
  '2 expectedRevision (STALE_STATE)',
  '3 transition conditions incl. actor (INVALID_TRANSITION, ALREADY_WORN, ...)',
  '4 commit',
  '5 re-read in a new read transaction and compare with the screen value (client side)',
] as const;

export const EVENT_KINDS = [
  'REGISTRATION_CONFIRMED',
  'PLAN_LOCKED',
  'PLAN_UNLOCKED',
  'PLAN_CANCELLED',
  'AVAILABILITY_CHANGED',
  'WEAR_CONFIRMED',
  'WEAR_UNDONE',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type WorkspaceRow = {
  workspaceId: string;
  kind: WorkspaceKind;
  publicReadOnly: boolean;
  seedRef: string | null;
  ledgerRevision: number;
  createdOn: IsoDate;
};

export type EventRow = {
  eventId: string;
  payloadHash: string;
  kind: EventKind;
  actor: Actor;
  workspaceId: string;
  ledgerRevision: number;
  occurredAt: IsoDate;
  recordedAt: string;
  correctsEventId: string | null;
  payload: unknown;
};

export type ItemRow = Item;

export type AvailabilityRow = { itemId: string; state: AvailabilityState; since: IsoDate };

export type PlanRow = {
  planId: string;
  occasionDate: IsoDate;
  state: PlanState;
  slots: Outfit;
  pinned: string[];
  context: DecisionContext;
  baseRevision: number;
};

export type WearRow = { eventId: string; planId: string | null; itemIds: string[]; occurredAt: IsoDate };

export type CallSource = 'live' | 'cached' | 'mock';

export type CallRow = {
  callId: string;
  operationId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  model: string;
  http: number;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
  /** Actual billed estimate in micro-USD (0 for mock). */
  costMicroUsd: number;
  /** What the same call would cost live, from the plan's §3-4 estimates (display only). */
  estLiveCostMicroUsd: number;
  source: CallSource;
  createdAt: string;
};

export type FlagsRow = {
  /** CLOSER_KILL: model calls off; TTL 10 minutes from setAt. */
  kill: { on: boolean; setAt: string | null; ttlMs: number };
  caps: { appTotalMicroUsd: number; visitorDayMicroUsd: number; sessionMicroUsd: number; visitorZeroFrom: string };
};

/** Everything inside stateHash for one workspace. */
export type LedgerState = {
  workspaceId: string;
  revision: number;
  events: EventRow[];
  items: ItemRow[];
  availability: AvailabilityRow[];
  plans: PlanRow[];
  wearRows: WearRow[];
};

export type EventInput = {
  eventId: string;
  kind: EventKind;
  actor: Actor;
  occurredAt: IsoDate;
  correctsEventId: string | null;
  payload: unknown;
};

export type WriteRequest = {
  workspaceId: string;
  expectedRevision: number;
  events: EventInput[];
};

export type Mutation =
  | { op: 'putItem'; item: ItemRow }
  | { op: 'putAvailability'; row: AvailabilityRow }
  | { op: 'putPlan'; plan: PlanRow }
  | { op: 'insertWear'; row: WearRow }
  | { op: 'deleteWear'; eventId: string };

/** Result of check ③, computed inside the write transaction from the current state. */
export type Decision =
  | { ok: true; mutations: Mutation[]; result?: unknown }
  | { ok: false; code: ReasonCode; detail: string };

export type WriteResponse =
  | { ok: true; workspaceId: string; eventIds: string[]; ledgerRevision: number; result: unknown }
  | { ok: false; code: ReasonCode; detail: string };
