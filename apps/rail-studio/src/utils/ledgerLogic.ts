import {
  CurrencyCode,
  CurrencyLedgerBucket,
  GarmentCategory,
  GarmentPiece,
  GarmentSilhouette,
  LedgerSummary,
  PriceObservation,
  ResalePlatform,
  TargetLook,
} from '../types/closet';

/**
 * Returns observations sorted chronologically ascending by date.
 */
export function sortObservationsChronologically(
  observations: PriceObservation[],
): PriceObservation[] {
  return [...observations].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Gets the latest valid price observation for a garment in its native currency.
 */
export function getLatestObservation(
  garment: GarmentPiece,
): PriceObservation | null {
  const matching = garment.observations.filter(
    (obs) => obs.currency === garment.currency && obs.price > 0,
  );
  if (matching.length === 0) return null;
  const sorted = sortObservationsChronologically(matching);
  return sorted[sorted.length - 1];
}

/**
 * The price an asking-price control may start from: the latest price seen, else the purchase
 * price. null when the piece has neither (e.g. a piece just scanned from a photo): then no
 * asking price is shown or saved until the owner adds a price.
 */
export function defaultAskPrice(garment: GarmentPiece): number | null {
  const latest = getLatestObservation(garment);
  if (latest) return latest.price;
  if (
    typeof garment.purchasePrice === 'number' &&
    Number.isFinite(garment.purchasePrice) &&
    garment.purchasePrice > 0
  ) {
    return garment.purchasePrice;
  }
  return null;
}

/** True when there is any price on record to anchor an asking price (see defaultAskPrice). */
export function hasPriceBasis(garment: GarmentPiece): boolean {
  return defaultAskPrice(garment) !== null;
}

/** The date every on-screen "days ago" / "last 60 days" count is measured from. */
export const REFERENCE_DATE = '2026-11-05';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from `fromDate` to `toDate` (both YYYY-MM-DD). Returns null when either
 * date is missing or unparsable, so callers can say "date unknown" instead of "0 days".
 */
export function daysBetween(
  fromDate: string | null | undefined,
  toDate: string = REFERENCE_DATE,
): number | null {
  if (!fromDate) return null;
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "2026-10-26" -> "Oct 26"; a missing or malformed date -> "date unknown". */
export function formatShortDate(date: string | null | undefined): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return 'date unknown';
  const month = MONTHS[Number(date.slice(5, 7)) - 1];
  if (!month) return 'date unknown';
  return `${month} ${date.slice(8, 10)}`;
}

/**
 * Filters observations by time window ('30d' | '90d' | 'all') relative to a reference date.
 *
 * A price change is reported ONLY between two records of the same platform and the same
 * kind (trade vs ask) as the latest record. Comparing a trade on one platform with an ask
 * on another is not a change in price, so in that case deltaAmount/deltaPct are null and
 * seriesCount tells the caller how many same-platform records exist.
 */
export function filterObservationsByWindow(
  observations: PriceObservation[],
  currency: CurrencyCode,
  window: '30d' | '90d' | 'all',
  referenceDateStr = REFERENCE_DATE,
): {
  filtered: PriceObservation[];
  latest: PriceObservation | null;
  first: PriceObservation | null;
  seriesFirst: PriceObservation | null;
  seriesCount: number;
  deltaAmount: number | null;
  deltaPct: number | null;
} {
  const byCurrency = sortObservationsChronologically(
    observations.filter((o) => o.currency === currency && o.price > 0),
  );

  if (byCurrency.length === 0) {
    return {
      filtered: [],
      latest: null,
      first: null,
      seriesFirst: null,
      seriesCount: 0,
      deltaAmount: null,
      deltaPct: null,
    };
  }

  let filtered = byCurrency;
  if (window !== 'all') {
    const days = window === '30d' ? 30 : 90;
    const refTime = new Date(`${referenceDateStr}T00:00:00Z`).getTime();
    const cutoffTime = refTime - days * DAY_MS;
    const windowFiltered = byCurrency.filter((o) => {
      const t = new Date(`${o.date}T00:00:00Z`).getTime();
      return t >= cutoffTime;
    });
    filtered = windowFiltered.length > 0 ? windowFiltered : byCurrency.slice(-2);
  }

  const first = filtered[0] ?? null;
  const latest = filtered[filtered.length - 1] ?? null;

  if (!first || !latest) {
    return {
      filtered,
      latest,
      first,
      seriesFirst: null,
      seriesCount: 0,
      deltaAmount: null,
      deltaPct: null,
    };
  }

  const series = filtered.filter(
    (o) => o.platform === latest.platform && o.kind === latest.kind,
  );
  const seriesFirst = series[0] ?? null;
  const seriesCount = series.length;

  if (!seriesFirst || seriesCount < 2 || seriesFirst.id === latest.id) {
    return {
      filtered,
      latest,
      first,
      seriesFirst,
      seriesCount,
      deltaAmount: null,
      deltaPct: null,
    };
  }

  const deltaAmount = latest.price - seriesFirst.price;
  const deltaPct =
    seriesFirst.price > 0
      ? Number(
          (((latest.price - seriesFirst.price) / seriesFirst.price) * 100).toFixed(1),
        )
      : null;

  return {
    filtered,
    latest,
    first,
    seriesFirst,
    seriesCount,
    deltaAmount,
    deltaPct,
  };
}

/**
 * Computes net payout after platform fee and shipping ONLY when fee structure is confirmed.
 * Honesty rule: If fees are unconfirmed or inputs are invalid, net payout is null.
 */
export function computeNetPayout(
  grossPrice: number | null | undefined,
  feeRatePct: number,
  shippingCost: number,
  confirmed: boolean,
): {
  status: 'confirmed' | 'unconfirmed' | 'invalid';
  gross: number | null;
  feeAmount: number | null;
  shipping: number | null;
  netPayout: number | null;
} {
  if (
    typeof grossPrice !== 'number' ||
    !Number.isFinite(grossPrice) ||
    grossPrice <= 0 ||
    typeof feeRatePct !== 'number' ||
    !Number.isFinite(feeRatePct) ||
    feeRatePct < 0 ||
    feeRatePct >= 100 ||
    typeof shippingCost !== 'number' ||
    !Number.isFinite(shippingCost) ||
    shippingCost < 0
  ) {
    return {
      status: 'invalid',
      gross: null,
      feeAmount: null,
      shipping: null,
      netPayout: null,
    };
  }

  if (!confirmed) {
    return {
      status: 'unconfirmed',
      gross: grossPrice,
      feeAmount: null,
      shipping: null,
      netPayout: null,
    };
  }

  const feeAmount = Math.round((grossPrice * feeRatePct) / 100);
  const netPayout = Math.max(0, Math.round(grossPrice - feeAmount - shippingCost));

  return {
    status: 'confirmed',
    gross: grossPrice,
    feeAmount,
    shipping: shippingCost,
    netPayout,
  };
}

/**
 * Fee confirmation from the two cost lines. A fee is confirmed only when the owner ticked BOTH
 * the fee rate and the shipping cost; a missing tick counts as not ticked.
 */
export function feeLinesConfirmed(
  feeRateConfirmed: boolean | undefined,
  shippingConfirmed: boolean | undefined,
): boolean {
  return feeRateConfirmed === true && shippingConfirmed === true;
}

/**
 * Checks if facts moved since the garment's last recorded decision.
 */
export function hasFactsMoved(garment: GarmentPiece): boolean {
  if (!garment.lastDecision) return false;
  const latest = getLatestObservation(garment);
  if (!latest) return false;
  return latest.price !== garment.lastDecision.snapshotPrice;
}

function createEmptyBucket(currency: CurrencyCode): CurrencyLedgerBucket {
  return {
    currency,
    ownedTotalLatest: 0,
    ownedSeenCount: 0,
    ownedTotalPieces: 0,
    tradedCount: 0,
    listedCount: 0,
    sampleTotalLatest: 0,
    sampleSeenCount: 0,
    confirmedNetTotal: 0,
    confirmedNetCount: 0,
  };
}

/**
 * Computes the complete ledger summary:
 * - Never converts or sums across KRW and USD.
 * - Never sums Sample pieces into owned totals.
 * - Tracks exact denominator (seenCount of ownedTotalPieces).
 */
export function computeLedgerSummary(garments: GarmentPiece[]): LedgerSummary {
  const krw = createEmptyBucket('KRW');
  const usd = createEmptyBucket('USD');
  const factsMovedIds: string[] = [];

  let totalOwnedPieces = 0;
  let totalSamplePieces = 0;
  let keepCount = 0;
  let sellCount = 0;
  let undecidedCount = 0;

  for (const g of garments) {
    const bucket = g.currency === 'KRW' ? krw : usd;
    const latest = getLatestObservation(g);

    if (g.isSample) {
      totalSamplePieces += 1;
      if (latest) {
        bucket.sampleTotalLatest += latest.price;
        bucket.sampleSeenCount += 1;
      }
      continue;
    }

    totalOwnedPieces += 1;
    bucket.ownedTotalPieces += 1;

    if (g.lastDecision?.choice === 'keep') keepCount += 1;
    else if (g.lastDecision?.choice === 'sell') sellCount += 1;
    else undecidedCount += 1;

    if (hasFactsMoved(g)) {
      factsMovedIds.push(g.id);
    }

    if (latest) {
      bucket.ownedTotalLatest += latest.price;
      bucket.ownedSeenCount += 1;
      if (latest.kind === 'traded') bucket.tradedCount += 1;
      else bucket.listedCount += 1;

      const netInfo = computeNetPayout(
        latest.price,
        g.feeConfig.feeRatePct,
        g.feeConfig.shippingCost,
        g.feeConfig.confirmed,
      );
      if (netInfo.status === 'confirmed' && netInfo.netPayout !== null) {
        bucket.confirmedNetTotal += netInfo.netPayout;
        bucket.confirmedNetCount += 1;
      }
    }
  }

  return {
    krw,
    usd,
    totalOwnedPieces,
    totalSamplePieces,
    factsMovedIds,
    keepCount,
    sellCount,
    undecidedCount,
  };
}

/**
 * Formats currency values cleanly with tabular precision.
 */
export function formatCurrency(amount: number, currency: CurrencyCode): string {
  if (currency === 'KRW') {
    return `₩${Math.round(amount).toLocaleString('en-US')}`;
  }
  const isWhole = Math.abs(amount - Math.round(amount)) < 0.001;
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Formats a signed money difference, e.g. "+₩868,800" or "−₩691,200". */
export function formatSignedCurrency(
  amount: number,
  currency: CurrencyCode,
): string {
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}${formatCurrency(Math.abs(amount), currency)}`;
}

/** "1 trade" / "3 trades" style counting helper for on-screen text. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Evaluates target look coverage against owned garments.
 */
export function evaluateTargetLook(
  look: TargetLook,
  garments: GarmentPiece[],
): {
  ownedCount: number;
  totalRequired: number;
  isComplete: boolean;
} {
  const ownedIds = new Set(
    garments.filter((g) => !g.isSample).map((g) => g.code),
  );
  const ownedCount = look.pieceIds.filter((code) => ownedIds.has(code)).length;
  const totalRequired = look.pieceIds.length;

  return {
    ownedCount,
    totalRequired,
    isComplete: ownedCount === totalRequired && totalRequired > 0,
  };
}

export interface RotationWeekBucket {
  label: string;
  kept: number;
  sellDecided: number;
}

/**
 * Keep vs Sell DECISIONS saved in the last 30 days. Nothing here means a piece was sold:
 * the app has no "sold" state and no sale records, only the owner's saved choice.
 */
export interface RotationTrend30D {
  keptLast30d: number;
  sellDecidedLast30d: number;
  totalDecided30d: number;
  /** Non-sample pieces: the denominator for "decided in the last 30 days". */
  ownedPieces: number;
  /** Share of the counted decisions, used only for bar and arc lengths. */
  keptShare: number;
  sellDecidedShare: number;
  /** Latest price seen, summed per currency, over decided pieces that HAVE a price on record. */
  keptValuationKRW: number;
  sellDecidedValuationKRW: number;
  keptValuationUSD: number;
  sellDecidedValuationUSD: number;
  /** How many of the counted decisions had a price on record (the rest are not in the sums). */
  keptPricedCount: number;
  sellDecidedPricedCount: number;
  weeklyBuckets: RotationWeekBucket[];
}

/**
 * Counts Keep vs Sell decisions saved in the last 30 days and a 4-week breakdown
 * relative to referenceDateStr (YYYY-MM-DD). Valuations add the latest price seen only;
 * a piece without a price on record is counted as a decision but not summed.
 */
export function compute30DayRotationTrend(
  garments: GarmentPiece[],
  referenceDateStr = REFERENCE_DATE,
): RotationTrend30D {
  const refTime = new Date(`${referenceDateStr}T23:59:59Z`).getTime();
  const cutoff30d = refTime - 30 * DAY_MS;

  let keptLast30d = 0;
  let sellDecidedLast30d = 0;
  let keptValuationKRW = 0;
  let sellDecidedValuationKRW = 0;
  let keptValuationUSD = 0;
  let sellDecidedValuationUSD = 0;
  let keptPricedCount = 0;
  let sellDecidedPricedCount = 0;

  const weeklyBuckets: RotationWeekBucket[] = [
    { label: 'W1', kept: 0, sellDecided: 0 },
    { label: 'W2', kept: 0, sellDecided: 0 },
    { label: 'W3', kept: 0, sellDecided: 0 },
    { label: 'W4 (Now)', kept: 0, sellDecided: 0 },
  ];

  const owned = garments.filter((g) => !g.isSample);

  for (const g of owned) {
    if (!g.lastDecision) continue;
    const savedAt = g.lastDecision.savedAt;
    const decTime = new Date(/^\d{4}-\d{2}-\d{2}$/.test(savedAt) ? `${savedAt}T12:00:00Z` : savedAt).getTime();
    if (Number.isNaN(decTime) || decTime < cutoff30d || decTime > refTime) {
      continue;
    }

    const latest = getLatestObservation(g);

    // Assign to W1..W4 bucket (each ~7.5 days across the 30-day window)
    const ageDays = Math.max(0, (refTime - decTime) / DAY_MS);
    const weekIdx = Math.min(3, Math.max(0, 3 - Math.floor(ageDays / 7.5)));

    if (g.lastDecision.choice === 'keep') {
      keptLast30d += 1;
      weeklyBuckets[weekIdx].kept += 1;
      if (latest) {
        keptPricedCount += 1;
        if (g.currency === 'KRW') keptValuationKRW += latest.price;
        else keptValuationUSD += latest.price;
      }
    } else if (g.lastDecision.choice === 'sell') {
      sellDecidedLast30d += 1;
      weeklyBuckets[weekIdx].sellDecided += 1;
      if (latest) {
        sellDecidedPricedCount += 1;
        if (g.currency === 'KRW') sellDecidedValuationKRW += latest.price;
        else sellDecidedValuationUSD += latest.price;
      }
    }
  }

  const totalDecided30d = keptLast30d + sellDecidedLast30d;
  const keptShare =
    totalDecided30d > 0 ? Math.round((keptLast30d / totalDecided30d) * 100) : 0;
  const sellDecidedShare = totalDecided30d > 0 ? 100 - keptShare : 0;

  return {
    keptLast30d,
    sellDecidedLast30d,
    totalDecided30d,
    ownedPieces: owned.length,
    keptShare,
    sellDecidedShare,
    keptValuationKRW,
    sellDecidedValuationKRW,
    keptValuationUSD,
    sellDecidedValuationUSD,
    keptPricedCount,
    sellDecidedPricedCount,
    weeklyBuckets,
  };
}

/**
 * Keep / Sell evidence. Both sides show only COUNTED records with their denominators
 * (wears in the last 60 days, last worn date, number of trade and ask prices recorded,
 * with dates). No probability, likelihood or forecast is computed anywhere: there is no
 * record of unsold listings, and no model is called for these numbers.
 */
export interface PriceRecordCount {
  /** Records of this kind in the garment's own currency. */
  count: number;
  /** Of those, records dated within the last 60 days of the reference date. */
  last60dCount: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface KeepEvidence {
  status: 'wear_log_counted' | 'no_wear_log';
  /** null when there is no wear log: missing records are "unknown", never 0 wears. */
  wearsLast60Days: number | null;
  lastWornDate: string | null;
  /** null when the date is unknown. */
  daysSinceLastWorn: number | null;
  matchingLooks: TargetLook[];
  upcomingOccasions: string[];
}

export interface SellEvidence {
  status: 'prices_counted' | 'no_price_records';
  platform: ResalePlatform;
  /** The ask being looked at; null when there is no price on record and none was set. */
  askPrice: number | null;
  /** Latest price seen in the garment's currency (trade or ask), or null. */
  latestPrice: number | null;
  latestObservation: PriceObservation | null;
  /** Ask vs latest price seen, in percent of that price. A price difference, not a chance. */
  askDeltaPctFromLatest: number | null;
  traded: PriceRecordCount;
  listed: PriceRecordCount;
  tradedBandMin: number | null;
  tradedBandMax: number | null;
  netPayoutInfo: {
    status: 'confirmed' | 'unconfirmed' | 'invalid';
    gross: number | null;
    feeAmount: number | null;
    shipping: number | null;
    netPayout: number | null;
  };
}

export interface KeepSellEvidence {
  keepScenario: KeepEvidence;
  sellScenario: SellEvidence;
  summary: {
    coreQuestion: string;
    /** Always the same neutral text; no recommendation is derived from the records. */
    neutralBadge: string;
    limitsNotice: string;
  };
}

export const NEUTRAL_DECISION_BADGE = 'Compare the records, then decide';

export const LIMITS_NOTICE =
  'No probability is computed. A trade record says the piece sold at that price once; it does not say when this one would sell, and there are no records of listings that did not sell. Days without a wear record are unknown, not 0 wears. Every number here is counted by code from the records on this screen (sample data or what you entered); no model is called for these numbers.';

function countRecords(
  records: PriceObservation[],
  referenceDateStr: string,
): PriceRecordCount {
  const sorted = sortObservationsChronologically(records);
  const last60dCount = sorted.filter((o) => {
    const age = daysBetween(o.date, referenceDateStr);
    return age !== null && age >= 0 && age <= 60;
  }).length;
  return {
    count: sorted.length,
    last60dCount,
    firstDate: sorted[0]?.date ?? null,
    lastDate: sorted[sorted.length - 1]?.date ?? null,
  };
}

/**
 * Summarises the recorded evidence for keeping or selling a piece at `askPrice`.
 * - Keep side: wears in the last 60 days and last worn date, or "no wear log".
 * - Sell side: number of trade and ask prices recorded (with dates), the observed trade
 *   range, and the net payout at `askPrice` only when every cost line was checked.
 * Nothing here depends on lockedForToday, condition grade or any tuning constant, so a
 * number on screen only moves when a recorded fact moves. With no ask and no price on
 * record, askPrice stays null: no default asking price is invented.
 */
export function summarizeKeepSellEvidence(
  garment: GarmentPiece,
  askPrice: number | null,
  allLooks: TargetLook[],
  referenceDateStr = REFERENCE_DATE,
): KeepSellEvidence {
  const matchingLooks = allLooks.filter((l) =>
    l.pieceIds.includes(garment.code),
  );
  const upcomingOccasions = garment.upcomingOccasions ?? [];

  // --- 1. KEEP SIDE: counted wears ---
  const wearLogStatus = garment.wearLogStatus ?? 'verified';
  const hasWearLog = wearLogStatus === 'verified' && !garment.isSample;
  const lastWornDate = hasWearLog ? (garment.lastWornDate ?? null) : null;
  const daysSince = daysBetween(lastWornDate, referenceDateStr);

  const keepScenario: KeepEvidence = {
    status: hasWearLog ? 'wear_log_counted' : 'no_wear_log',
    wearsLast60Days: hasWearLog ? garment.wearsLast60Days : null,
    lastWornDate,
    daysSinceLastWorn: daysSince !== null && daysSince >= 0 ? daysSince : null,
    matchingLooks,
    upcomingOccasions,
  };

  // --- 2. SELL SIDE: counted prices ---
  const validObs = garment.observations.filter(
    (o) => o.currency === garment.currency && o.price > 0,
  );
  const tradedObs = validObs.filter((o) => o.kind === 'traded');
  const listedObs = validObs.filter((o) => o.kind === 'listed');
  const latest = getLatestObservation(garment);
  const latestPrice = latest?.price ?? null;

  const safeAskPrice =
    typeof askPrice === 'number' && Number.isFinite(askPrice) && askPrice > 0
      ? askPrice
      : defaultAskPrice(garment);

  const askDeltaPctFromLatest =
    latestPrice !== null && latestPrice > 0 && safeAskPrice !== null
      ? Number((((safeAskPrice - latestPrice) / latestPrice) * 100).toFixed(1))
      : null;

  const tradedPrices = tradedObs.map((o) => o.price);
  const tradedBandMin =
    tradedPrices.length > 0 ? Math.min(...tradedPrices) : null;
  const tradedBandMax =
    tradedPrices.length > 0 ? Math.max(...tradedPrices) : null;

  const netPayoutInfo = computeNetPayout(
    safeAskPrice,
    garment.feeConfig.feeRatePct,
    garment.feeConfig.shippingCost,
    garment.feeConfig.confirmed,
  );

  const sellScenario: SellEvidence = {
    status: validObs.length > 0 ? 'prices_counted' : 'no_price_records',
    platform: garment.feeConfig.platform,
    askPrice: safeAskPrice,
    latestPrice,
    latestObservation: latest,
    askDeltaPctFromLatest,
    traded: countRecords(tradedObs, referenceDateStr),
    listed: countRecords(listedObs, referenceDateStr),
    tradedBandMin,
    tradedBandMax,
    netPayoutInfo,
  };

  return {
    keepScenario,
    sellScenario,
    summary: {
      coreQuestion:
        "Will this garment's next value come from your life, or someone else's?",
      neutralBadge: NEUTRAL_DECISION_BADGE,
      limitsNotice: LIMITS_NOTICE,
    },
  };
}

export interface PlatformDotStripRow {
  platform: ResalePlatform;
  currency: CurrencyCode;
  /** The platform named in the garment's own fee settings. */
  isPrimary: boolean;
  /** 'entered' = the garment's fee settings; 'default' = a built-in default never checked. */
  feeSource: 'entered' | 'default';
  feeRatePct: number;
  shippingCost: number;
  /** Only the primary platform can be confirmed, and only after the owner ticks every cost line. */
  feeConfirmed: boolean;
  observations: (PriceObservation & { excluded: boolean })[];
  activeObservations: PriceObservation[];
  tradedCount: number;
  listedCount: number;
  /** Number of prices behind minPrice..maxPrice. No averaged or "median" price is produced. */
  activeCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  hasSampleObservation: boolean;
  conditionalNetAtAsk: number | null;
  feeAmountAtAsk: number | null;
  /** Highest net at the ask among rows whose fees were confirmed. */
  isRecommendedNet: boolean;
}

const PLATFORM_DEFAULT_FEES: Record<
  ResalePlatform,
  { feeRatePct: number; shippingKRW: number; shippingUSD: number }
> = {
  KREAM: { feeRatePct: 5.5, shippingKRW: 3500, shippingUSD: 15 },
  'Musinsa Used': { feeRatePct: 6.0, shippingKRW: 3000, shippingUSD: 15 },
  Bunjang: { feeRatePct: 3.5, shippingKRW: 3500, shippingUSD: 15 },
  Karrot: { feeRatePct: 0.0, shippingKRW: 0, shippingUSD: 0 },
  Grailed: { feeRatePct: 9.0, shippingKRW: 15000, shippingUSD: 15 },
  StockX: { feeRatePct: 9.5, shippingKRW: 15000, shippingUSD: 14 },
  eBay: { feeRatePct: 13.0, shippingKRW: 18000, shippingUSD: 16 },
  Poshmark: { feeRatePct: 20.0, shippingKRW: 12000, shippingUSD: 8 },
  Depop: { feeRatePct: 10.0, shippingKRW: 12000, shippingUSD: 12 },
  Vinted: { feeRatePct: 5.0, shippingKRW: 10000, shippingUSD: 10 },
};

/** Built-in default fee for a platform. Never treated as confirmed. */
export function getDefaultFee(
  platform: ResalePlatform,
  currency: CurrencyCode,
): { feeRatePct: number; shippingCost: number } {
  const d = PLATFORM_DEFAULT_FEES[platform];
  return {
    feeRatePct: d.feeRatePct,
    shippingCost: currency === 'KRW' ? d.shippingKRW : d.shippingUSD,
  };
}

/**
 * Builds per-platform dot-strip rows for a garment in its native currency,
 * separating TRADE (completed) and ASK (active listing) dots, supporting
 * 1-tap outlier/comp exclusion, and computing per-platform net proceeds IF sold at the ask.
 *
 * Rows for platforms other than the garment's own fee platform use built-in default fees
 * that nobody checked, so they are never "confirmed" and never get a net payout or a star.
 * With no ask (null), no net is computed for any row.
 */
export function buildPlatformDotStrips(
  garment: GarmentPiece,
  askPrice: number | null,
  excludedObsIds: string[] = [],
): PlatformDotStripRow[] {
  const excludedSet = new Set(excludedObsIds);
  const validObs = garment.observations.filter(
    (o) => o.currency === garment.currency && o.price > 0,
  );

  const platformOrder: ResalePlatform[] =
    garment.currency === 'KRW'
      ? ['KREAM', 'Musinsa Used', 'Bunjang', 'Karrot']
      : ['Grailed', 'StockX', 'eBay', 'Poshmark', 'Depop'];

  // Include any additional platform present in observations
  for (const obs of validObs) {
    if (!platformOrder.includes(obs.platform)) {
      platformOrder.push(obs.platform);
    }
  }

  const rows: PlatformDotStripRow[] = [];

  for (const platform of platformOrder) {
    const platObs = validObs
      .filter((o) => o.platform === platform)
      .map((o) => ({
        ...o,
        excluded: excludedSet.has(o.id),
      }));

    if (platObs.length === 0 && platform !== garment.feeConfig.platform) {
      continue;
    }

    const activeObservations = platObs.filter((o) => !o.excluded);
    const activePrices = activeObservations
      .map((o) => o.price)
      .sort((a, b) => a - b);

    const minPrice = activePrices.length > 0 ? activePrices[0] : null;
    const maxPrice =
      activePrices.length > 0 ? activePrices[activePrices.length - 1] : null;

    const isPrimary = platform === garment.feeConfig.platform;
    const defaults = getDefaultFee(platform, garment.currency);
    const feeRatePct = isPrimary
      ? garment.feeConfig.feeRatePct
      : defaults.feeRatePct;
    const shippingCost = isPrimary
      ? garment.feeConfig.shippingCost
      : defaults.shippingCost;
    const feeConfirmed = isPrimary && garment.feeConfig.confirmed;

    const netRes = computeNetPayout(
      askPrice,
      feeRatePct,
      shippingCost,
      feeConfirmed,
    );

    rows.push({
      platform,
      currency: garment.currency,
      isPrimary,
      feeSource: isPrimary ? 'entered' : 'default',
      feeRatePct,
      shippingCost,
      feeConfirmed,
      observations: platObs,
      activeObservations,
      tradedCount: activeObservations.filter((o) => o.kind === 'traded').length,
      listedCount: activeObservations.filter((o) => o.kind === 'listed').length,
      activeCount: activeObservations.length,
      minPrice,
      maxPrice,
      hasSampleObservation: platObs.some((o) => o.isSample === true),
      conditionalNetAtAsk: netRes.netPayout,
      feeAmountAtAsk: netRes.feeAmount,
      isRecommendedNet: false,
    });
  }

  // Mark the highest net payout, considering ONLY rows whose fees were confirmed.
  let bestIdx = -1;
  let bestNet = -1;
  rows.forEach((r, idx) => {
    if (
      r.feeConfirmed &&
      r.conditionalNetAtAsk !== null &&
      r.activeObservations.length > 0 &&
      r.conditionalNetAtAsk > bestNet
    ) {
      bestNet = r.conditionalNetAtAsk;
      bestIdx = idx;
    }
  });
  if (bestIdx >= 0) {
    rows[bestIdx].isRecommendedNet = true;
  }

  return rows;
}

export interface PreCheckoutEvaluation {
  duplicateCategoryPieces: GarmentPiece[];
  unlockedOutfitCount: number;
  unlockedCombinations: string[];
  swapCandidate: GarmentPiece | null;
  /** Latest price seen for the swap piece (what it would sell for, IF it sold at that price). */
  swapCandidateGross: number | null;
  swapCandidateFeesConfirmed: boolean;
  /** Net after fees at that price; null unless every cost line was checked. Never the gross. */
  swapCandidateNetPayout: number | null;
  /** candidate price minus the net payout. Can be negative. null when the net is unknown. */
  netCashAfterSwap: number | null;
}

/**
 * Evaluates a candidate purchase before checkout against owned wardrobe pieces:
 * 1. Detects duplicate/overlapping pieces in the same category.
 * 2. Counts how many complete 3-piece outfit combinations the candidate unlocks with owned items.
 * 3. Computes a hypothetical 1-to-1 swap difference: IF the chosen owned piece sold at its latest
 *    price seen. The net is used only when fees were confirmed; otherwise no difference is given.
 */
export function evaluatePreCheckoutGate(
  candidate: {
    name: string;
    brand: string;
    category: GarmentPiece['category'];
    price: number;
    currency: CurrencyCode;
  },
  garments: GarmentPiece[],
): PreCheckoutEvaluation {
  const owned = garments.filter((g) => !g.isSample);
  const duplicateCategoryPieces = owned.filter(
    (g) => g.category === candidate.category,
  );

  // Group owned items into 3 outfit slots: outer (outerwear/blazer), mid (hoodie/knitwear), base (shirt/trousers)
  const slotOf = (cat: GarmentPiece['category']): 'outer' | 'mid' | 'base' => {
    if (cat === 'outerwear' || cat === 'blazer') return 'outer';
    if (cat === 'hoodie' || cat === 'knitwear') return 'mid';
    return 'base';
  };

  const candidateSlot = slotOf(candidate.category);
  const outers = owned.filter((g) => slotOf(g.category) === 'outer');
  const mids = owned.filter((g) => slotOf(g.category) === 'mid');
  const bases = owned.filter((g) => slotOf(g.category) === 'base');

  const unlockedCombinations: string[] = [];
  if (candidateSlot === 'outer') {
    for (const m of mids) {
      for (const b of bases) {
        unlockedCombinations.push(`[NEW] + ${m.code} + ${b.code}`);
      }
    }
  } else if (candidateSlot === 'mid') {
    for (const o of outers) {
      for (const b of bases) {
        unlockedCombinations.push(`${o.code} + [NEW] + ${b.code}`);
      }
    }
  } else {
    for (const o of outers) {
      for (const m of mids) {
        unlockedCombinations.push(`${o.code} + ${m.code} + [NEW]`);
      }
    }
  }

  // Pick the same-currency piece for the hypothetical swap: pieces with a saved Sell decision
  // first, then the fewest logged wears. Pieces without a wear log are NOT treated as 0 wears;
  // they go last because their wear count is unknown.
  const sameCurrencyOwned = owned.filter(
    (g) => g.currency === candidate.currency,
  );
  const hasLog = (g: GarmentPiece) =>
    (g.wearLogStatus ?? 'verified') === 'verified';
  const sortedSwapCandidates = [...sameCurrencyOwned].sort((a, b) => {
    const aSell = a.lastDecision?.choice === 'sell' ? 0 : 1;
    const bSell = b.lastDecision?.choice === 'sell' ? 0 : 1;
    if (aSell !== bSell) return aSell - bSell;
    const aLog = hasLog(a) ? 0 : 1;
    const bLog = hasLog(b) ? 0 : 1;
    if (aLog !== bLog) return aLog - bLog;
    return a.wearsLast60Days - b.wearsLast60Days;
  });

  const swapCandidate = sortedSwapCandidates[0] ?? null;
  let swapCandidateGross: number | null = null;
  let swapCandidateNetPayout: number | null = null;
  let netCashAfterSwap: number | null = null;
  const swapCandidateFeesConfirmed = swapCandidate?.feeConfig.confirmed ?? false;

  if (swapCandidate) {
    const latest = getLatestObservation(swapCandidate);
    swapCandidateGross = latest?.price ?? null;
    const net = computeNetPayout(
      swapCandidateGross,
      swapCandidate.feeConfig.feeRatePct,
      swapCandidate.feeConfig.shippingCost,
      swapCandidate.feeConfig.confirmed,
    );
    swapCandidateNetPayout = net.status === 'confirmed' ? net.netPayout : null;
    if (swapCandidateNetPayout !== null && candidate.price > 0) {
      netCashAfterSwap = candidate.price - swapCandidateNetPayout;
    }
  }

  return {
    duplicateCategoryPieces,
    unlockedOutfitCount: unlockedCombinations.length,
    unlockedCombinations: unlockedCombinations.slice(0, 4),
    swapCandidate,
    swapCandidateGross,
    swapCandidateFeesConfirmed,
    swapCandidateNetPayout,
    netCashAfterSwap,
  };
}

export const SILHOUETTE_TO_CATEGORY: Record<GarmentSilhouette, GarmentCategory> = {
  overcoat: 'outerwear',
  blazer: 'blazer',
  hoodie: 'hoodie',
  blouson: 'outerwear',
  knit: 'knitwear',
  tee: 'shirt',
  trousers: 'trousers',
  'sneaker-box': 'footwear',
};

export interface HangPieceInput {
  id: string;
  observationId: string;
  code: string;
  name: string;
  /** May be empty: the owner did not type a brand. */
  brand: string;
  silhouette: GarmentSilhouette;
  /** From a photo scan when its garment type maps to a category the silhouette does not (e.g. trousers). */
  category?: GarmentCategory;
  currency: CurrencyCode;
  /** The one price the owner typed, or nothing. */
  price?: number | null;
  platform: ResalePlatform;
  /**
   * What the typed price is: 'listed' (an asking price seen, the default), 'traded' (the owner
   * marked it as a completed sale) or 'paid' (what the owner paid: stored as the purchase price,
   * not as a resale price).
   */
  priceKind?: 'listed' | 'traded' | 'paid';
  colorHex: string;
  occlusionStatus: 'front_verified' | 'side_occluded';
  date?: string;
  /** The photo shown for the piece: a scan cut-out, or the owner's photo as uploaded. */
  imageUrl?: string;
  /** Set only when imageUrl is a cut-out from a photo scan. */
  cutoutSource?: 'sam-mask' | 'box-crop';
  /** Set only with cutoutSource: which server answered the scan. */
  scanMode?: 'live' | 'fake';
  /** A design-kit sample photo was used: the piece is marked Sample. */
  isSample?: boolean;
}

/**
 * Builds a piece from the Hang Piece form using ONLY what the owner typed or what a photo scan
 * returned:
 * - at most one price: an ask ('listed') unless marked as a trade, or the purchase price when
 *   marked as paid; no price at all when none was typed (no default value);
 * - fees are the platform default and NOT confirmed (neither cost line ticked);
 * - no wear log (wearLogStatus 'insufficient', 0 counted, no last-worn date);
 * - no decision, no condition grade, no fabric.
 */
export function createHungPiece(input: HangPieceInput): GarmentPiece {
  const fee = getDefaultFee(input.platform, input.currency);
  const price =
    typeof input.price === 'number' && Number.isFinite(input.price) && input.price > 0
      ? input.price
      : null;
  const kind = input.priceKind ?? 'listed';
  const observations: PriceObservation[] =
    price !== null && kind !== 'paid'
      ? [
          {
            id: input.observationId,
            date: input.date ?? REFERENCE_DATE,
            platform: input.platform,
            price,
            currency: input.currency,
            kind,
          },
        ]
      : [];

  const piece: GarmentPiece = {
    id: input.id,
    code: input.code,
    name: input.name.trim(),
    brand: input.brand.trim().toUpperCase(),
    category: input.category ?? SILHOUETTE_TO_CATEGORY[input.silhouette],
    silhouette: input.silhouette,
    currency: input.currency,
    purchasePrice: price !== null && kind === 'paid' ? price : null,
    isSample: input.isSample === true,
    colorHex: input.colorHex,
    secondaryColorHex: input.colorHex,
    fabricLabel: 'Fabric not entered',
    hangerType: 'walnut-brass',
    wearsLast60Days: 0,
    wearLogStatus: 'insufficient',
    lastWornDate: null,
    lockedForToday: false,
    occlusionStatus: input.occlusionStatus,
    observations,
    feeConfig: {
      platform: input.platform,
      feeRatePct: fee.feeRatePct,
      shippingCost: fee.shippingCost,
      feeRateConfirmed: false,
      shippingConfirmed: false,
      confirmed: false,
    },
  };
  if (input.imageUrl) {
    piece.imageUrl = input.imageUrl;
    piece.frontImageUrl = input.imageUrl;
  }
  if (input.cutoutSource) {
    piece.cutoutSource = input.cutoutSource;
    piece.scanMode = input.scanMode ?? 'fake';
  }
  return piece;
}

/**
 * Parses a 1-line order receipt or listing string (e.g., "SSENSE Lemaire Coat ₩2,450,000" or
 * "Grailed Our Legacy Hoodie $240") into the words the owner typed. Nothing is invented:
 * a missing brand or name stays empty, and the silhouette is null unless a garment word is in
 * the line.
 */
export function parseQuickOrderLine(rawLine: string): {
  brand: string;
  name: string;
  currency: CurrencyCode;
  price: number;
  silhouette: GarmentSilhouette | null;
} | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  const isUSD = /\$|usd/i.test(trimmed);
  const currency: CurrencyCode = isUSD ? 'USD' : 'KRW';

  // Prefer a number written with a currency mark; otherwise take the last number in the line.
  const marked =
    trimmed.match(/[$₩]\s*\d[\d,]*(?:\.\d+)?/) ??
    trimmed.match(/\d[\d,]*(?:\.\d+)?\s*(?:원|krw|usd)\b/i);
  const allNumbers = trimmed.match(/\d[\d,]*(?:\.\d+)?/g);
  const priceText = marked?.[0] ?? allNumbers?.[allNumbers.length - 1] ?? null;
  if (!priceText) return null;

  const numericPrice = Number(priceText.replace(/[$₩,\s]|원|krw|usd/gi, ''));
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return null;

  const textWithoutPrice = trimmed
    .replace(priceText, '')
    .replace(/\b(SSENSE|KREAM|Musinsa|Farfetch|Grailed|Bunjang|Karrot)\b/gi, '')
    .trim();

  const tokens = textWithoutPrice.split(/\s+/).filter(Boolean);
  const brand = tokens[0] ? tokens[0].toUpperCase() : '';
  const name = tokens.slice(1).join(' ');

  const lower = trimmed.toLowerCase();
  let silhouette: GarmentSilhouette | null = null;
  if (/coat|overcoat|코트/.test(lower)) silhouette = 'overcoat';
  else if (/blazer|jacket|블레이저|재킷/.test(lower)) silhouette = 'blazer';
  else if (/blouson|leather|블루종|가죽/.test(lower)) silhouette = 'blouson';
  else if (/knit|sweater|cardigan|니트|가디건/.test(lower)) silhouette = 'knit';
  else if (/hoodie|sweatshirt|후디/.test(lower)) silhouette = 'hoodie';
  else if (/tee|shirt|티셔츠|셔츠/.test(lower)) silhouette = 'tee';

  return {
    brand,
    name,
    currency,
    price: numericPrice,
    silhouette,
  };
}

/**
 * Price records of ONE series: the same platform and the same kind (trade or ask) as the latest
 * price on record. Different platforms or kinds are never joined into one line.
 */
export interface SameSeriesSparkline {
  /** 'series' = 2+ records (a change can be shown); 'single' = 1 record; 'none' = no price on record. */
  status: 'series' | 'single' | 'none';
  platform: ResalePlatform | null;
  kind: 'traded' | 'listed' | null;
  points: { date: string; price: number; isSample: boolean }[];
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  deltaAmount: number | null;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'same' | null;
}

export function computeSameSeriesSparkline(piece: GarmentPiece): SameSeriesSparkline {
  const latest = getLatestObservation(piece);
  if (!latest) {
    return {
      status: 'none',
      platform: null,
      kind: null,
      points: [],
      count: 0,
      firstDate: null,
      lastDate: null,
      deltaAmount: null,
      deltaPct: null,
      direction: null,
    };
  }
  const series = sortObservationsChronologically(
    piece.observations.filter(
      (o) =>
        o.currency === piece.currency &&
        o.price > 0 &&
        o.platform === latest.platform &&
        o.kind === latest.kind,
    ),
  );
  const points = series.map((o) => ({
    date: o.date,
    price: o.price,
    isSample: o.isSample === true,
  }));
  const first = series[0];
  const last = series[series.length - 1];
  const base = {
    platform: latest.platform,
    kind: latest.kind,
    points,
    count: series.length,
    firstDate: first?.date ?? null,
    lastDate: last?.date ?? null,
  };
  if (series.length < 2) {
    return {
      ...base,
      status: 'single',
      deltaAmount: null,
      deltaPct: null,
      direction: null,
    };
  }
  const deltaAmount = last.price - first.price;
  const deltaPct =
    first.price > 0 ? Math.round((deltaAmount / first.price) * 1000) / 10 : null;
  return {
    ...base,
    status: 'series',
    deltaAmount,
    deltaPct,
    direction: deltaAmount > 0 ? 'up' : deltaAmount < 0 ? 'down' : 'same',
  };
}

export type RotationHeatTier = 'cool' | 'warm' | 'hot' | 'no-log';

export interface GarmentRotationHeat {
  /** null when there is no wear log: missing records are unknown, never 0 wears. */
  wearsLast60Days: number | null;
  heatScore: number; // 0..1 continuous scale (0 with no wear log)
  tier: RotationHeatTier;
  label:
    | 'Cold · 0–2 wears in 60d'
    | 'Warm · 3–5 wears in 60d'
    | 'Hot · 6+ wears in 60d'
    | 'No wear log';
  shortLabel: 'Cold' | 'Warm' | 'Hot' | 'no log';
  heatColorHex: string; // interpolated hex from Cool Blue (#3B82F6) -> Warm Amber (#F59E0B) -> Hot Orange (#F37021)
  tagBgHex: string;
  tagBorderHex: string;
  tagTextHex: string;
}

/**
 * Rotation Heatmap colour for a garment on the 3D Boutique Rail, from the wears LOGGED in the
 * last 60 days: 0–2 Cold (blue), 3–5 Warm (amber), 6+ Hot (orange). A piece without a wear log
 * (or a Sample piece) gets a neutral grey "no log", never a 0-wear Cold.
 */
export function computeGarmentRotationHeat(
  piece: GarmentPiece,
): GarmentRotationHeat {
  if ((piece.wearLogStatus ?? 'verified') !== 'verified' || piece.isSample) {
    return {
      wearsLast60Days: null,
      heatScore: 0,
      tier: 'no-log',
      label: 'No wear log',
      shortLabel: 'no log',
      heatColorHex: '#A8A29E',
      tagBgHex: '#FAF8F5',
      tagBorderHex: '#D6D3D1',
      tagTextHex: '#57534E',
    };
  }

  const wears = Math.max(0, piece.wearsLast60Days);
  const heatScore = Math.max(0, Math.min(1, wears / 9));

  // Interpolate RGB from Cool Blue (#3B82F6: 59,130,246) -> Warm Amber (#F59E0B: 245,158,11) -> Hot Orange (#F37021: 243,112,33)
  let r = 59;
  let g = 130;
  let b = 246;
  if (heatScore <= 0.5) {
    const t = heatScore / 0.5;
    r = Math.round(59 + (245 - 59) * t);
    g = Math.round(130 + (158 - 130) * t);
    b = Math.round(246 + (11 - 246) * t);
  } else {
    const t = (heatScore - 0.5) / 0.5;
    r = Math.round(245 + (243 - 245) * t);
    g = Math.round(158 + (112 - 158) * t);
    b = Math.round(11 + (33 - 11) * t);
  }

  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  const heatColorHex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

  if (wears <= 2) {
    return {
      wearsLast60Days: wears,
      heatScore,
      tier: 'cool',
      label: 'Cold · 0–2 wears in 60d',
      shortLabel: 'Cold',
      heatColorHex,
      tagBgHex: '#EFF6FF',
      tagBorderHex: '#60A5FA',
      tagTextHex: '#1E3A8A',
    };
  }

  if (wears <= 5) {
    return {
      wearsLast60Days: wears,
      heatScore,
      tier: 'warm',
      label: 'Warm · 3–5 wears in 60d',
      shortLabel: 'Warm',
      heatColorHex,
      tagBgHex: '#FFFBEB',
      tagBorderHex: '#F59E0B',
      tagTextHex: '#78350F',
    };
  }

  return {
    wearsLast60Days: wears,
    heatScore,
    tier: 'hot',
    label: 'Hot · 6+ wears in 60d',
    shortLabel: 'Hot',
    heatColorHex,
    tagBgHex: '#FFF3EB',
    tagBorderHex: '#F37021',
    tagTextHex: '#9A3412',
  };
}

/** Counts of rotation tiers over non-sample pieces, for the heatmap legend (with its denominator). */
export function countRotationTiers(garments: GarmentPiece[]): {
  cool: number;
  warm: number;
  hot: number;
  noLog: number;
  total: number;
} {
  const counts = { cool: 0, warm: 0, hot: 0, noLog: 0, total: 0 };
  for (const g of garments) {
    if (g.isSample) continue;
    counts.total += 1;
    const tier = computeGarmentRotationHeat(g).tier;
    if (tier === 'no-log') counts.noLog += 1;
    else counts[tier] += 1;
  }
  return counts;
}

/**
 * Where a piece's photo came from, for the provenance strip. Only a scanned piece names a model,
 * and only the one that actually produced its cut-out.
 */
export function describePhotoSource(garment: GarmentPiece): string {
  if (garment.scanMode === 'live' && !garment.scanReceiptId) return 'Prior scan · source unverified';
  if (garment.cutoutSource) {
    const cut = garment.cutoutSource === 'sam-mask' ? 'SAM 3.1 mask' : 'Spark box';
    const mode =
      garment.scanMode === 'live' ? 'LIVE' : 'Test fake · no Meta call';
    return `1 photo · ${cut} · ${mode}`;
  }
  const url = garment.frontImageUrl || garment.imageUrl || '';
  if (!url) return 'No photo · no model call';
  const isBuiltInSvg =
    url.startsWith('data:image/svg+xml') &&
    !garment.id.startsWith('scan-') &&
    !garment.id.startsWith('piece-custom-');
  if (!isBuiltInSvg && (url.startsWith('data:') || url.startsWith('blob:'))) {
    return 'Your photo · no model call';
  }
  return 'Sample photo · no model call';
}

/**
 * Pieces from a photo scan are kept in this browser (localStorage) and come back after a reload;
 * every other piece and decision lives in this tab only and resets to the sample on reload.
 */
export function isKeptAfterReload(garment: GarmentPiece): boolean {
  return garment.id.startsWith('scan-');
}

export type Boutique3DDisplayVariant =
  | 'trouser-clamp'
  | 'glossy-glass-box'
  | 'sartorial-hanger';

export interface Boutique3DDisplayVariantInfo {
  variant: Boutique3DDisplayVariant;
  shortBadge: string;
  fixtureTitle: string;
  specLabel: string;
}

/**
 * Resolves the specialized 3D Boutique Rail display fixture variant for a garment:
 * - 'glossy-glass-box' for items with category 'footwear' or silhouette 'sneaker-box'
 * - 'trouser-clamp' for items with category 'trousers' or silhouette 'trousers'
 * - 'sartorial-hanger' for standard upper garments (overcoats, blazers, hoodies, knits, tees)
 */
export function resolve3DDisplayVariant(
  garment: Pick<GarmentPiece, 'category' | 'silhouette'>,
): Boutique3DDisplayVariantInfo {
  if (
    garment.category === 'footwear' ||
    garment.silhouette === 'sneaker-box'
  ) {
    return {
      variant: 'glossy-glass-box',
      shortBadge: 'Glass Box',
      fixtureTitle: '2-Tier Glossy Glass Collector Box',
      specLabel:
        'Drop-Front Clearcoat Acrylic · 3000K Museum LED · Canted Riser',
    };
  }

  if (garment.category === 'trousers' || garment.silhouette === 'trousers') {
    return {
      variant: 'trouser-clamp',
      shortBadge: 'Clamp Bar',
      fixtureTitle: 'Savile Row Mechanical Trouser Clamp',
      specLabel:
        'Dual-Jaw Walnut Press · Merino Felt Liner · Brass Cam-Lock & Pinch Clips',
    };
  }

  return {
    variant: 'sartorial-hanger',
    shortBadge: 'Hanger',
    fixtureTitle: 'Contoured Walnut & Brass Shoulder Hanger',
    specLabel: 'Sculpted Shoulder Gusset · Champagne Brass Hook',
  };
}
