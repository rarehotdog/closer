// FX-H wardrobe — plan v2 §4-5. Nine roles, frozen. On 11/1 only a role → real item table is
// added; expected values do not change. A role with no matching real item is filled by a sample
// photo item with the 'Sample item' chip.
import type { ColorFamily, DecisionContext, GarmentType, Item, KnownFormality, Outfit, Slot } from '../shared/wardrobe.ts';

export type Role = {
  role: string;
  slot: Slot;
  type: GarmentType;
  /** Plan wording (Korean role text in §4-5). */
  description: string;
  color: ColorFamily;
  formality: KnownFormality;
  waterproof: boolean | null;
  /** Code-drawn placeholder color for the sample photos [가정]. */
  rgb: readonly [number, number, number];
};

export const FXH_ROLES: readonly Role[] = [
  { role: 'J1', slot: 'outer', type: 'jacket', description: 'navy tailored jacket (outer, formality high, not waterproof)', color: 'navy', formality: 'high', waterproof: false, rgb: [34, 46, 84] },
  { role: 'T1', slot: 'top', type: 'dress_shirt', description: 'white dress shirt (high)', color: 'white', formality: 'high', waterproof: null, rgb: [238, 238, 232] },
  { role: 'T2', slot: 'top', type: 'knit', description: 'gray crew-neck knit (mid)', color: 'gray', formality: 'mid', waterproof: null, rgb: [130, 130, 134] },
  { role: 'T3', slot: 'top', type: 'tee', description: 'white T-shirt (low)', color: 'white', formality: 'low', waterproof: null, rgb: [244, 243, 238] },
  { role: 'B1', slot: 'bottom', type: 'trousers', description: 'charcoal wool trousers (high)', color: 'charcoal', formality: 'high', waterproof: null, rgb: [58, 61, 67] },
  // "진청 청바지" (dark indigo jeans) → color family 'blue' [가정: 12 named colors have no indigo]
  { role: 'B2', slot: 'bottom', type: 'jeans', description: 'dark indigo jeans (low)', color: 'blue', formality: 'low', waterproof: null, rgb: [46, 80, 150] },
  { role: 'B3', slot: 'bottom', type: 'chinos', description: 'beige chinos (mid)', color: 'beige', formality: 'mid', waterproof: null, rgb: [208, 190, 154] },
  { role: 'S1', slot: 'shoes', type: 'derby', description: 'black derby shoes (high)', color: 'black', formality: 'high', waterproof: null, rgb: [24, 24, 26] },
  { role: 'S2', slot: 'shoes', type: 'sneakers', description: 'white sneakers (low)', color: 'white', formality: 'low', waterproof: null, rgb: [236, 236, 236] },
];

export function role(id: string): Role {
  const r = FXH_ROLES.find((x) => x.role === id);
  if (!r) throw new Error(`unknown FX-H role ${id}`);
  return r;
}

/** Base outfit O0 = J1+T1+B1+S1. */
export const O0: Outfit = { outer: 'J1', top: 'T1', bottom: 'B1', shoes: 'S1' };

/** FX-H intent [가정]: pin J1, direction less_formal, offenders {B1, S1}. */
export const FXH_INTENT: Pick<DecisionContext, 'pinned' | 'direction' | 'offenders'> = {
  pinned: ['J1'],
  direction: 'less_formal',
  offenders: [
    { itemId: 'B1', why: 'too_formal' },
    { itemId: 'S1', why: 'too_formal' },
  ],
};

export const HERO_SENTENCE = 'Keep this jacket. The whole outfit feels too dressed-up for tonight.';

/** Items outside the hero photo (seeded with seedRef under F2, §4-5). */
export const OUTSIDE_PHOTO_ROLES = ['T2', 'T3', 'B2', 'B3', 'S2'] as const;

/** Seed rows for a workspace: sample wardrobe items, not confirmation events. */
export function seedItems(roles: readonly string[]): Item[] {
  return roles.map((id) => {
    const r = role(id);
    return {
      itemId: r.role,
      slot: r.slot,
      type: r.type,
      color: r.color,
      formality: r.formality,
      ownership: 'CONFIRMED',
      cutoutRef: null,
      origin: 'seed',
      waterproof: r.waterproof,
      sample: true,
    };
  });
}
