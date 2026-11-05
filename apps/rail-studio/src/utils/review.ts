import { CurrencyCode, GarmentPiece, PriceObservation } from '../types/closet';
import {
  computeNetPayout,
  defaultAskPrice,
  formatCurrency,
  getLatestObservation,
  plural,
} from './ledgerLogic';

// Review mode: the pieces marked Sell plus the undecided ones, side by side. Everything here is
// counted from the records already on screen (the same ones the rail, grid and inspector read):
// the latest price seen in the piece's own currency, the wears in a verified 60-day log, the
// owner's own fee ticks. No price is estimated, no outcome is predicted, and nothing is ranked
// by anything but the owner's decision and the counted wears.

export type ReviewDecision = 'sell' | 'undecided';

export type NetInfo = ReturnType<typeof computeNetPayout>;

export interface ReviewRow {
  id: string;
  code: string;
  currency: CurrencyCode;
  isSample: boolean;
  decision: ReviewDecision;
  /** Wears in the last 60 days from a verified log; null = no wear log (unknown, never 0). */
  wears60d: number | null;
  lastWornDate: string | null;
  /** Latest price seen in the piece's own currency, or null when there is none. */
  latest: PriceObservation | null;
  /** True only when the owner ticked every cost line (fee rate and shipping). */
  feesChecked: boolean;
  /** Fee arithmetic at the latest price seen; null when there is no price seen. */
  netInfo: NetInfo | null;
  /** Net at the latest price seen; null unless a price was seen and every cost line is ticked. */
  net: number | null;
  garment: GarmentPiece;
}

/** Keep / Sell / Undecided as the owner saved it; a piece with no saved decision is undecided. */
export function reviewDecision(g: GarmentPiece): 'keep' | ReviewDecision {
  const choice = g.lastDecision?.choice;
  if (choice === 'keep') return 'keep';
  return choice === 'sell' ? 'sell' : 'undecided';
}

export function toReviewRow(g: GarmentPiece): ReviewRow {
  // The same rule as the inspector's evidence: a sample piece has no wear log of its own.
  const hasWearLog = (g.wearLogStatus ?? 'verified') === 'verified' && !g.isSample;
  const latest = getLatestObservation(g);
  const feesChecked = g.feeConfig.confirmed === true;
  const netInfo = latest
    ? computeNetPayout(latest.price, g.feeConfig.feeRatePct, g.feeConfig.shippingCost, feesChecked)
    : null;
  return {
    id: g.id,
    code: g.code,
    currency: g.currency,
    isSample: g.isSample,
    decision: g.lastDecision?.choice === 'sell' ? 'sell' : 'undecided',
    wears60d: hasWearLog ? g.wearsLast60Days : null,
    lastWornDate: hasWearLog ? (g.lastWornDate ?? null) : null,
    latest,
    feesChecked,
    netInfo,
    net: netInfo && netInfo.status === 'confirmed' ? netInfo.netPayout : null,
    garment: g,
  };
}

/** Sell before Undecided; then the fewest counted wears first; pieces with no wear log last. */
export function compareReviewRows(a: ReviewRow, b: ReviewRow): number {
  if (a.decision !== b.decision) return a.decision === 'sell' ? -1 : 1;
  if (a.wears60d === null && b.wears60d === null) return 0;
  if (a.wears60d === null) return 1;
  if (b.wears60d === null) return -1;
  return a.wears60d - b.wears60d;
}

/**
 * The review candidates: every piece whose saved decision is Sell, plus every piece with no
 * decision, in review order. Sample pieces are listed (flagged) so the list matches the rail,
 * but reviewSums never counts them. Pieces marked Keep are not candidates.
 */
export function reviewCandidates(garments: GarmentPiece[]): ReviewRow[] {
  return garments
    .filter((g) => reviewDecision(g) !== 'keep')
    .map(toReviewRow)
    .sort(compareReviewRows);
}

export interface ReviewSumBucket {
  currency: CurrencyCode;
  /** Sum of the nets of the summed rows, in this currency only. */
  sum: number;
  /** Rows summed: selected, a price seen, every cost line ticked. */
  summed: number;
  /** Rows selected in this currency. Sample rows never count. */
  selected: number;
  /** Selected rows left out because no price was seen. */
  noPrice: number;
  /** Selected rows left out because a cost line is not ticked (or the fee lines are unusable). */
  feeNotConfirmed: number;
}

export interface ReviewSums {
  krw: ReviewSumBucket;
  usd: ReviewSumBucket;
}

function emptyBucket(currency: CurrencyCode): ReviewSumBucket {
  return { currency, sum: 0, summed: 0, selected: 0, noPrice: 0, feeNotConfirmed: 0 };
}

/**
 * Per-currency sums of the selected rows. KRW and USD are never added together; a Sample row is
 * never counted even when its id is passed; a row without a price seen or with a cost line not
 * ticked counts as selected but adds nothing.
 */
export function reviewSums(rows: ReviewRow[], selectedIds: Iterable<string>): ReviewSums {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const sums: ReviewSums = { krw: emptyBucket('KRW'), usd: emptyBucket('USD') };
  for (const row of rows) {
    if (row.isSample || !selected.has(row.id)) continue;
    const bucket = row.currency === 'KRW' ? sums.krw : sums.usd;
    bucket.selected += 1;
    if (!row.latest) {
      bucket.noPrice += 1;
    } else if (row.net === null) {
      bucket.feeNotConfirmed += 1;
    } else {
      bucket.sum += row.net;
      bucket.summed += 1;
    }
  }
  return sums;
}

/** The bottom-bar line for one currency, word for word. */
export function describeSumLine(b: ReviewSumBucket): string {
  return `Net if sold at the latest price seen: ${formatCurrency(b.sum, b.currency)} on ${b.summed} of ${b.selected} selected (fees checked)`;
}

/** "2 wears · 60 days · last worn 2026-09-28", "0 wears · 60 days", or "No wear log". */
export function describeWears(r: Pick<ReviewRow, 'wears60d' | 'lastWornDate'>): string {
  if (r.wears60d === null) return 'No wear log';
  const base = `${plural(r.wears60d, 'wear')} · 60 days`;
  return r.lastWornDate ? `${base} · last worn ${r.lastWornDate}` : base;
}

/** "₩275,000 · KREAM · trade · 2026-11-03" (with " · Sample" on a sample record), or "No price seen". */
export function describeLatestPrice(r: Pick<ReviewRow, 'latest'>): string {
  const o = r.latest;
  if (!o) return 'No price seen';
  return `${formatCurrency(o.price, o.currency)} · ${o.platform} · ${o.kind === 'traded' ? 'trade' : 'ask'}${
    o.isSample ? ' · Sample' : ''
  } · ${o.date}`;
}

/** Trade prices on record in the piece's currency: the observed range and how many are behind it. */
export function tradedBand(g: GarmentPiece): { min: number | null; max: number | null; count: number } {
  const prices = g.observations
    .filter((o) => o.currency === g.currency && o.price > 0 && o.kind === 'traded')
    .map((o) => o.price);
  if (prices.length === 0) return { min: null, max: null, count: 0 };
  return { min: Math.min(...prices), max: Math.max(...prices), count: prices.length };
}

/**
 * The L0 listing draft, the same text the inspector copies for an untouched ask: the ask is the
 * latest price seen, else the purchase price, else a [VERIFY] placeholder. Fields nobody recorded
 * stay guarded with [VERIFY]. Copy only: nothing is posted anywhere.
 */
export function buildListingDraft(g: GarmentPiece): string {
  const ask = defaultAskPrice(g);
  return `[${g.brand || '[VERIFY: Brand]'}] ${g.name} (${g.code})
· Target Ask Price: ${ask !== null ? `${formatCurrency(ask, g.currency)} (${g.feeConfig.platform})` : '[VERIFY: Asking Price]'}
· Fabric / Condition: ${g.fabricLabel} / ${g.conditionGrade ?? '[VERIFY: Condition Grade]'}
· Size / Measurements: [VERIFY: Tag Size & Measurements]
· Provenance / Packaging: [VERIFY: Original Receipt / Tags]`;
}
