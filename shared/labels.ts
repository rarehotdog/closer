// English on-screen strings. Status labels are produced only from result objects
// (a save label only after a matching read-back; a live chip only for live + callId + 2xx).
import type { Slot } from './wardrobe.ts';
import type { CallRow } from './ledger.ts';
import { mmdd, type IsoDate } from './dates.ts';

export const PRODUCT_NAME = 'Closer';
export const PRODUCT_NOUN = 'wardrobe assistant';
export const BUILD_CHIP = 'Built Oct 27–Nov 4 ET · muse-spark-1.3 · sam-3.1';

export const LABELS = {
  selectionSaved: 'Selection saved · read back ✓ · wear not confirmed yet',
  wearSaved: '+1 wear · read back ✓',
  alreadyRecorded: 'Already recorded',
  ledgerZeroUntilConfirm: 'Ledger: +0 until you confirm',
  sampleItem: 'Sample item',
  samplePhoto: 'Sample photo · code-drawn placeholder',
  demoScenario: 'Demo scenario',
  demoClockPlusOne: 'Demo clock +1 day',
  boxCropsOnly: 'Box crops only (no mask)',
  reasonByCode: 'Reason by code',
  replayAndLedger: 'Replay & ledger mode',
  noConfirmedWearYet: 'no confirmed wear yet',
  needsReplan: 'Needs re-plan',
  checkedByCode: 'Checked by code: owned · available · pinned item kept · only flagged slots changed',
  mockBanner: 'Mock mode · no Meta calls · sample data only',
  killBanner: 'Model calls off (K1) · button re-plans and read-back still work',
  readOnly: 'Read-only · writes return SCOPE_DENIED',
  notRecordedYet: 'No recorded run yet · this read-only page shows the sample wardrobe',
  uploadOff: 'Photo upload needs admin sign-in · off in mock mode',
  wearNotConfirmed: 'wear not confirmed yet',
} as const;

export function itemsReadBack(n: number): string {
  return `+${n} items · read back ✓`;
}
export function sampleWardrobe(n: number): string {
  return `Sample wardrobe · ${n} items seeded`;
}
export function wornRecord(itemId: string, date: IsoDate): string {
  return `${itemId} worn ${mmdd(date)} · your record`;
}
export function confirmedWearsSince(since: IsoDate, n: number): string {
  return `confirmed wears since ${mmdd(since)}: ${n}`;
}
export function changedOnly(slots: readonly Slot[], modelCalls: number): string {
  return `Changed: ${slots.join(' + ')} only · model calls: ${modelCalls}`;
}
export function keepTarget(itemIds: readonly string[]): string {
  return `keep: ${itemIds.join(', ')}`;
}
export function offendersChip(slots: readonly Slot[]): string {
  return `Spark: ${slots.join(', ')} feel off`;
}
export function livePerception(callsLeft: number): string {
  return `Live perception: on, ${callsLeft} calls left today`;
}
export function callPanel(c: Pick<CallRow, 'callId' | 'latencyMs' | 'costMicroUsd' | 'estLiveCostMicroUsd' | 'source' | 'model' | 'http'>): string {
  const usd = (m: number) => `$${(m / 1_000_000).toFixed(4)}`;
  const tail = c.source === 'mock' ? ` (mock · est. live ${usd(c.estLiveCostMicroUsd)})` : '';
  return `${c.callId} · ${c.model} · ${c.http} · ${c.latencyMs} ms · ${usd(c.costMicroUsd)}${tail}`;
}

// @result-object-start
/** The live chip exists only for a live call with a callId and a 2xx status (§5 note under the script). */
export function liveChip(c: Pick<CallRow, 'source' | 'callId' | 'http' | 'model' | 'latencyMs'>): string | null {
  if (c.source !== 'live' || !c.callId || c.http < 200 || c.http > 299) return null;
  return `LIVE · ${c.model} · ${c.latencyMs} ms · ${c.http}`;
}
// @result-object-end
