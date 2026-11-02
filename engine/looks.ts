// Feature 3 — browse looks by occasion and rebuild them from what you own first. Each look piece
// is matched to an owned, available item (same item type and colour, or a similar one); only the
// pieces with no match become optional "review to buy" cards, next to "use what I have", "skip"
// and "later". Buying is a link-out the owner opens; nothing is put in a cart or paid.
import { SLOTS, type ColorFamily, type GarmentType, type Item, type KnownFormality, type Outfit, type Slot } from '../shared/wardrobe.ts';
import { exclusionCodes, formalityValue, type RuleSet, type WardrobeFacts } from './rules.ts';
import type { DecisionContext } from '../shared/wardrobe.ts';
import type { IsoDate } from '../shared/dates.ts';

export const LOOK_CATEGORIES = ['wedding_guest', 'workout', 'office'] as const;
export type LookCategory = (typeof LOOK_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<LookCategory, string> = { wedding_guest: 'Wedding guest', workout: 'Workout', office: 'Office' };

export type ShopLink = {
  /** null until a real product page is checked; the demo never invents one. */
  url: string | null;
  match: 'SAME_ITEM' | 'SIMILAR';
  price: string | null;
  checkedAt: IsoDate | null;
  affiliate: boolean;
};

export type LookPiece = { slot: Slot; type: GarmentType; color: ColorFamily; formality: KnownFormality; label: string; shop: ShopLink };
export type Look = {
  lookId: string;
  category: LookCategory;
  title: string;
  /** Rights: only looks Closer drew or that the owner shared on purpose. */
  credit: string;
  note: string;
  pieces: LookPiece[];
};

const NO_LINK: ShopLink = { url: null, match: 'SIMILAR', price: null, checkedAt: null, affiliate: false };

/** Sample looks drawn for the demo (no real people, no scraped photos). */
export const SAMPLE_LOOKS: readonly Look[] = [
  {
    lookId: 'L-WG1', category: 'wedding_guest', title: 'Autumn wedding guest, navy and charcoal', credit: 'Closer sample look',
    note: 'Follow the dress code on the invitation first.',
    pieces: [
      { slot: 'outer', type: 'jacket', color: 'navy', formality: 'high', label: 'Navy tailored jacket', shop: NO_LINK },
      { slot: 'top', type: 'dress_shirt', color: 'white', formality: 'high', label: 'White dress shirt', shop: NO_LINK },
      { slot: 'bottom', type: 'trousers', color: 'charcoal', formality: 'high', label: 'Charcoal wool trousers', shop: NO_LINK },
      { slot: 'shoes', type: 'loafers', color: 'brown', formality: 'high', label: 'Brown loafers', shop: NO_LINK },
    ],
  },
  {
    lookId: 'L-WG2', category: 'wedding_guest', title: 'Daytime garden wedding, soft and light', credit: 'Closer sample look',
    note: 'Avoid white if the invitation asks guests to.',
    pieces: [
      { slot: 'top', type: 'blouse', color: 'pink', formality: 'mid', label: 'Pink blouse', shop: NO_LINK },
      { slot: 'bottom', type: 'skirt', color: 'beige', formality: 'mid', label: 'Beige midi skirt', shop: NO_LINK },
      { slot: 'shoes', type: 'loafers', color: 'beige', formality: 'mid', label: 'Beige loafers', shop: NO_LINK },
    ],
  },
  {
    lookId: 'L-WO1', category: 'workout', title: 'Easy evening run', credit: 'Closer sample look',
    note: 'Pick running gear by the activity and the product specs, not by a photo.',
    pieces: [
      { slot: 'outer', type: 'track_jacket', color: 'black', formality: 'low', label: 'Black track jacket', shop: NO_LINK },
      { slot: 'top', type: 'training_top', color: 'gray', formality: 'low', label: 'Gray training top', shop: NO_LINK },
      { slot: 'bottom', type: 'shorts', color: 'black', formality: 'low', label: 'Black running shorts', shop: NO_LINK },
      { slot: 'shoes', type: 'running_shoes', color: 'white', formality: 'low', label: 'White running shoes', shop: NO_LINK },
    ],
  },
  {
    lookId: 'L-OF1', category: 'office', title: 'Smart casual office day', credit: 'Closer sample look',
    note: 'A knit keeps a jacket look relaxed.',
    pieces: [
      { slot: 'outer', type: 'jacket', color: 'navy', formality: 'high', label: 'Navy jacket', shop: NO_LINK },
      { slot: 'top', type: 'knit', color: 'gray', formality: 'mid', label: 'Gray knit', shop: NO_LINK },
      { slot: 'bottom', type: 'chinos', color: 'beige', formality: 'mid', label: 'Beige chinos', shop: NO_LINK },
      { slot: 'shoes', type: 'sneakers', color: 'white', formality: 'low', label: 'White sneakers', shop: NO_LINK },
    ],
  },
];

export type PieceMatch = {
  piece: LookPiece;
  /** SAME: same type and colour · SIMILAR: same type, or same colour and formality in the slot · NONE */
  level: 'SAME' | 'SIMILAR' | 'NONE';
  itemId: string | null;
  why: string;
  /** Other owned items in the slot the owner could use instead (closest first). */
  alternatives: string[];
};

export type GapCard = {
  piece: LookPiece;
  /** Complete, coherent outfits the wardrobe gains if this one piece is added (counted, not estimated). */
  outfitsAdded: number;
  alternatives: string[];
  choices: ('use_mine' | 'skip' | 'later' | 'open_link')[];
};

export type LookMatch = {
  lookId: string;
  title: string;
  category: LookCategory;
  pieces: PieceMatch[];
  reused: number;
  missing: number;
  /** The look rebuilt from owned items (SAME or SIMILAR only); feed it to feature 1 as locks. */
  ownOutfit: Outfit;
  gaps: GapCard[];
  /** "Buy the whole look" list, kept separate from the default "rebuild with mine". */
  fullLook: { label: string; shop: ShopLink }[];
  basis: string;
};

function usable(facts: WardrobeFacts, ctx: DecisionContext, today: IsoDate, rules: RuleSet): Item[] {
  return [...facts.items.values()]
    .filter((it) => exclusionCodes(it, facts, ctx, today, rules).length === 0)
    .sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
}

function closeness(p: LookPiece, it: Item): number {
  let s = 0;
  if (it.type === p.type) s += 4;
  if (it.color === p.color) s += 2;
  const f = formalityValue(it);
  if (f !== null) s += 2 - Math.min(2, Math.abs(f - formalityValue({ ...it, formality: p.formality })!));
  return s;
}

export function matchLook(look: Look, facts: WardrobeFacts, ctx: DecisionContext, today: IsoDate, rules: RuleSet): LookMatch {
  const pool = usable(facts, ctx, today, rules);
  const used = new Set<string>();
  const pieces: PieceMatch[] = look.pieces.map((p) => {
    const inSlot = pool.filter((it) => it.slot === p.slot && !used.has(it.itemId)).sort((a, b) => closeness(p, b) - closeness(p, a) || (a.itemId < b.itemId ? -1 : 1));
    const same = inSlot.find((it) => it.type === p.type && it.color === p.color);
    const similar = inSlot.find((it) => it.type === p.type || (it.color === p.color && it.formality === p.formality));
    const pick = same ?? similar ?? null;
    if (pick) used.add(pick.itemId);
    const level: PieceMatch['level'] = same ? 'SAME' : similar ? 'SIMILAR' : 'NONE';
    const why = same ? `${pick!.itemId} is the same kind and colour`
      : similar ? (similar.type === p.type ? `${pick!.itemId} is the same kind in ${pick!.color}` : `${pick!.itemId} matches the colour and formality`)
      : inSlot.length > 0 ? `Nothing close in ${p.slot}; ${inSlot[0].itemId} is the nearest you own` : `You have no available ${p.slot} item`;
    return { piece: p, level, itemId: pick?.itemId ?? null, why, alternatives: inSlot.filter((it) => it.itemId !== pick?.itemId).slice(0, 2).map((it) => it.itemId) };
  });
  const ownOutfit: Outfit = {};
  for (const m of pieces) if (m.itemId) ownOutfit[m.piece.slot] = m.itemId;
  const base = countOutfits(pool);
  const gaps: GapCard[] = pieces.filter((m) => m.level === 'NONE').map((m) => {
    const hypo: Item = { itemId: `NEW-${m.piece.slot}`, slot: m.piece.slot, type: m.piece.type, color: m.piece.color, formality: m.piece.formality, ownership: 'CONFIRMED', cutoutRef: null, origin: 'seed', waterproof: null, sample: true };
    const alternatives = m.alternatives.length > 0 ? m.alternatives : pool.filter((it) => it.slot === m.piece.slot).slice(0, 2).map((it) => it.itemId);
    return {
      piece: m.piece,
      outfitsAdded: countOutfits([...pool, hypo]) - base,
      alternatives,
      choices: [...(alternatives.length > 0 ? ['use_mine' as const] : []), 'skip' as const, 'later' as const, 'open_link' as const],
    };
  });
  return {
    lookId: look.lookId, title: look.title, category: look.category, pieces,
    reused: pieces.filter((m) => m.level !== 'NONE').length,
    missing: gaps.length,
    ownOutfit, gaps,
    fullLook: look.pieces.map((p) => ({ label: p.label, shop: p.shop })),
    basis: `Counted on the ${pool.length} available items in this wardrobe`,
  };
}

/**
 * Coherent outfits: top, bottom and shoes (outer optional), formality levels at most one step
 * apart. A plain count on the items given, used to compare "with" and "without" a new piece.
 */
export function countOutfits(items: readonly Item[]): number {
  const by = (s: Slot) => items.filter((it) => it.slot === s && it.formality !== 'unknown');
  const outers: (Item | null)[] = [null, ...by('outer')];
  let n = 0;
  for (const o of outers) for (const t of by('top')) for (const b of by('bottom')) for (const s of by('shoes')) {
    const vals = [o, t, b, s].filter((x): x is Item => !!x).map((x) => formalityValue(x)!);
    if (Math.max(...vals) - Math.min(...vals) <= 1) n++;
  }
  return n;
}

export function lookById(id: string): Look | null {
  return SAMPLE_LOOKS.find((l) => l.lookId === id) ?? null;
}

void SLOTS;
