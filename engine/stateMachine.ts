// State machine enforcing §4-2. Pure: no clock, no I/O.
import type { ReasonCode } from '../shared/reasons.ts';
import type { Actor, PlanOrigin, PlanState, WorkspaceKind } from '../shared/states.ts';
import { findTransition, type TransitionActor } from '../shared/transitions.ts';

export type TransitionCheck =
  | { ok: true; n: number; to: PlanState }
  | { ok: false; code: ReasonCode; detail: string };

/**
 * Actor rule. System rows accept only 'system'. Human rows accept 'human'; 'demo_script' is
 * accepted only in a rehearsal workspace (§4-2 note, applied to every human row).
 */
export function actorAllowed(rowActor: TransitionActor, actor: Actor, kind: WorkspaceKind): boolean {
  if (rowActor === 'system') return actor === 'system';
  if (actor === 'human') return true;
  return actor === 'demo_script' && kind === 'rehearsal';
}

export function checkTransition(
  from: PlanState | PlanOrigin,
  to: PlanState,
  actor: Actor,
  kind: WorkspaceKind,
): TransitionCheck {
  if (from === 'WORN' && to === 'WORN') {
    return { ok: false, code: 'ALREADY_WORN', detail: 'this plan already has a confirmed wear' };
  }
  const t = findTransition(from, to);
  if (!t) return { ok: false, code: 'INVALID_TRANSITION', detail: `${from} → ${to} is not in the §4-2 table` };
  if (!actorAllowed(t.actor, actor, kind)) {
    return { ok: false, code: 'INVALID_TRANSITION', detail: `row ${t.n} needs actor ${t.actor}; got ${actor} in a ${kind} workspace` };
  }
  return { ok: true, n: t.n, to };
}

/** Registration confirm and ledger rows 12·13 are human actions outside the plan-state table. */
export function checkHumanAction(actor: Actor, kind: WorkspaceKind, what: string): TransitionCheck | null {
  if (actorAllowed('human', actor, kind)) return null;
  return { ok: false, code: 'INVALID_TRANSITION', detail: `${what} needs actor human; got ${actor} in a ${kind} workspace` };
}

/** HOLD must carry at least one reason code. Row 3's list plus model-call failures (§3-3 Spark 1 row). */
export const HOLD_REASONS: readonly ReasonCode[] = [
  'ATTR_UNKNOWN', 'PIN_CONFLICT', 'NO_VALID_COMBO', 'AMBIGUOUS_REFERENCE',
  'META_API_UNAVAILABLE', 'META_DISABLED', 'CALL_CAP_REACHED',
  'INVALID_MODEL_OUTPUT', 'META_REQUEST_REJECTED', 'UNSUPPORTED_IMAGE', 'TOO_MANY_ITEMS', 'NO_ACTION',
  'NO_CHANGE', 'UNREQUESTED_RELAXATION', 'OUTSIDE_OFFENDERS', 'FORMALITY_CONFLICT', 'WEATHER_CONFLICT',
  'LAUNDRY', 'REPAIR', 'STORED',
];

export function holdCodesValid(codes: readonly ReasonCode[]): boolean {
  return codes.length > 0 && codes.some((c) => HOLD_REASONS.includes(c));
}
