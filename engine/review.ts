// Feature 2a — the 60-day review. "No confirmed wear in the window" is not proof that an item went unused:
// days without any record are a gap in observation. The window is the owner's choice (default 60
// days, not a proven disposal rule). Nothing here sells, lists or donates anything.
import { addDays, diffDays, type IsoDate } from '../shared/dates.ts';
import type { AvailabilityState } from '../shared/states.ts';
import type { Item } from '../shared/wardrobe.ts';
import type { WearRow } from '../shared/ledger.ts';

export const DEFAULT_WINDOW_DAYS = 60;
export const MIN_WINDOW_DAYS = 14;
export const MAX_WINDOW_DAYS = 365;
/** A window counts as observed when at least this share of its days has any wear record [가정]. */
export const MIN_RECORDED_SHARE = 0.5;

export const REVIEW_STATUSES = ['CANDIDATE', 'RECENT_WEAR', 'TOO_NEW', 'LOW_RECORDS', 'EXEMPT'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Next steps shown side by side; none of them is a default and none acts outside the app. */
export const REVIEW_ACTIONS = ['restyle', 'keep', 'repair_check', 'sell_review', 'donate_review'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const EXEMPT_REASONS = ['season', 'occasion', 'sentimental', 'stored', 'other'] as const;
export type ExemptReason = (typeof EXEMPT_REASONS)[number];
export type Exemption = { reason: ExemptReason; reviewAfter: IsoDate; note: string | null };

export type ReviewRow = {
  itemId: string;
  status: ReviewStatus;
  windowDays: number;
  windowStart: IsoDate;
  /** First day this item could have a wear record (registration day). */
  trackedSince: IsoDate;
  /** Days of the window that fall after trackedSince. */
  trackedDays: number;
  /** Days of the tracked window with any wear record in this workspace (any item). */
  recordedDays: number;
  unrecordedDays: number;
  wearsInWindow: number;
  lastConfirmedWear: IsoDate | null;
  source: 'confirmed wear records';
  seasonHint: string | null;
  exemption: Exemption | null;
  line: string;
};

export type ReviewInput = {
  items: readonly Item[];
  wearRows: readonly WearRow[];
  availability: ReadonlyMap<string, AvailabilityState>;
  /** Registration day per item; items without one use the workspace creation day. */
  registeredOn: ReadonlyMap<string, IsoDate>;
  workspaceCreatedOn: IsoDate;
  exemptions: ReadonlyMap<string, Exemption>;
  today: IsoDate;
  windowDays?: number;
};

export function clampWindow(days: number | undefined): number {
  const d = Math.round(Number(days ?? DEFAULT_WINDOW_DAYS));
  if (!Number.isFinite(d)) return DEFAULT_WINDOW_DAYS;
  return Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, d));
}

/** Cold-weather pieces in the warm months may simply be out of season [가정: northern hemisphere]. */
function seasonHintOf(item: Item, today: IsoDate): string | null {
  const month = Number(today.slice(5, 7));
  if ((item.type === 'coat') && month >= 5 && month <= 9) return 'Coat in the warm months: it may be out of season';
  if ((item.type === 'shorts') && (month <= 3 || month >= 11)) return 'Shorts in the cold months: they may be out of season';
  return null;
}

export function reviewWardrobe(inp: ReviewInput): ReviewRow[] {
  const windowDays = clampWindow(inp.windowDays);
  const windowStart = addDays(inp.today, -(windowDays - 1));
  const recordedDates = new Set(inp.wearRows.map((w) => w.occurredAt));
  const rows: ReviewRow[] = [];
  for (const it of [...inp.items].filter((x) => x.ownership === 'CONFIRMED').sort((a, b) => (a.itemId < b.itemId ? -1 : 1))) {
    const reg = inp.registeredOn.get(it.itemId) ?? inp.workspaceCreatedOn;
    const trackedSince = reg > windowStart ? reg : windowStart;
    const trackedDays = Math.max(0, diffDays(inp.today, trackedSince) + 1);
    let recordedDays = 0;
    for (let d = trackedSince; d <= inp.today; d = addDays(d, 1)) if (recordedDates.has(d)) recordedDays++;
    const wears = inp.wearRows.filter((w) => w.itemIds.includes(it.itemId));
    const lastConfirmedWear = wears.reduce<IsoDate | null>((m, w) => (!m || w.occurredAt > m ? w.occurredAt : m), null);
    const wearsInWindow = wears.filter((w) => w.occurredAt >= windowStart && w.occurredAt <= inp.today).length;
    const ex = inp.exemptions.get(it.itemId) ?? null;
    const stored = (inp.availability.get(it.itemId) ?? 'AVAILABLE') === 'STORED';
    const exemption: Exemption | null = ex && ex.reviewAfter > inp.today ? ex : stored ? { reason: 'stored', reviewAfter: inp.today, note: 'Marked as stored' } : null;
    const base = {
      itemId: it.itemId, windowDays, windowStart, trackedSince, trackedDays, recordedDays,
      unrecordedDays: trackedDays - recordedDays, wearsInWindow, lastConfirmedWear,
      source: 'confirmed wear records' as const, seasonHint: seasonHintOf(it, inp.today), exemption,
    };
    let status: ReviewStatus;
    let line: string;
    if (exemption) {
      status = 'EXEMPT';
      line = exemption.reason === 'stored' ? 'Stored: left out of the review' : `Kept (${exemption.reason}) until ${exemption.reviewAfter}`;
    } else if (wearsInWindow > 0) {
      status = 'RECENT_WEAR';
      line = `Confirmed wear on ${lastConfirmedWear} (${wearsInWindow} in the last ${windowDays} days)`;
    } else if (trackedDays < windowDays) {
      status = 'TOO_NEW';
      line = `Too few records: tracked for ${trackedDays} of ${windowDays} days`;
    } else if (recordedDays < Math.ceil(windowDays * MIN_RECORDED_SHARE)) {
      status = 'LOW_RECORDS';
      line = `Too few records: any wear was recorded on ${recordedDays} of ${windowDays} days`;
    } else {
      status = 'CANDIDATE';
      line = `No confirmed wear in the last ${windowDays} days (wears recorded on ${recordedDays} of ${windowDays} days)`;
    }
    rows.push({ ...base, status, line });
  }
  return rows;
}
