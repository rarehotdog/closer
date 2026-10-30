// Reason codes — plan v2 §4-3. 30 codes, names verbatim. A result carries an ARRAY of codes
// (one item can have two reasons, §4-3 last line).

/** 가용·제약 13 */
export const AVAILABILITY_CONSTRAINT_CODES = [
  'LAUNDRY',
  'REPAIR',
  'STORED',
  'WORN_RECENTLY', // soft: display only
  'FORMALITY_CONFLICT',
  'WEATHER_CONFLICT',
  'ATTR_UNKNOWN',
  'NO_VALID_COMBO',
  'PIN_CONFLICT',
  'NO_CHANGE',
  'UNREQUESTED_RELAXATION',
  'AMBIGUOUS_REFERENCE',
  'OUTSIDE_OFFENDERS',
] as const;

/** 모델·호출 10 */
export const MODEL_CALL_CODES = [
  'META_API_UNAVAILABLE',
  'META_REQUEST_REJECTED',
  'UNSUPPORTED_IMAGE',
  'INVALID_MODEL_OUTPUT',
  'META_DISABLED',
  'CALL_CAP_REACHED',
  'STALE_RESPONSE',
  'INJECTION_IGNORED',
  'NO_ACTION',
  'TOO_MANY_ITEMS',
] as const;

/** 원장 7 */
export const LEDGER_CODES = [
  'SAVE_UNCONFIRMED',
  'READBACK_MISMATCH',
  'ALREADY_WORN',
  'INVALID_TRANSITION',
  'STALE_STATE',
  'EVENT_CONFLICT',
  'SCOPE_DENIED',
] as const;

export const REASON_CODES = [...AVAILABILITY_CONSTRAINT_CODES, ...MODEL_CALL_CODES, ...LEDGER_CODES] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** Removed in v2 (§4-3 "뺀 것"). Must never be emitted. */
export const REMOVED_CODES = [
  'REVISION_CONFLICT',
  'MODEL_DISAGREED',
  'LOOP_CAP_REACHED',
  'LOOP_REPEATED',
  'ACCEPTANCE_FAILED',
  'PACKET_WITHOUT_CHECK',
  'CONSTRAINT_UNSUPPORTED',
  'COUNT_UNRESOLVED',
] as const;

/** Deferred to v1.1 (§4-3). */
export const DEFERRED_CODES = ['PERSON_IN_PHOTO'] as const;

const SET: ReadonlySet<string> = new Set(REASON_CODES);

export function isReasonCode(x: unknown): x is ReasonCode {
  return typeof x === 'string' && SET.has(x);
}

/** Unique, order-preserving merge of code arrays. */
export function mergeCodes(...lists: ReadonlyArray<ReadonlyArray<ReasonCode>>): ReasonCode[] {
  const out: ReasonCode[] = [];
  for (const list of lists) for (const c of list) if (!out.includes(c)) out.push(c);
  return out;
}
