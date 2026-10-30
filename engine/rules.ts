// Rules the code decides (§3-5): ownership·availability, slot rule, owner hard rules, pin,
// changed slots, offender scope, direction (formality sums), zero-change rejection.
import type { ReasonCode } from '../shared/reasons.ts';
import { mergeCodes } from '../shared/reasons.ts';
import type { AvailabilityState } from '../shared/states.ts';
import type { LedgerState } from '../shared/ledger.ts';
import { diffDays, type IsoDate } from '../shared/dates.ts';
import {
  FORMALITY_VALUE, SLOTS,
  type DecisionContext, type Direction, type Item, type Outfit, type Slot,
} from '../shared/wardrobe.ts';

/** Rule switches. Production always uses ALL_RULES; AT-28 builds mutants with one rule removed. */
export type RuleSet = { readonly availability: boolean; readonly pin: boolean };
export const ALL_RULES: RuleSet = Object.freeze({ availability: true, pin: true });

/** Soft recency window: worn within this many days ranks one step lower (§3-5, [가정] 1 day). */
export const SOFT_RECENT_DAYS = 1;

export type WardrobeFacts = {
  items: ReadonlyMap<string, Item>;
  availability: ReadonlyMap<string, AvailabilityState>;
  /** Latest confirmed (not undone) wear date per item. */
  lastWorn: ReadonlyMap<string, IsoDate>;
  wearCount: ReadonlyMap<string, number>;
};

export function factsFromState(state: LedgerState): WardrobeFacts {
  const items = new Map<string, Item>();
  for (const it of state.items) if (it.ownership === 'CONFIRMED') items.set(it.itemId, it);
  const availability = new Map<string, AvailabilityState>();
  for (const a of state.availability) availability.set(a.itemId, a.state);
  const lastWorn = new Map<string, IsoDate>();
  const wearCount = new Map<string, number>();
  for (const w of state.wearRows) {
    for (const id of w.itemIds) {
      wearCount.set(id, (wearCount.get(id) ?? 0) + 1);
      const prev = lastWorn.get(id);
      if (!prev || w.occurredAt > prev) lastWorn.set(id, w.occurredAt);
    }
  }
  return { items, availability, lastWorn, wearCount };
}

export function withFormality(facts: WardrobeFacts, overrides: ReadonlyMap<string, Item['formality']>): WardrobeFacts {
  if (overrides.size === 0) return facts;
  const items = new Map(facts.items);
  for (const [id, f] of overrides) {
    const it = items.get(id);
    if (it) items.set(id, { ...it, formality: f });
  }
  return { ...facts, items };
}

export function formalityValue(item: Item | undefined): number | null {
  if (!item || item.formality === 'unknown') return null;
  return FORMALITY_VALUE[item.formality];
}

export function formalitySum(outfit: Outfit, facts: WardrobeFacts): number | null {
  let sum = 0;
  for (const slot of SLOTS) {
    const id = outfit[slot];
    if (!id) continue;
    const v = formalityValue(facts.items.get(id));
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

/** Direction check by formality sums. warmer/cooler cannot be checked with the frozen roles (no warmth attribute). */
export function directionMet(direction: Direction, sum: number | null, baselineSum: number | null): boolean {
  if (direction === 'none') return true;
  if (sum === null || baselineSum === null) return false;
  if (direction === 'less_formal') return sum < baselineSum;
  if (direction === 'more_formal') return sum > baselineSum;
  return false;
}

export function wornWithin(itemId: string, facts: WardrobeFacts, today: IsoDate, days: number): boolean {
  const d = facts.lastWorn.get(itemId);
  if (!d) return false;
  const age = diffDays(today, d);
  return age >= 0 && age <= days;
}

function rainActive(ctx: DecisionContext, minRainPct: number): boolean {
  return ctx.weather !== null && ctx.weather.rainPct >= minRainPct;
}

/** Owner hard-rule violations of one item (rule-specific codes, used for exclusion records). */
export function hardRuleCodes(item: Item, facts: WardrobeFacts, ctx: DecisionContext, today: IsoDate): ReasonCode[] {
  const out: ReasonCode[] = [];
  for (const r of ctx.hardRules) {
    if (r.kind === 'exclude_item' && r.itemId === item.itemId) out.push('UNREQUESTED_RELAXATION');
    if (r.kind === 'waterproof_outer_if_rain' && item.slot === 'outer' && rainActive(ctx, r.minRainPct) && item.waterproof !== true) {
      out.push('WEATHER_CONFLICT');
    }
    if (r.kind === 'exclude_worn_within_days' && wornWithin(item.itemId, facts, today, r.days)) out.push('WORN_RECENTLY');
  }
  return mergeCodes(out);
}

/** Codes that remove an item from the candidate list (availability + owner hard rules). */
export function exclusionCodes(item: Item, facts: WardrobeFacts, ctx: DecisionContext, today: IsoDate, rules: RuleSet): ReasonCode[] {
  const out: ReasonCode[] = [];
  if (rules.availability) {
    const a = facts.availability.get(item.itemId) ?? 'AVAILABLE';
    if (a !== 'AVAILABLE') out.push(a);
  }
  return mergeCodes(out, hardRuleCodes(item, facts, ctx, today));
}

/** Soft codes: shown, never exclude. */
export function softCodes(item: Item, facts: WardrobeFacts, today: IsoDate): ReasonCode[] {
  return wornWithin(item.itemId, facts, today, SOFT_RECENT_DAYS) ? ['WORN_RECENTLY'] : [];
}

export function slotOf(itemId: string, facts: WardrobeFacts): Slot | null {
  return facts.items.get(itemId)?.slot ?? null;
}

export function pinnedSlots(ctx: DecisionContext, facts: WardrobeFacts, rules: RuleSet): Slot[] {
  if (!rules.pin) return [];
  const out: Slot[] = [];
  for (const id of ctx.pinned) {
    const s = slotOf(id, facts);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Offender slots in the order the offenders were listed (tie-break order for the solver). */
export function offenderSlots(ctx: DecisionContext, facts: WardrobeFacts): Slot[] {
  const out: Slot[] = [];
  for (const o of ctx.offenders) {
    const s = slotOf(o.itemId, facts);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Slots a proposal may change: offender slots; if no offenders (e.g. next plan without photo), any slot. */
export function allowedSlots(ctx: DecisionContext, facts: WardrobeFacts): Slot[] {
  const off = offenderSlots(ctx, facts);
  return off.length > 0 ? off : [...SLOTS];
}

/** Pinned item that an owner hard rule rejects (FX-E8): code asks instead of swapping it. */
export function pinHardConflict(ctx: DecisionContext, facts: WardrobeFacts, today: IsoDate, rules: RuleSet): { itemId: string; codes: ReasonCode[] } | null {
  if (!rules.pin) return null;
  for (const id of ctx.pinned) {
    const it = facts.items.get(id);
    if (!it) continue;
    const codes = hardRuleCodes(it, facts, ctx, today);
    if (codes.length > 0) return { itemId: id, codes };
  }
  return null;
}

export function changedSlots(from: Outfit, to: Outfit): Slot[] {
  return SLOTS.filter((s) => (from[s] ?? null) !== (to[s] ?? null));
}

export type OutfitCheckOptions = {
  /** Outfit the option is compared with for "changed slots" (current plan; = baseline for a first proposal). */
  current: Outfit;
  /** Slots whose change is forced by an availability button (exempt from the offender scope). */
  forced: readonly Slot[];
  /** Formality sum of the decision baseline (direction reference). */
  baselineSum: number | null;
};

/**
 * Full code check of one candidate outfit (a model option or a solver combo). Returns all codes;
 * an empty array means the outfit passes.
 */
export function checkOutfit(
  outfit: Outfit,
  ctx: DecisionContext,
  facts: WardrobeFacts,
  today: IsoDate,
  rules: RuleSet,
  opt: OutfitCheckOptions,
): ReasonCode[] {
  const codes: ReasonCode[] = [];
  for (const slot of SLOTS) {
    const id = outfit[slot];
    if (!id) continue;
    const it = facts.items.get(id);
    if (!it || it.slot !== slot) {
      codes.push('INVALID_MODEL_OUTPUT');
      continue;
    }
    if (rules.availability) {
      const a = facts.availability.get(id) ?? 'AVAILABLE';
      if (a !== 'AVAILABLE') codes.push(a);
    }
    if (hardRuleCodes(it, facts, ctx, today).length > 0) codes.push('UNREQUESTED_RELAXATION');
  }
  if (rules.pin) {
    for (const id of ctx.pinned) {
      const s = slotOf(id, facts);
      if (s && outfit[s] !== id) codes.push('PIN_CONFLICT');
    }
  }
  const changed = changedSlots(opt.current, outfit);
  if (changed.length === 0 || changedSlots(ctx.baseline, outfit).length === 0) codes.push('NO_CHANGE');
  const allowed = allowedSlots(ctx, facts);
  if (changed.some((s) => !allowed.includes(s) && !opt.forced.includes(s))) codes.push('OUTSIDE_OFFENDERS');
  if (changed.length > 2) codes.push('INVALID_MODEL_OUTPUT');
  const sum = formalitySum(outfit, facts);
  if (sum === null || opt.baselineSum === null) codes.push('ATTR_UNKNOWN');
  else if (!directionMet(ctx.direction, sum, opt.baselineSum)) codes.push('FORMALITY_CONFLICT');
  return mergeCodes(codes);
}
