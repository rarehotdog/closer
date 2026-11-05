import { GarmentPiece } from '../types/closet';
import { formatCurrency, getLatestObservation } from './ledgerLogic';

// The status forms a hang tag (3D rail) and a grid card share. Each state has its own shape, not
// only a colour: a price seen is a solid tag with the amount; no price on record is a dashed tag
// that reads "No price seen" (no amount, no currency sign); no wear log is a hollow dot, never a
// 0; a verified log with no wear in the window is the counted "0 wears · 60d".

export type TagKind = 'price' | 'no-price';

export interface TagForm {
  /** 'price': a solid tag with the latest amount seen. 'no-price': a dashed tag reading "No price seen". */
  kind: TagKind;
  /** The amount with its currency sign (e.g. "₩1,360,000") for 'price'; the words "No price seen" otherwise. */
  priceText: string;
  /** The platform the latest price was seen on; null when there is no price on record. */
  platform: string | null;
  /** True when the latest price is an asking price rather than a trade. */
  ask: boolean;
  /** True when the latest price is sample data. */
  samplePrice: boolean;
  /** True when the piece has no wear log: the tag carries a hollow dot and says "No wear log". */
  hollow: boolean;
  /** Counted wears in the last 60 days from a verified log; null without a log. */
  wears: number | null;
  /** "No wear log" / "0 wears · 60d" / "1 wear · 60d" / "k wears · 60d". */
  wearText: string;
}

export const NO_PRICE_TEXT = 'No price seen';
export const NO_WEAR_LOG_TEXT = 'No wear log';
export const WEAR_WINDOW_TEXT = '60d';

export function wearText(wears: number | null): string {
  if (wears === null) return NO_WEAR_LOG_TEXT;
  return `${wears} wear${wears === 1 ? '' : 's'} · ${WEAR_WINDOW_TEXT}`;
}

export function tagForm(piece: GarmentPiece): TagForm {
  // Only a price in the piece's own currency counts (currencies are never mixed).
  const latest = getLatestObservation(piece);
  const count = piece.wearsLast60Days;
  const hasLog =
    (piece.wearLogStatus ?? 'verified') === 'verified' &&
    typeof count === 'number' &&
    Number.isFinite(count) &&
    count >= 0;
  const wears = hasLog ? Math.floor(count) : null;
  return {
    kind: latest ? 'price' : 'no-price',
    priceText: latest ? formatCurrency(latest.price, latest.currency) : NO_PRICE_TEXT,
    platform: latest ? latest.platform : null,
    ask: latest?.kind === 'listed',
    samplePrice: latest?.isSample === true,
    hollow: !hasLog,
    wears,
    wearText: wearText(wears),
  };
}
