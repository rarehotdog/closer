// Decisive-unknown detection (AT-02): ask only about an unknown attribute whose value changes the
// result. Code enumerates the possible values and compares the solver's options.
import type { IsoDate } from '../shared/dates.ts';
import { KNOWN_FORMALITY, type DecisionContext, type Formality } from '../shared/wardrobe.ts';
import { withFormality, type RuleSet, type WardrobeFacts } from './rules.ts';
import { buildSolverInput, chooseOptions, type BuildOptions } from './solver.ts';

const MAX_JOINT = 4; // 3^4 = 81 assignments at most

function signature(ctx: DecisionContext, facts: WardrobeFacts, today: IsoDate, rules: RuleSet, opts: BuildOptions): string {
  const r = chooseOptions(buildSolverInput(ctx, facts, today, rules, opts));
  return r.options.length === 0 ? 'NO_VALID' : r.options.map((o) => JSON.stringify(o.outfit)).join(';');
}

/** Unknown-formality items that can affect this decision: the current outfit and changeable-slot candidates. */
export function relevantUnknowns(ctx: DecisionContext, facts: WardrobeFacts, today: IsoDate, rules: RuleSet, opts: BuildOptions = {}): string[] {
  const input = buildSolverInput(ctx, facts, today, rules, opts);
  const ids = new Set<string>();
  for (const s of Object.values(ctx.baseline)) if (s) ids.add(s);
  for (const s of Object.values(input.current)) if (s) ids.add(s);
  for (const sp of input.slots) if (input.changeable.includes(sp.slot)) for (const r of sp.ranked) ids.add(r.itemId);
  return [...ids].filter((id) => facts.items.get(id)?.formality === 'unknown').sort();
}

/**
 * Returns the first unknown item (by id) whose value changes the solver result, or null.
 * Unknowns that do not change the result get no question ("나머지 질문 0").
 */
export function decisiveUnknown(ctx: DecisionContext, facts: WardrobeFacts, today: IsoDate, rules: RuleSet, opts: BuildOptions = {}): string | null {
  const unknowns = relevantUnknowns(ctx, facts, today, rules, opts).slice(0, MAX_JOINT);
  if (unknowns.length === 0) return null;
  const assignments: Formality[][] = [[]];
  for (let i = 0; i < unknowns.length; i++) {
    const next: Formality[][] = [];
    for (const a of assignments) for (const v of KNOWN_FORMALITY) next.push([...a, v]);
    assignments.splice(0, assignments.length, ...next);
  }
  const sig = new Map<string, string>();
  for (const a of assignments) {
    const m = new Map<string, Formality>(unknowns.map((id, i) => [id, a[i]]));
    sig.set(a.join(','), signature(ctx, withFormality(facts, m), today, rules, opts));
  }
  for (let u = 0; u < unknowns.length; u++) {
    for (const a of assignments) {
      for (const v of KNOWN_FORMALITY) {
        if (v === a[u]) continue;
        const b = [...a];
        b[u] = v;
        if (sig.get(a.join(',')) !== sig.get(b.join(','))) return unknowns[u];
      }
    }
  }
  return null;
}
