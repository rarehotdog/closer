// States — plan v2 §4-1. Two axes are kept apart: item availability and the daily decision (plan).

/** 옷 등록: CANDIDATE → CONFIRMED (human) or REJECTED. */
export const OWNERSHIP_STATES = ['CANDIDATE', 'CONFIRMED', 'REJECTED'] as const;
export type Ownership = (typeof OWNERSHIP_STATES)[number];

/** 옷 가용. Changed by buttons only, never from a photo. */
export const AVAILABILITY_STATES = ['AVAILABLE', 'LAUNDRY', 'REPAIR', 'STORED'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** 하루 결정 (plan). */
export const PLAN_STATES = ['DRAFT', 'PROPOSED', 'LOCKED', 'WORN', 'HOLD', 'NEEDS_REPLAN', 'CANCELLED'] as const;
export type PlanState = (typeof PLAN_STATES)[number];
/** The "없음" (no plan yet) origin of transition #1. */
export type PlanOrigin = 'NONE';

/** 저장 결과. COMMITTED only when the fresh read-back matches what the screen shows. */
export const SAVE_RESULTS = ['COMMITTED', 'SAVE_UNCONFIRMED', 'READBACK_MISMATCH'] as const;
export type SaveResult = (typeof SAVE_RESULTS)[number];

export const ACTORS = ['human', 'system', 'demo_script'] as const;
export type Actor = (typeof ACTORS)[number];

export const WORKSPACE_KINDS = ['real', 'demo', 'visitor', 'rehearsal'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** Name mapping from an earlier draft's state list (§4-1 last line). */
export const LEGACY_NAME_MAP = {
  ARCHIVED: 'STORED',
  HOLD_CONFIRMATION: 'item-level ATTR_UNKNOWN flag (not a plan state)',
  DISPOSITION_CANDIDATE: 'reserved name only; no acceptance test',
} as const;
