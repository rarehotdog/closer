export type CurrencyCode = 'KRW' | 'USD';

export type ResalePlatform =
  | 'KREAM'
  | 'Karrot'
  | 'Bunjang'
  | 'Musinsa Used'
  | 'Poshmark'
  | 'eBay'
  | 'Grailed'
  | 'Depop'
  | 'StockX'
  | 'Vinted';

export type GarmentCategory =
  | 'outerwear'
  | 'blazer'
  | 'hoodie'
  | 'knitwear'
  | 'shirt'
  | 'trousers';

export type GarmentSilhouette =
  | 'overcoat'
  | 'blazer'
  | 'hoodie'
  | 'blouson'
  | 'knit'
  | 'tee';

export type DecisionChoice = 'keep' | 'sell' | 'undecided';

export type WearLogStatus = 'verified' | 'insufficient';

export interface PriceObservation {
  id: string;
  date: string; // YYYY-MM-DD
  platform: ResalePlatform;
  price: number;
  currency: CurrencyCode;
  kind: 'traded' | 'listed';
  isSample?: boolean;
}

export interface FeeStructure {
  platform: ResalePlatform;
  feeRatePct: number; // e.g. 5.5 for 5.5%
  shippingCost: number;
  /** The owner ticked the platform fee-rate line. Missing = not ticked. */
  feeRateConfirmed?: boolean;
  /** The owner ticked the shipping-cost line. Missing = not ticked. */
  shippingConfirmed?: boolean;
  /** True only when every cost line (fee rate AND shipping) has been ticked by the owner. */
  confirmed: boolean;
}

export interface DecisionRecord {
  id: string;
  choice: 'keep' | 'sell';
  savedAt: string; // ISO date or YYYY-MM-DD HH:mm
  snapshotPrice: number;
  snapshotCurrency: CurrencyCode;
  snapshotPlatform: ResalePlatform;
  note?: string;
}

export interface GarmentPiece {
  id: string;
  code: string; // e.g., J1, J2, T1
  name: string;
  brand: string;
  category: GarmentCategory;
  silhouette: GarmentSilhouette;
  currency: CurrencyCode;
  purchasePrice: number | null;
  isSample: boolean;
  colorHex: string;
  secondaryColorHex: string;
  fabricLabel: string;
  hangerType: 'walnut-brass' | 'brushed-brass' | 'matte-black';
  wearsLast60Days: number;
  wearLogStatus?: WearLogStatus;
  lastWornDate?: string | null; // YYYY-MM-DD or null if insufficient log
  conditionGrade?: 'Mint (S)' | 'Excellent (A+)' | 'Good (A)';
  upcomingOccasions?: string[];
  lockedForToday?: boolean;
  occlusionStatus?: 'front_verified' | 'side_occluded';
  imageUrl?: string;
  frontImageUrl?: string;
  /** Set when the piece came from a photo scan: the image is already a cut-out (SAM mask or Spark box crop). */
  cutoutSource?: 'sam-mask' | 'box-crop';
  /** Which server answered the scan: live Meta models, or the local test fake. */
  scanMode?: 'live' | 'fake';
  observations: PriceObservation[];
  feeConfig: FeeStructure;
  lastDecision?: DecisionRecord;
}

export interface CurrencyLedgerBucket {
  currency: CurrencyCode;
  ownedTotalLatest: number;
  ownedSeenCount: number;
  ownedTotalPieces: number;
  tradedCount: number;
  listedCount: number;
  sampleTotalLatest: number;
  sampleSeenCount: number;
  confirmedNetTotal: number;
  confirmedNetCount: number;
}

export interface LedgerSummary {
  krw: CurrencyLedgerBucket;
  usd: CurrencyLedgerBucket;
  totalOwnedPieces: number;
  totalSamplePieces: number;
  factsMovedIds: string[];
  keepCount: number;
  sellCount: number;
  undecidedCount: number;
}

export interface TargetLook {
  id: string;
  title: string;
  occasion: string;
  pieceIds: string[];
}
