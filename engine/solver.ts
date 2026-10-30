// Per-slot candidate lists, soft ranking, and the code solver (§3-5). The solver is used for
// feasibility checks before any Spark 2 call, for button re-plans (no model call), and as the
// 'Reason by code' path when Spark 2 is cut (G3 #5).
import type { ReasonCode } from '../shared/reasons.ts';
import type { IsoDate } from '../shared/dates.ts';
import {
  FORMALITY_VALUE, SLOTS,
  type DecisionContext, type Direction, type Formality, type Outfit, type Slot,
} from '../shared/wardrobe.ts';
import {
  allowedSlots, exclusionCodes, formalitySum, offenderSlots, pinnedSlots, softCodes,
  type RuleSet, type WardrobeFacts,
} from './rules.ts';

export type RankedCandidate = { itemId: string; formality: Formality; rank: number; soft: ReasonCode[] };
export type Exclusion = { itemId: string; codes: ReasonCode[] };
export type SlotPlan = { slot: Slot; current: string; ranked: RankedCandidate[]; excluded: Exclusion[] };

/** Everything the solver needs. Also the shape of the candidate facts sent to Spark 2. */
export type SolverInput = {
  current: Outfit;
  reference: Outfit;
  baselineSum: number | null;
  direction: Direction;
  changeable: Slot[];
  forced: Slot[];
  /** Tie-break order: offender order first, then the fixed slot order. */
  slotOrder: Slot[];
  slots: SlotPlan[];
};

export type SolverOption = {
  outfit: Outfit;
  changes: { slot: Slot; from: string; to: string }[];
  changedSlots: Slot[];
  sum: number;
  rankSum: number;
};

export type ChooseResult = {
  options: SolverOption[];
  /** Items that would work except for the direction (used for the relaxation question). */
  directionOnlyMisses: string[];
};

function directionKey(direction: Direction, f: Formality): number {
  const v = f === 'unknown' ? null : FORMALITY_VALUE[f];
  if (direction === 'less_formal') return v ?? 99;
  if (direction === 'more_formal') return v === null ? 99 : -v;
  return 0;
}

/**
 * Rank one slot. Base order: the current item first (keeping is the default), then the rest by
 * direction fit, then itemId. Soft rule: an item worn within SOFT_RECENT_DAYS moves one step down
 * (not excluded). An item with no wear record gets no bonus (AT-26).
 */
export function rankSlot(
  slot: Slot,
  currentId: string,
  ctx: DecisionContext,
  facts: WardrobeFacts,
  today: IsoDate,
  rules: RuleSet,
): SlotPlan {
  const inSlot = [...facts.items.values()].filter((it) => it.slot === slot).sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  const excluded: Exclusion[] = [];
  const pool = [];
  for (const it of inSlot) {
    const codes = exclusionCodes(it, facts, ctx, today, rules);
    if (codes.length > 0) excluded.push({ itemId: it.itemId, codes });
    else pool.push(it);
  }
  const current = pool.filter((it) => it.itemId === currentId);
  const rest = pool
    .filter((it) => it.itemId !== currentId)
    .sort((a, b) => directionKey(ctx.direction, a.formality) - directionKey(ctx.direction, b.formality) || (a.itemId < b.itemId ? -1 : 1));
  const keyed = [...current, ...rest].map((it, i) => {
    const soft = softCodes(it, facts, today);
    return { it, soft, key: i + (soft.includes('WORN_RECENTLY') ? 1.5 : 0) };
  });
  keyed.sort((a, b) => a.key - b.key);
  return {
    slot,
    current: currentId,
    ranked: keyed.map((k, rank) => ({ itemId: k.it.itemId, formality: k.it.formality, rank, soft: k.soft })),
    excluded,
  };
}

export type BuildOptions = { current?: Outfit; only?: Slot[]; forced?: Slot[] };

export function buildSolverInput(
  ctx: DecisionContext,
  facts: WardrobeFacts,
  today: IsoDate,
  rules: RuleSet,
  opts: BuildOptions = {},
): SolverInput {
  const current = opts.current ?? ctx.baseline;
  const present = SLOTS.filter((s) => current[s]);
  const pinned = pinnedSlots(ctx, facts, rules);
  const forced = opts.forced ?? [];
  let changeable: Slot[];
  if (opts.only) changeable = present.filter((s) => opts.only!.includes(s));
  else changeable = present.filter((s) => allowedSlots(ctx, facts).includes(s) && !pinned.includes(s));
  const off = offenderSlots(ctx, facts);
  const slotOrder = [...off, ...SLOTS.filter((s) => !off.includes(s))];
  return {
    current,
    reference: ctx.baseline,
    baselineSum: formalitySum(ctx.baseline, facts),
    direction: ctx.direction,
    changeable,
    forced,
    slotOrder,
    slots: present.map((s) => rankSlot(s, current[s]!, ctx, facts, today, rules)),
  };
}

function valueOf(f: Formality): number | null {
  return f === 'unknown' ? null : FORMALITY_VALUE[f];
}

function dirStrength(direction: Direction, sum: number): number {
  if (direction === 'less_formal') return sum;
  if (direction === 'more_formal') return -sum;
  return 0;
}

function directionOk(direction: Direction, sum: number, base: number): boolean {
  if (direction === 'none') return true;
  if (direction === 'less_formal') return sum < base;
  if (direction === 'more_formal') return sum > base;
  return false; // warmer / cooler: not checkable by code with the frozen roles
}

function cmp(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Choose at most two options from the candidate lists: A = fewest changes (then best rank, then
 * strongest direction, then offender order); B = strongest direction with at most two changes,
 * only if strictly closer to the request than A.
 */
export function chooseOptions(input: SolverInput): ChooseResult {
  const formalityOf = new Map<string, Formality>();
  for (const sp of input.slots) for (const r of sp.ranked) formalityOf.set(r.itemId, r.formality);

  const lists: { slot: Slot; choices: { id: string; rank: number }[] }[] = input.slots.map((sp) => {
    const isChangeable = input.changeable.includes(sp.slot);
    const curRanked = sp.ranked.find((r) => r.itemId === sp.current);
    if (!isChangeable) {
      // Fixed slot: keep the current item; if it is excluded, nothing is valid.
      return { slot: sp.slot, choices: curRanked ? [{ id: sp.current, rank: curRanked.rank }] : [] };
    }
    let choices = sp.ranked.map((r) => ({ id: r.itemId, rank: r.rank }));
    if (input.forced.includes(sp.slot)) choices = choices.filter((c) => c.id !== sp.current);
    return { slot: sp.slot, choices };
  });

  type Combo = { outfit: Outfit; rankSum: number };
  let combos: Combo[] = [{ outfit: {}, rankSum: 0 }];
  for (const l of lists) {
    const next: Combo[] = [];
    for (const c of combos) for (const ch of l.choices) next.push({ outfit: { ...c.outfit, [l.slot]: ch.id }, rankSum: c.rankSum + ch.rank });
    combos = next;
  }

  const valid: (SolverOption & { strength: number; orderKey: number; key: string })[] = [];
  const misses: string[] = [];
  for (const c of combos) {
    const changed = SLOTS.filter((s) => (c.outfit[s] ?? null) !== (input.current[s] ?? null));
    const refChanged = SLOTS.filter((s) => (c.outfit[s] ?? null) !== (input.reference[s] ?? null));
    if (changed.length === 0 || changed.length > 2) continue;
    let sum = 0;
    let known = true;
    for (const s of SLOTS) {
      const id = c.outfit[s];
      if (!id) continue;
      const v = valueOf(formalityOf.get(id) ?? 'unknown');
      if (v === null) known = false;
      else sum += v;
    }
    if (!known || input.baselineSum === null) continue;
    if (!directionOk(input.direction, sum, input.baselineSum)) {
      for (const s of changed) {
        const id = c.outfit[s]!;
        if (!misses.includes(id)) misses.push(id);
      }
      continue;
    }
    if (refChanged.length === 0) continue; // NO_CHANGE against the decision baseline
    const orderKey = Math.min(...changed.map((s) => input.slotOrder.indexOf(s)));
    valid.push({
      outfit: c.outfit,
      changes: changed.map((s) => ({ slot: s, from: input.current[s]!, to: c.outfit[s]! })),
      changedSlots: changed,
      sum,
      rankSum: c.rankSum,
      strength: dirStrength(input.direction, sum),
      orderKey,
      key: SLOTS.map((s) => c.outfit[s] ?? '-').join('|'),
    });
  }
  if (valid.length === 0) return { options: [], directionOnlyMisses: misses };

  const byA = [...valid].sort((x, y) => cmp([x.changedSlots.length, x.rankSum, x.strength, x.orderKey, x.key], [y.changedSlots.length, y.rankSum, y.strength, y.orderKey, y.key]));
  const a = byA[0];
  const byB = valid
    .filter((v) => v.key !== a.key && v.changedSlots.length <= 2)
    .sort((x, y) => cmp([x.strength, x.changedSlots.length, x.rankSum, x.orderKey, x.key], [y.strength, y.changedSlots.length, y.rankSum, y.orderKey, y.key]));
  const strip = (v: (typeof valid)[number]): SolverOption => ({ outfit: v.outfit, changes: v.changes, changedSlots: v.changedSlots, sum: v.sum, rankSum: v.rankSum });
  const options = [strip(a)];
  const b = byB[0];
  if (b && (input.direction === 'none' ? true : b.strength < a.strength)) options.push(strip(b));
  return { options, directionOnlyMisses: misses };
}
