// Feature 5 — keep or let go. One question per piece, written the way an event market writes a
// contract: "Will I wear J2 in the next 90 days?" with a date it resolves on. The two sides of the
// screen show counted facts only. Closer never puts a probability on either side: there is no
// counted basis for one, and a number without a basis would be read as advice. The owner takes a
// position (keep, wear it once, prepare to sell, decide later); the position is saved as a snapshot
// of what was on the screen and is resolved later by counted wear records, never by the app.
import { createHash } from 'node:crypto';
import { addDays, diffDays, type IsoDate } from '../shared/dates.ts';
import type { WearRow } from '../shared/ledger.ts';
import type { Item } from '../shared/wardrobe.ts';
import type { ReviewRow } from './review.ts';
import { PLATFORM_INFO, PLATFORMS, netScenario, type Currency, type Evidence, type FeeLine, type NetScenario, type Platform } from './market.ts';

export const DECISION_CHOICES = ['KEEP', 'WEAR_ONCE', 'SELL_PREPARE', 'DEFER'] as const;
export type DecisionChoice = (typeof DECISION_CHOICES)[number];
export const CHOICE_LABEL: Record<DecisionChoice, string> = {
  KEEP: 'Keep', WEAR_ONCE: 'Try wearing it once', SELL_PREPARE: 'Prepare to sell', DEFER: 'Decide later',
};
export const HORIZON_DAYS = [30, 60, 90] as const;
export type HorizonDays = (typeof HORIZON_DAYS)[number];
export const DEFAULT_HORIZON: HorizonDays = 90;
export const MAX_NAMED_USES = 5;
/** Bump when the arithmetic behind a snapshot changes, so old snapshots stay readable as what they were. */
export const CALCULATOR_VERSION = 'closer.decision.1';

export type NamedUse = { label: string; on: IsoDate | null };

export type KeepSide = {
  question: string;
  horizonDays: HorizonDays;
  resolvesOn: IsoDate;
  /** Look-back window of the same length as the horizon. */
  windowDays: number;
  windowStart: IsoDate;
  trackedDays: number;
  recordedDays: number;
  unrecordedDays: number;
  wearsCounted: number;
  lastConfirmedWear: IsoDate | null;
  daysSinceLastWear: number | null;
  namedUses: NamedUse[];
  /** Always null here: Closer has no counted basis for a forward-looking number. */
  wearOutlook: { value: null; status: 'NOT_COMPUTED'; line: string };
  missing: string[];
  basis: string;
};

export type PriceGroup = { count: number; min: number | null; max: number | null; ids: string[] };
/** Owner-entered prices and sample rows are counted apart and never pooled. */
export type EvidenceSummary = { platform: Platform; name: string; currency: Currency; owner: PriceGroup; sample: PriceGroup; latest: IsoDate | null; line: string };

export type SellSide = {
  platform: Platform;
  currency: Currency;
  askPrice: number | null;
  /** ASSUMED: a price the owner chose to look at, not a price anyone offered. */
  askStatus: 'NOT_SET' | 'ASSUMED';
  evidence: EvidenceSummary;
  scenario: NetScenario | null;
  missing: string[];
  calculatorVersion: string;
};

export type DecisionSnapshot = {
  schema: 'closer.decision.1';
  decisionId: string;
  itemId: string;
  choice: DecisionChoice;
  at: string;
  today: IsoDate;
  keep: KeepSide;
  sell: SellSide;
  /** Fingerprint of the counted facts on the screen when the position was taken (basisOf). */
  basis: string;
  note: string | null;
  sourceRevision: string;
};

export type Recheck = { needed: boolean; changed: string[] };

export type Outcome = {
  status: 'OPEN' | 'CLOSED';
  daysElapsed: number;
  daysTotal: number;
  wearsSince: number;
  recordedDaysSince: number;
  line: string;
};

export function isHorizon(n: unknown): n is HorizonDays {
  return typeof n === 'number' && (HORIZON_DAYS as readonly number[]).includes(n);
}

export function itemLabel(item: Pick<Item, 'itemId' | 'type' | 'color'>): string {
  return `${item.itemId} (${item.color !== 'unknown' ? `${item.color} ` : ''}${item.type})`;
}

/** The keep side is read off a review row computed with windowDays = horizon. */
export function keepSideOf(item: Pick<Item, 'itemId' | 'type' | 'color'>, row: ReviewRow, horizonDays: HorizonDays, namedUses: readonly NamedUse[], today: IsoDate): KeepSide {
  const resolvesOn = addDays(today, horizonDays);
  const daysSinceLastWear = row.lastConfirmedWear ? diffDays(today, row.lastConfirmedWear) : null;
  const missing: string[] = [];
  if (row.trackedDays < row.windowDays) missing.push(`Tracked for ${row.trackedDays} of the last ${row.windowDays} days`);
  if (row.unrecordedDays > 0) missing.push(`No record of any kind on ${row.unrecordedDays} of ${row.trackedDays} tracked days: those days are unknown`);
  if (row.seasonHint) missing.push(row.seasonHint);
  if (namedUses.length === 0) missing.push('No upcoming use named yet');
  return {
    question: `Will I wear ${itemLabel(item)} in the next ${horizonDays} days, by ${resolvesOn}?`,
    horizonDays, resolvesOn,
    windowDays: row.windowDays, windowStart: row.windowStart, trackedDays: row.trackedDays, recordedDays: row.recordedDays, unrecordedDays: row.unrecordedDays,
    wearsCounted: row.wearsInWindow, lastConfirmedWear: row.lastConfirmedWear, daysSinceLastWear,
    namedUses: [...namedUses],
    wearOutlook: {
      value: null, status: 'NOT_COMPUTED',
      line: `Not computed. Closer would put a number here only from counted wears of this piece over enough observed days, and there is no counted basis for the next ${horizonDays} days. 0 wears on record is a count, not a chance of zero.`,
    },
    missing,
    basis: `Counted from confirmed wear records: ${row.wearsInWindow} wears in the last ${row.windowDays} days, with any record on ${row.recordedDays} of ${row.trackedDays} tracked days.`,
  };
}

function group(rows: readonly Evidence[]): PriceGroup {
  const amounts = rows.map((e) => e.amount);
  return { count: rows.length, min: rows.length ? Math.min(...amounts) : null, max: rows.length ? Math.max(...amounts) : null, ids: rows.map((e) => e.evidenceId) };
}

export function evidenceSummaryOf(itemId: string, platform: Platform, evidence: readonly Evidence[]): EvidenceSummary {
  const mine = evidence.filter((e) => e.itemId === itemId && e.platform === platform);
  const owner = group(mine.filter((e) => e.source === 'owner_entered'));
  const sample = group(mine.filter((e) => e.source === 'sample'));
  const latest = mine.reduce<IsoDate | null>((m, e) => (!m || e.retrievedAt > m ? e.retrievedAt : m), null);
  const info = PLATFORM_INFO[platform];
  const parts: string[] = [];
  if (owner.count) parts.push(`${owner.count} price${owner.count > 1 ? 's' : ''} you entered`);
  if (sample.count) parts.push(`${sample.count} sample price${sample.count > 1 ? 's' : ''}`);
  const line = parts.length ? `${parts.join(' and ')} seen on ${info.name}; asking prices are not sales.` : `No price seen on ${info.name} yet.`;
  return { platform, name: info.name, currency: info.currency, owner, sample, latest, line };
}

export function evidenceSummaries(itemId: string, evidence: readonly Evidence[]): EvidenceSummary[] {
  return PLATFORMS.map((p) => evidenceSummaryOf(itemId, p, evidence));
}

export function sellSideOf(itemId: string, platform: Platform, askPrice: number | null, fees: readonly FeeLine[], evidence: readonly Evidence[]): SellSide {
  const currency = PLATFORM_INFO[platform].currency;
  const summary = evidenceSummaryOf(itemId, platform, evidence);
  const scenario = askPrice !== null && askPrice > 0 ? netScenario(askPrice, currency, fees) : null;
  const missing: string[] = [];
  if (scenario === null) missing.push('No asking price chosen');
  if (summary.owner.count + summary.sample.count === 0) missing.push(`No price seen on ${summary.name}`);
  if (scenario?.costStatus === 'NO_LINES') missing.push('No cost line checked');
  if (scenario?.costStatus === 'UNKNOWN') missing.push(`Costs not checked: ${scenario.unknown.join(', ')}`);
  return { platform, currency, askPrice: scenario ? askPrice : null, askStatus: scenario ? 'ASSUMED' : 'NOT_SET', evidence: summary, scenario, missing, calculatorVersion: CALCULATOR_VERSION };
}

/** Wears of the piece recorded after the decision, up to today or the resolution date, whichever is first. */
export function outcomeOf(d: Pick<DecisionSnapshot, 'itemId' | 'today' | 'keep'>, wearRows: readonly WearRow[], today: IsoDate): Outcome {
  const from = d.today;
  const until = d.keep.resolvesOn;
  const end = today < until ? today : until;
  const daysTotal = d.keep.horizonDays;
  const daysElapsed = Math.max(0, Math.min(daysTotal, diffDays(end, from)));
  const inSpan = (date: IsoDate) => date > from && date <= end;
  const wearsSince = wearRows.filter((w) => w.itemIds.includes(d.itemId) && inSpan(w.occurredAt)).length;
  const recordedDaysSince = new Set(wearRows.filter((w) => inSpan(w.occurredAt)).map((w) => w.occurredAt)).size;
  const status: Outcome['status'] = today >= until ? 'CLOSED' : 'OPEN';
  const line = status === 'OPEN'
    ? `Open: ${wearsSince} confirmed wear${wearsSince === 1 ? '' : 's'} since the decision, ${daysElapsed} of ${daysTotal} days passed, any record on ${recordedDaysSince} of them.`
    : `Closed on ${until}: ${wearsSince} confirmed wear${wearsSince === 1 ? '' : 's'} in the ${daysTotal} days after the decision, any record on ${recordedDaysSince} of them. Days without a record stay unknown.`;
  return { status, daysElapsed, daysTotal, wearsSince, recordedDaysSince, line };
}

/**
 * A stable fingerprint (sha256) of the counted facts a position rests on: the wear counts of the
 * keep side, the evidence ids on the chosen platform, the asking price and the cost lines as typed.
 * Two requests with the same basis were taken on the same facts; a different basis means the facts
 * on the screen had moved in between.
 */
export function basisOf(keep: KeepSide, sell: SellSide): string {
  const facts = {
    wearsCounted: keep.wearsCounted,
    recordedDays: keep.recordedDays,
    trackedDays: keep.trackedDays,
    lastConfirmedWear: keep.lastConfirmedWear,
    evidenceIds: [...sell.evidence.owner.ids, ...sell.evidence.sample.ids].sort(),
    platform: sell.platform,
    askPrice: sell.askPrice,
    costs: (sell.scenario?.costs ?? []).map((c) => ({ label: c.label, kind: c.kind, value: c.value })),
  };
  return createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex');
}

/**
 * Which counted facts under a saved position have moved since, in plain words ("2 more confirmed
 * wears", "1 new price on KREAM", "tracked days 76 → 90"). The keep side passed in must be computed
 * for the snapshot's own horizon, and the evidence for its own platform. Nothing here judges the
 * position: it only lists what is different now.
 */
export function recheckOf(snapshot: Pick<DecisionSnapshot, 'keep' | 'sell'>, currentKeep: KeepSide, currentEvidence: EvidenceSummary): Recheck {
  const then = snapshot.keep;
  const changed: string[] = [];
  const dWears = currentKeep.wearsCounted - then.wearsCounted;
  if (dWears !== 0) changed.push(`${Math.abs(dWears)} ${dWears > 0 ? 'more' : 'fewer'} confirmed wear${Math.abs(dWears) === 1 ? '' : 's'}`);
  if (currentKeep.lastConfirmedWear !== then.lastConfirmedWear) changed.push(`last confirmed wear ${then.lastConfirmedWear ?? 'none'} → ${currentKeep.lastConfirmedWear ?? 'none'}`);
  if (currentKeep.recordedDays !== then.recordedDays) changed.push(`recorded days ${then.recordedDays} → ${currentKeep.recordedDays}`);
  if (currentKeep.trackedDays !== then.trackedDays) changed.push(`tracked days ${then.trackedDays} → ${currentKeep.trackedDays}`);
  const platform = snapshot.sell.platform;
  const before = new Set([...snapshot.sell.evidence.owner.ids, ...snapshot.sell.evidence.sample.ids]);
  const now = new Set([...currentEvidence.owner.ids, ...currentEvidence.sample.ids]);
  const added = [...now].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !now.has(id)).length;
  if (added) changed.push(`${added} new price${added === 1 ? '' : 's'} on ${platform}`);
  if (removed) changed.push(`${removed} price${removed === 1 ? '' : 's'} removed on ${platform}`);
  return { needed: changed.length > 0, changed };
}

export function validateNamedUses(x: unknown, today: IsoDate): NamedUse[] | string {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) return 'namedUses must be a list';
  if (x.length > MAX_NAMED_USES) return `up to ${MAX_NAMED_USES} named uses`;
  const out: NamedUse[] = [];
  for (const u of x as Partial<NamedUse>[]) {
    const label = String(u?.label ?? '').trim().slice(0, 40);
    if (!label) return 'every named use needs a few words';
    const on = u?.on === null || u?.on === undefined || u.on === '' ? null : String(u.on);
    if (on !== null && !/^\d{4}-\d{2}-\d{2}$/.test(on)) return `${label}: date must be YYYY-MM-DD or blank`;
    if (on !== null && on < today) return `${label}: ${on} is in the past`;
    out.push({ label, on });
  }
  return out;
}
