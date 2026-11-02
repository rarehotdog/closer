// Wardrobe vocabulary shared by engine, store, adapters and fixtures.
import type { AvailabilityState, Ownership } from './states.ts';

/** Slot rule (§3-5): outer · top · bottom · shoes, at most one item each. */
export const SLOTS = ['outer', 'top', 'bottom', 'shoes'] as const;
export type Slot = (typeof SLOTS)[number];

/** Code issues item IDs: slot prefix + lowest free number (J1, T1, B1, S1 …). */
export const SLOT_ID_PREFIX: Record<Slot, string> = { outer: 'J', top: 'T', bottom: 'B', shoes: 'S' };

/** Garment type enum Spark 1 must use; code maps type → slot. */
export const GARMENT_TYPES = {
  jacket: 'outer',
  coat: 'outer',
  dress_shirt: 'top',
  knit: 'top',
  tee: 'top',
  trousers: 'bottom',
  jeans: 'bottom',
  chinos: 'bottom',
  derby: 'shoes',
  sneakers: 'shoes',
  // Added 11/2 for looks by occasion (feature 3): wedding-guest and workout pieces.
  track_jacket: 'outer',
  blouse: 'top',
  training_top: 'top',
  skirt: 'bottom',
  joggers: 'bottom',
  shorts: 'bottom',
  running_shoes: 'shoes',
  loafers: 'shoes',
} as const satisfies Record<string, Slot>;
export type GarmentType = keyof typeof GARMENT_TYPES;
export function isGarmentType(x: unknown): x is GarmentType {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(GARMENT_TYPES, x);
}

export const FORMALITY_LEVELS = ['low', 'mid', 'high', 'unknown'] as const;
export type Formality = (typeof FORMALITY_LEVELS)[number];
export const KNOWN_FORMALITY = ['low', 'mid', 'high'] as const;
export type KnownFormality = (typeof KNOWN_FORMALITY)[number];
/** Direction check compares sums of these values (§3-5 "격식 합 비교"). */
export const FORMALITY_VALUE: Record<KnownFormality, number> = { low: 1, mid: 2, high: 3 };

export const DIRECTIONS = ['less_formal', 'more_formal', 'warmer', 'cooler', 'none'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const OFFENDER_WHY = ['too_formal', 'too_casual', 'color_clash', 'weather'] as const;
export type OffenderWhy = (typeof OFFENDER_WHY)[number];

/** 12 named colors for the mask color re-measure (§3-3, count is [가정]). */
export const COLOR_FAMILIES = [
  'black', 'charcoal', 'gray', 'white', 'beige', 'brown',
  'navy', 'blue', 'green', 'red', 'yellow', 'pink',
] as const;
export type ColorFamily = (typeof COLOR_FAMILIES)[number] | 'unknown';
export function isColorFamily(x: unknown): x is ColorFamily {
  return x === 'unknown' || (typeof x === 'string' && (COLOR_FAMILIES as readonly string[]).includes(x));
}

export type Item = {
  itemId: string;
  slot: Slot;
  type: GarmentType;
  color: ColorFamily;
  formality: Formality;
  ownership: Ownership;
  /** Reference to the mask cutout (operation + SAM object id), or null for seeded samples. */
  cutoutRef: string | null;
  /** 'seed' = sample wardrobe item inserted with the workspace (not a confirmation event). */
  origin: 'photo' | 'seed';
  /** null = not known. Needed by the rain hard rule (FX-E8). */
  waterproof: boolean | null;
  /** Shown with the 'Sample item' chip. */
  sample: boolean;
};

export type Outfit = Partial<Record<Slot, string>>;

export type HardRule =
  | { kind: 'waterproof_outer_if_rain'; minRainPct: number }
  | { kind: 'exclude_item'; itemId: string }
  | { kind: 'exclude_worn_within_days'; days: number };

export type Offender = { itemId: string; why: OffenderWhy };

/** Decision context (plans.context in the ledger contract, plus the baseline outfit). */
export type DecisionContext = {
  /** The outfit the owner started from (photo outfit, or the previous decision's baseline). */
  baseline: Outfit;
  pinned: string[];
  direction: Direction;
  offenders: Offender[];
  hardRules: HardRule[];
  weather: { rainPct: number } | null;
};

export type AvailabilityMap = ReadonlyMap<string, AvailabilityState>;
