import {
  CurrencyCode,
  GarmentPiece,
  PriceObservation,
  ResalePlatform,
} from '../types/closet';
import {
  formatCurrency,
  isKeptAfterReload,
  KeepEvidence,
  SellEvidence,
  sortObservationsChronologically,
} from '../utils/ledgerLogic';

// Pure helpers behind the inspector panel. Everything here is counted from the piece's own
// records; nothing is estimated, averaged across platforms or converted between currencies.

// ---------------------------------------------------------------------------
// Status chips: Sample · scan source · Keep / Sell / Undecided
// ---------------------------------------------------------------------------

export type InspectorChipTone = 'sample' | 'source' | 'keep' | 'sell' | 'undecided';

export interface InspectorChip {
  id: 'sample' | 'source' | 'decision';
  label: string;
  tone: InspectorChipTone;
  title?: string;
}

/**
 * Where a scanned piece's cut-out came from, without a model version: the mask or box that
 * produced it, and whether the live Meta models or the local test fake answered. null for a
 * piece that did not come from a photo scan (no call happened for it).
 */
export function scanSourceLabel(garment: GarmentPiece): string | null {
  if (!garment.cutoutSource) return null;
  if (garment.scanMode === 'live' && !garment.scanReceiptId) return 'Prior scan · source unverified';
  const how = garment.cutoutSource === 'sam-mask' ? 'SAM mask' : 'Spark box';
  const mode = garment.scanMode === 'live' ? 'LIVE' : 'Test fake · no Meta call';
  return `${how} · ${mode}`;
}

export function decisionChipLabel(garment: GarmentPiece): 'Keep' | 'Sell' | 'Undecided' {
  if (garment.lastDecision?.choice === 'keep') return 'Keep';
  if (garment.lastDecision?.choice === 'sell') return 'Sell';
  return 'Undecided';
}

export function statusChips(garment: GarmentPiece): InspectorChip[] {
  const chips: InspectorChip[] = [];
  if (garment.isSample) {
    chips.push({
      id: 'sample',
      label: 'Sample (Excluded from Owned Total)',
      tone: 'sample',
      title: 'A sample piece: never added to the owned totals, and no decision is saved for it.',
    });
  }
  const source = scanSourceLabel(garment);
  if (source) {
    chips.push({
      id: 'source',
      label: source,
      tone: 'source',
      title: 'This piece came from a photo scan; the label names what produced its cut-out.',
    });
  }
  if (!garment.isSample) {
    const label = decisionChipLabel(garment);
    chips.push({
      id: 'decision',
      label,
      tone: label === 'Keep' ? 'keep' : label === 'Sell' ? 'sell' : 'undecided',
      title:
        label === 'Undecided'
          ? 'No decision saved for this piece yet.'
          : `Last saved decision: ${label}.`,
    });
  }
  return chips;
}

// ---------------------------------------------------------------------------
// Purchase info: only what the owner entered
// ---------------------------------------------------------------------------

export interface PurchaseLine {
  label: 'Paid' | 'When' | 'Where';
  value: string;
  entered: boolean;
}

/**
 * What the owner paid, when and where. A line with nothing entered reads "not entered"; it is
 * never filled from a file name, a sample or a price seen. The piece record keeps no purchase
 * date or place field yet, so those two lines stay "not entered" until there is one.
 */
export function purchaseLines(garment: GarmentPiece): PurchaseLine[] {
  const paid =
    typeof garment.purchasePrice === 'number' &&
    Number.isFinite(garment.purchasePrice) &&
    garment.purchasePrice > 0;
  return [
    {
      label: 'Paid',
      value: paid ? formatCurrency(garment.purchasePrice as number, garment.currency) : 'not entered',
      entered: paid,
    },
    { label: 'When', value: 'not entered', entered: false },
    { label: 'Where', value: 'not entered', entered: false },
  ];
}

// ---------------------------------------------------------------------------
// Wear record: "k wears · 60 days · last worn YYYY-MM-DD" or "No wear log"
// ---------------------------------------------------------------------------

export type WearRecordParts =
  | { kind: 'counted'; wearsText: string; rest: string }
  | { kind: 'no_log'; text: 'No wear log' };

export function wearRecordParts(
  keep: Pick<KeepEvidence, 'status' | 'wearsLast60Days' | 'lastWornDate'>,
): WearRecordParts {
  if (keep.status !== 'wear_log_counted' || keep.wearsLast60Days === null) {
    return { kind: 'no_log', text: 'No wear log' };
  }
  const n = keep.wearsLast60Days;
  const wearsText = `${n} ${n === 1 ? 'wear' : 'wears'}`;
  const lastWorn = keep.lastWornDate ? `last worn ${keep.lastWornDate}` : 'last worn date unknown';
  return { kind: 'counted', wearsText, rest: `· 60 days · ${lastWorn}` };
}

export function wearRecordLine(
  keep: Pick<KeepEvidence, 'status' | 'wearsLast60Days' | 'lastWornDate'>,
): string {
  const parts = wearRecordParts(keep);
  return parts.kind === 'counted' ? `${parts.wearsText} ${parts.rest}` : parts.text;
}

// ---------------------------------------------------------------------------
// Price seen: the latest record per platform, up to a few rows, never averaged
// ---------------------------------------------------------------------------

export interface LatestPlatformPrice {
  platform: ResalePlatform;
  price: number;
  currency: CurrencyCode;
  date: string;
  kind: 'traded' | 'listed';
  isSample: boolean;
  observationId: string;
}

export interface LatestPerPlatform {
  /** Newest first; one row per platform; at most `max` rows. */
  rows: LatestPlatformPrice[];
  /** Platforms with at least one price on record in the piece currency (rows may show fewer). */
  platformCount: number;
  /** Price records in the piece currency behind these rows. */
  recordCount: number;
}

export function latestPricePerPlatform(
  observations: PriceObservation[],
  currency: CurrencyCode,
  max = 3,
): LatestPerPlatform {
  const valid = observations.filter((o) => o.currency === currency && o.price > 0);
  const chrono = sortObservationsChronologically(valid);
  const seen = new Set<ResalePlatform>();
  const rows: LatestPlatformPrice[] = [];
  for (let i = chrono.length - 1; i >= 0; i -= 1) {
    const o = chrono[i];
    if (seen.has(o.platform)) continue;
    seen.add(o.platform);
    rows.push({
      platform: o.platform,
      price: o.price,
      currency: o.currency,
      date: o.date,
      kind: o.kind,
      isSample: o.isSample === true,
      observationId: o.id,
    });
  }
  return {
    rows: rows.slice(0, Math.max(0, max)),
    platformCount: seen.size,
    recordCount: valid.length,
  };
}

// ---------------------------------------------------------------------------
// Net if sold: only with every cost line ticked
// ---------------------------------------------------------------------------

export type NetIfSold =
  | { kind: 'no_price' }
  | { kind: 'fee_not_confirmed'; ask: number }
  | { kind: 'net'; ask: number; net: number };

export function netIfSold(
  askPrice: number | null,
  netPayoutInfo: SellEvidence['netPayoutInfo'],
): NetIfSold {
  if (askPrice === null || !Number.isFinite(askPrice) || askPrice <= 0) {
    return { kind: 'no_price' };
  }
  if (netPayoutInfo.status === 'confirmed' && netPayoutInfo.netPayout !== null) {
    return { kind: 'net', ask: askPrice, net: netPayoutInfo.netPayout };
  }
  return { kind: 'fee_not_confirmed', ask: askPrice };
}

// ---------------------------------------------------------------------------
// Where a decision is saved
// ---------------------------------------------------------------------------

export function decisionStorageNote(garment: GarmentPiece): string {
  return isKeptAfterReload(garment)
    ? 'Saved in this browser only · kept after reload'
    : 'Saved in this browser only · resets on reload';
}

/** The photo toggle shows only when the piece has two different photos on record. */
export function hasTwoPhotos(garment: GarmentPiece): boolean {
  return (
    !!garment.frontImageUrl &&
    !!garment.imageUrl &&
    garment.frontImageUrl !== garment.imageUrl
  );
}

// ---------------------------------------------------------------------------
// Phone bottom sheet: about 70% tall, dragged up to full height or down to close
// ---------------------------------------------------------------------------

export type SheetState = 'half' | 'full';

export const SHEET_HALF_RATIO = 0.7;
/** The sheet never shrinks below this while dragging, so the handle stays reachable. */
export const SHEET_MIN_HEIGHT_PX = 96;
/** Pointer travel (px) that counts as a deliberate drag up or down. */
export const SHEET_DRAG_UP_PX = 60;
export const SHEET_DRAG_DOWN_PX = 80;
/** From full height, dragging down this share of the viewport closes instead of returning to half. */
export const SHEET_CLOSE_SHARE = 0.3;

export function sheetHeightFor(state: SheetState, viewportHeight: number): number {
  return state === 'full'
    ? viewportHeight
    : Math.round(viewportHeight * SHEET_HALF_RATIO);
}

/** Height while the handle is held: the start height minus the downward travel, clamped. */
export function sheetHeightWhileDragging(
  from: SheetState,
  dy: number,
  viewportHeight: number,
): number {
  const start = sheetHeightFor(from, viewportHeight);
  return Math.max(SHEET_MIN_HEIGHT_PX, Math.min(viewportHeight, start - dy));
}

/**
 * Where the sheet settles when the handle is released. dy is the pointer travel in px
 * (positive = down). A short travel snaps back to where it started.
 */
export function resolveSheetDrag(
  from: SheetState,
  dy: number,
  viewportHeight: number,
): SheetState | 'closed' {
  if (dy <= -SHEET_DRAG_UP_PX) return 'full';
  if (dy >= SHEET_DRAG_DOWN_PX) {
    if (from === 'half') return 'closed';
    return dy >= viewportHeight * SHEET_CLOSE_SHARE ? 'closed' : 'half';
  }
  return from;
}
