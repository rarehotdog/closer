// Transition table — plan v2 §4-2, rows 1–13. The engine's state machine enforces this table;
// a pair not listed here is rejected with INVALID_TRANSITION.
import type { ReasonCode } from './reasons.ts';
import type { PlanOrigin, PlanState } from './states.ts';

export type TransitionActor = 'system' | 'human';

export type PlanTransition = {
  n: number;
  from: PlanState | PlanOrigin | '*';
  to: PlanState;
  actor: TransitionActor;
  /** Condition text from the plan (Korean original kept in the comment column). */
  condition: string;
  /** Codes listed for this row (rejection or cause codes, per the plan's table). */
  codes: readonly ReasonCode[];
};

export const PLAN_TRANSITIONS: readonly PlanTransition[] = [
  { n: 1, from: 'NONE', to: 'DRAFT', actor: 'system', condition: 'photo+sentence received; operationId+generation issued', codes: [] },
  { n: 2, from: 'DRAFT', to: 'PROPOSED', actor: 'system', condition: 'Spark 2 options pass code checks; at most 2', codes: ['INVALID_MODEL_OUTPUT', 'NO_CHANGE', 'UNREQUESTED_RELAXATION', 'OUTSIDE_OFFENDERS'] },
  { n: 3, from: 'DRAFT', to: 'HOLD', actor: 'system', condition: 'decisive unknown, pin conflict, no substitute, model failure, cap', codes: ['ATTR_UNKNOWN', 'PIN_CONFLICT', 'NO_VALID_COMBO', 'AMBIGUOUS_REFERENCE', 'META_API_UNAVAILABLE', 'META_DISABLED', 'CALL_CAP_REACHED'] },
  { n: 4, from: 'HOLD', to: 'DRAFT', actor: 'human', condition: 'owner answer or retry tap', codes: [] },
  { n: 5, from: 'PROPOSED', to: 'LOCKED', actor: 'human', condition: 'owner picks; expectedRevision matches', codes: ['STALE_STATE', 'INVALID_TRANSITION'] },
  { n: 6, from: 'LOCKED', to: 'NEEDS_REPLAN', actor: 'system', condition: 'a locked item is no longer AVAILABLE', codes: ['LAUNDRY', 'REPAIR', 'STORED'] },
  { n: 7, from: 'NEEDS_REPLAN', to: 'PROPOSED', actor: 'system', condition: 're-plan only that slot', codes: ['NO_VALID_COMBO'] },
  { n: 8, from: 'LOCKED', to: 'WORN', actor: 'human', condition: 'wear tap; occurredAt <= today', codes: ['ALREADY_WORN'] },
  { n: 9, from: 'WORN', to: 'LOCKED', actor: 'human', condition: 'Undo: new event with correctsEventId', codes: [] },
  { n: 10, from: 'LOCKED', to: 'PROPOSED', actor: 'human', condition: 'unlock', codes: [] },
  { n: 11, from: '*', to: 'CANCELLED', actor: 'human', condition: 'owner cancels; responses arriving later are discarded', codes: ['STALE_RESPONSE'] },
];

/** Rows 12 and 13 are ledger actions that do not move a plan state. */
export const LEDGER_ACTIONS = [
  { n: 12, action: 'PAST_WEAR', actor: 'human', condition: 'allowed even if the item is LAUNDRY now; availability unchanged', codes: [] },
  { n: 13, action: 'AVAILABILITY_CHANGE', actor: 'human', condition: 'one button tap = one event', codes: [] },
] as const;

/**
 * §4-2 note: for rows 5·8·9·12 and registration confirm, actor≠human is INVALID_TRANSITION in
 * real·demo·visitor; only rehearsal accepts demo_script. This build applies the same rule to every
 * human row (4, 10, 11, 13 too) — the stricter reading (docs/status.md, deviations).
 */
export const ACTOR_STRICT_ROWS = [5, 8, 9, 12] as const;

export function findTransition(from: PlanState | PlanOrigin, to: PlanState): PlanTransition | null {
  for (const t of PLAN_TRANSITIONS) {
    if (t.to !== to) continue;
    if (t.from === from) return t;
    if (t.from === '*' && from !== 'CANCELLED' && from !== 'NONE') return t;
  }
  return null;
}
