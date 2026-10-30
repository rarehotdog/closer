// Client save flow (§3-6 step ⑤, AT-11, AT-14). A label appears only when a fresh read-back matches
// what the screen shows. If the commit response is lost: SAVE_UNCONFIRMED → look up the same
// eventId → found: success path; not found: resend with the SAME eventId (never a new one).
import type { LedgerState, WriteResponse } from './ledger.ts';
import type { ReasonCode } from './reasons.ts';
import type { SaveResult } from './states.ts';
import { LABELS } from './labels.ts';

export type SaveTransport = {
  /** Sends the write; may throw if the response is lost in transit. */
  write(): Promise<WriteResponse>;
  /** Looks up the stored response by eventId; null if the event does not exist. */
  lookup(): Promise<WriteResponse | null>;
  /** Fresh read (new read transaction). */
  readBack(): Promise<LedgerState>;
};

export type SaveOutcome = {
  result: SaveResult | ReasonCode;
  trail: string[];
  response: WriteResponse | null;
  label: string | null;
};

export async function saveWithReadBack(t: SaveTransport, matches: (s: LedgerState) => boolean, okLabel: string): Promise<SaveOutcome> {
  const trail: string[] = [];
  let resp: WriteResponse | null;
  try {
    resp = await t.write();
  } catch {
    trail.push('SAVE_UNCONFIRMED');
    resp = await t.lookup();
    if (resp) trail.push('FOUND_BY_EVENT_ID');
    else {
      trail.push('RESEND_SAME_EVENT_ID');
      resp = await t.write();
    }
  }
  if (!resp.ok) {
    trail.push(resp.code);
    return { result: resp.code, trail, response: resp, label: resp.code === 'ALREADY_WORN' ? LABELS.alreadyRecorded : null };
  }
  const s = await t.readBack();
  if (!matches(s)) {
    trail.push('READBACK_MISMATCH');
    return { result: 'READBACK_MISMATCH', trail, response: resp, label: null };
  }
  trail.push('COMMITTED');
  return { result: 'COMMITTED', trail, response: resp, label: okLabel };
}
