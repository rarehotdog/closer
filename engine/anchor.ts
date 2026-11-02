// Feature 1 — "오늘은 이 옷": the owner locks one or more items they want to wear; code completes the
// other slots from owned, available items and does not swap a locked item. At most two options:
// the one with the fewest changes from the last plan, and the one that best fits the intent.
import type { IsoDate } from '../shared/dates.ts';
import type { ReasonCode } from '../shared/reasons.ts';
import { seasonHintOf } from './review.ts';
import { SLOTS, type DecisionContext, type Item, type Outfit, type Slot } from '../shared/wardrobe.ts';
import {
  SOFT_RECENT_DAYS, changedSlots, directionMet, exclusionCodes, formalitySum, formalityValue, pinHardConflict, wornWithin,
  type RuleSet, type WardrobeFacts,
} from './rules.ts';

/** Slots an outfit must fill. Outer is optional: an outfit without an outer is still complete. */
export const REQUIRED_SLOTS: readonly Slot[] = ['top', 'bottom', 'shoes'];
/** Enumeration guard; a wardrobe this size is far beyond the sample (9 items). */
const MAX_COMBOS = 20000;

export type AnchorOptionLabel = 'fewest_changes' | 'closest_to_intent' | 'gentler_step';
export type AnchorOption = {
  outfit: Outfit;
  /** Slots that differ from the last plan (empty list if there is no last plan). */
  changedSlots: Slot[];
  sum: number | null;
  label: AnchorOptionLabel;
  reasonLines: string[];
};

export type AnchorResult =
  | { kind: 'options'; options: AnchorOption[]; excluded: { itemId: string; codes: ReasonCode[] }[] }
  /** A locked item breaks an owner rule or is not available: ask instead of a silent swap. */
  | { kind: 'pin_conflict'; itemId: string; codes: ReasonCode[] }
  /** A required slot has no owned, available item that fits. Feature 3 can review one. */
  | { kind: 'gap'; slots: Slot[]; excluded: { itemId: string; codes: ReasonCode[] }[] }
  /** Formality of a candidate is unknown, so the intent cannot be checked: ask once. */
  | { kind: 'ask_formality'; itemId: string }
  | { kind: 'invalid'; code: ReasonCode; detail: string };

export type AnchorInput = {
  anchors: readonly string[];
  ctx: DecisionContext;
  /** Outfit of the most recent plan, used for the "fewest changes" option. */
  last: Outfit | null;
};

type Scored = { outfit: Outfit; sum: number; spread: number; offSeason: number; recent: number; staleness: number; changed: Slot[] };

/** Formality spread inside one outfit: 0 = all the same level. Lower reads as more coherent. */
function spreadOf(outfit: Outfit, facts: WardrobeFacts): number {
  const vals = SLOTS.map((s) => outfit[s]).filter((x): x is string => !!x).map((id) => formalityValue(facts.items.get(id)) ?? 0);
  return Math.max(...vals) - Math.min(...vals);
}

/** Days since last confirmed wear, summed over the non-anchor items (no confirmed wear counts as 60). */
function stalenessOf(outfit: Outfit, anchors: readonly string[], facts: WardrobeFacts, today: IsoDate): number {
  let total = 0;
  for (const s of SLOTS) {
    const id = outfit[s];
    if (!id || anchors.includes(id)) continue;
    const last = facts.lastWorn.get(id);
    total += last ? Math.min(60, Math.max(0, (Date.parse(today) - Date.parse(last)) / 86400000)) : 60;
  }
  return total;
}

function key(o: Outfit): string {
  return SLOTS.map((s) => o[s] ?? '-').join('|');
}

export function planAnchor(input: AnchorInput, facts: WardrobeFacts, today: IsoDate, rules: RuleSet): AnchorResult {
  const { anchors, ctx, last } = input;
  if (anchors.length === 0) return { kind: 'invalid', code: 'INVALID_TRANSITION', detail: 'pick at least one item to keep' };
  const anchorSlots = new Map<Slot, string>();
  for (const id of anchors) {
    const it = facts.items.get(id);
    if (!it) return { kind: 'invalid', code: 'INVALID_TRANSITION', detail: `${id} is not a confirmed item you own` };
    if (anchorSlots.has(it.slot)) return { kind: 'invalid', code: 'INVALID_TRANSITION', detail: `${anchorSlots.get(it.slot)} and ${id} are both ${it.slot}; keep one per slot` };
    anchorSlots.set(it.slot, id);
    const a = facts.availability.get(id) ?? 'AVAILABLE';
    if (rules.availability && a !== 'AVAILABLE') return { kind: 'pin_conflict', itemId: id, codes: [a] };
  }
  const pc = pinHardConflict({ ...ctx, pinned: [...anchors] }, facts, today, rules);
  if (pc) return { kind: 'pin_conflict', itemId: pc.itemId, codes: pc.codes };

  const excluded: { itemId: string; codes: ReasonCode[] }[] = [];
  const candidates = new Map<Slot, (string | null)[]>();
  const gaps: Slot[] = [];
  for (const slot of SLOTS) {
    const fixed = anchorSlots.get(slot);
    if (fixed) {
      candidates.set(slot, [fixed]);
      continue;
    }
    const list: string[] = [];
    for (const it of [...facts.items.values()].filter((x: Item) => x.slot === slot).sort((x, y) => (x.itemId < y.itemId ? -1 : 1))) {
      const codes = exclusionCodes(it, facts, ctx, today, rules);
      if (codes.length > 0) excluded.push({ itemId: it.itemId, codes });
      else list.push(it.itemId);
    }
    if (list.length === 0) {
      if (REQUIRED_SLOTS.includes(slot)) gaps.push(slot);
      candidates.set(slot, [null]);
    } else {
      candidates.set(slot, slot === 'outer' ? [...list, null] : list);
    }
  }
  if (gaps.length > 0) return { kind: 'gap', slots: gaps, excluded };

  // Enumerate complete outfits.
  let combos: Outfit[] = [{}];
  for (const slot of SLOTS) {
    const next: Outfit[] = [];
    for (const o of combos) for (const id of candidates.get(slot)!) next.push(id ? { ...o, [slot]: id } : { ...o });
    combos = next;
    if (combos.length > MAX_COMBOS) return { kind: 'invalid', code: 'INVALID_TRANSITION', detail: `more than ${MAX_COMBOS} combinations; narrow the request` };
  }

  // Direction reference: the last plan when there is one; otherwise an outfit whose every piece
  // sits at the locked pieces' average formality ("the rest more relaxed than the jacket").
  const lastSum = last ? formalitySum(last, facts) : null;
  const anchorVals = anchors.map((id) => formalityValue(facts.items.get(id))).filter((v): v is number => v !== null);
  const anchorAvg = anchorVals.length ? anchorVals.reduce((a, b) => a + b, 0) / anchorVals.length : null;
  const baselineFor = (o: Outfit): number | null => (last ? lastSum : anchorAvg === null ? null : anchorAvg * SLOTS.filter((s) => o[s]).length);
  const scored: Scored[] = [];
  for (const outfit of combos) {
    const sum = formalitySum(outfit, facts);
    if (sum === null) {
      const unknown = SLOTS.map((s) => outfit[s]).find((id) => id && facts.items.get(id)?.formality === 'unknown');
      if (unknown && !anchors.includes(unknown)) return { kind: 'ask_formality', itemId: unknown };
      continue;
    }
    const recent = SLOTS.filter((s) => outfit[s] && !anchors.includes(outfit[s]!) && wornWithin(outfit[s]!, facts, today, SOFT_RECENT_DAYS)).length;
    const offSeason = SLOTS.filter((s) => outfit[s] && !anchors.includes(outfit[s]!) && seasonHintOf(facts.items.get(outfit[s]!)!, today) !== null).length;
    scored.push({ outfit, sum, spread: spreadOf(outfit, facts), offSeason, recent, staleness: stalenessOf(outfit, anchors, facts, today), changed: last ? changedSlots(last, outfit) : [] });
  }
  // Owner-stated direction is compared with the last plan when there is one (the same rule as re-plans).
  const directionOk = (s: Scored) => ctx.direction === 'none' || directionMet(ctx.direction, s.sum, baselineFor(s.outfit));
  const intentPool = scored.filter(directionOk);
  if (intentPool.length === 0) return { kind: 'gap', slots: [], excluded };

  const tie = (a: Scored, b: Scored) => a.offSeason - b.offSeason || a.recent - b.recent || b.staleness - a.staleness || (key(a.outfit) < key(b.outfit) ? -1 : 1);
  // Closest to the intent: the strongest move in the asked direction; with no direction, the most coherent.
  const byIntent = [...intentPool].sort((a, b) =>
    ctx.direction === 'less_formal' ? a.offSeason - b.offSeason || a.sum - b.sum || a.spread - b.spread || tie(a, b)
      : ctx.direction === 'more_formal' ? a.offSeason - b.offSeason || b.sum - a.sum || a.spread - b.spread || tie(a, b)
        : a.spread - b.spread || tie(a, b));
  const intent = byIntent[0];
  const options: { s: Scored; label: AnchorOptionLabel }[] = [];
  if (last) {
    const byChanges = [...intentPool].sort((a, b) => a.changed.length - b.changed.length || a.spread - b.spread || tie(a, b));
    options.push({ s: byChanges[0], label: 'fewest_changes' });
  } else if (ctx.direction === 'less_formal' || ctx.direction === 'more_formal') {
    // No last plan: also offer the smallest step that still meets the direction.
    const gentle = [...intentPool].sort((a, b) =>
      (ctx.direction === 'less_formal' ? b.sum - a.sum : a.sum - b.sum) || a.spread - b.spread || tie(a, b))[0];
    options.push({ s: gentle, label: 'gentler_step' });
  }
  if (!options.some((o) => key(o.s.outfit) === key(intent.outfit))) options.push({ s: intent, label: 'closest_to_intent' });
  options.sort((a, b) => (a.label === 'closest_to_intent' ? 1 : 0) - (b.label === 'closest_to_intent' ? 1 : 0));

  return {
    kind: 'options',
    excluded,
    options: options.map(({ s, label }) => ({
      outfit: s.outfit,
      changedSlots: s.changed,
      sum: s.sum,
      label,
      reasonLines: reasonLines(s, anchors, facts, today, ctx),
    })),
  };
}

function reasonLines(s: Scored, anchors: readonly string[], facts: WardrobeFacts, today: IsoDate, ctx: DecisionContext): string[] {
  const out: string[] = [];
  for (const id of anchors) out.push(`${id} kept · you chose it`);
  if (ctx.direction !== 'none') out.push(`You asked: ${ctx.direction.replace('_', ' ')}`);
  out.push(s.spread === 0 ? 'All pieces are the same formality level' : `Formality levels differ by ${s.spread} step${s.spread > 1 ? 's' : ''}`);
  for (const slot of SLOTS) {
    const id = s.outfit[slot];
    if (!id || anchors.includes(id)) continue;
    const last = facts.lastWorn.get(id);
    out.push(last ? `${id}: last confirmed wear ${last}` : `${id}: no confirmed wear yet`);
  }
  if (!s.outfit.outer) out.push('No outer layer in this option');
  if (s.offSeason > 0) out.push(`${s.offSeason} piece${s.offSeason > 1 ? 's' : ''} may be out of season`);
  if (s.recent > 0) out.push(`${s.recent} item${s.recent > 1 ? 's' : ''} worn in the last ${SOFT_RECENT_DAYS} day`);
  void today;
  return out;
}
