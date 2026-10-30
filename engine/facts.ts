// Fact IDs: a model may cite nothing else as reasons (reasonFactIds must be in this enum), and
// the code that renders them as one-line reasons on screen.
import type { IsoDate } from '../shared/dates.ts';
import { wornRecord } from '../shared/labels.ts';
import type { DecisionContext, Outfit, Slot } from '../shared/wardrobe.ts';
import { SOFT_RECENT_DAYS, wornWithin, type WardrobeFacts } from './rules.ts';

export type Fact = { id: string; line: string };

const DIR_TEXT: Record<string, string> = {
  less_formal: 'You asked: less formal',
  more_formal: 'You asked: more formal',
  warmer: 'You asked: warmer',
  cooler: 'You asked: cooler',
  none: 'No direction given',
};

export function buildFacts(ctx: DecisionContext, facts: WardrobeFacts, today: IsoDate): Fact[] {
  const out: Fact[] = [];
  out.push({ id: `dir:${ctx.direction}`, line: DIR_TEXT[ctx.direction] });
  for (const id of ctx.pinned) out.push({ id: `pin:${id}`, line: `${id} kept · you asked` });
  for (const o of ctx.offenders) out.push({ id: `off:${o.itemId}:${o.why}`, line: `${o.itemId} felt ${o.why.replace('_', ' ')}` });
  for (const it of [...facts.items.values()].sort((a, b) => (a.itemId < b.itemId ? -1 : 1))) {
    out.push({ id: `form:${it.itemId}:${it.formality}`, line: `${it.itemId} formality: ${it.formality}` });
    const last = facts.lastWorn.get(it.itemId);
    if (last && wornWithin(it.itemId, facts, today, SOFT_RECENT_DAYS)) out.push({ id: `wear:${it.itemId}:${last}`, line: wornRecord(it.itemId, last) });
    const a = facts.availability.get(it.itemId);
    if (a && a !== 'AVAILABLE') out.push({ id: `avail:${it.itemId}:${a}`, line: `${it.itemId} is in ${a.toLowerCase()}` });
  }
  return out;
}

/** Facts relevant to one option: direction, offenders/wear/availability of replaced items, formality of new items. */
export function pickReasonFacts(factIds: readonly string[], changes: readonly { slot: Slot; from: string; to: string }[], direction: string): string[] {
  const out: string[] = [];
  const want = (id: string) => {
    if (factIds.includes(id) && !out.includes(id)) out.push(id);
  };
  want(`dir:${direction}`);
  for (const c of changes) {
    for (const f of factIds) {
      if (f.startsWith(`off:${c.from}:`) || f.startsWith(`wear:${c.from}:`) || f.startsWith(`avail:${c.from}:`)) want(f);
    }
    for (const f of factIds) if (f.startsWith(`form:${c.to}:`)) want(f);
  }
  return out;
}

export function renderReasons(ids: readonly string[], all: readonly Fact[]): string[] {
  return ids.map((id) => all.find((f) => f.id === id)?.line).filter((x): x is string => typeof x === 'string');
}

export function outfitItems(o: Outfit): string[] {
  return Object.values(o).filter((x): x is string => typeof x === 'string');
}
