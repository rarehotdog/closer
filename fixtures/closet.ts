// Sample closet for features 2 and 3: the nine FX-H roles plus three extra pieces, and a synthetic
// wear history over the last 75 days. Everything here is sample data and is labelled so on screen.
import { addDays, type IsoDate } from '../shared/dates.ts';
import type { Item } from '../shared/wardrobe.ts';
import type { Evidence } from '../engine/market.ts';
import { FXH_ROLES, seedItems } from './fxh.ts';

export const SAMPLE_CLOSET_ID = 'sample-closet';
export const HISTORY_DAYS = 75;

const extra = (itemId: string, slot: Item['slot'], type: Item['type'], color: Item['color'], formality: Item['formality'], waterproof: boolean | null = null): Item => ({
  itemId, slot, type, color, formality, ownership: 'CONFIRMED', cutoutRef: null, origin: 'seed', waterproof, sample: true,
});

/** J2 camel coat (dormant), J3 black track jacket, B4 black shorts. */
export function closetItems(): Item[] {
  return [
    ...seedItems(FXH_ROLES.map((r) => r.role)),
    extra('J2', 'outer', 'coat', 'beige', 'high', false),
    extra('J3', 'outer', 'track_jacket', 'black', 'low', true),
    extra('B4', 'bottom', 'shorts', 'black', 'low'),
  ];
}

/**
 * Wear history: a record on 3 of every 4 days. J1 and B3 are never recorded (they become review
 * candidates); B2 and S2 are worn often. Deterministic so tests and screenshots agree.
 */
export function closetHistory(today: IsoDate): { occurredAt: IsoDate; itemIds: string[] }[] {
  const rotations: string[][] = [
    ['T2', 'B2', 'S2'], ['T1', 'B1', 'S1'], ['T3', 'B2', 'S2'], ['J3', 'T3', 'B4', 'S2'],
    ['T2', 'B1', 'S1'], ['T3', 'B2', 'S2'],
  ];
  const out: { occurredAt: IsoDate; itemIds: string[] }[] = [];
  let k = 0;
  for (let d = HISTORY_DAYS; d >= 1; d--) {
    if (d % 4 === 0) continue;
    out.push({ occurredAt: addDays(today, -d), itemIds: rotations[k++ % rotations.length] });
  }
  return out;
}

/** Sample price rows for the demo. Shown with the Sample chip; not real market data. */
export function sampleEvidence(today: IsoDate): Evidence[] {
  const base = { url: null, retrievedAt: today, size: 'M', condition: 'good', source: 'sample' as const };
  return [
    { ...base, evidenceId: 'sample-1', itemId: 'J1', platform: 'KARROT', priceType: 'ASK', amount: 85000, currency: 'KRW', matchLevel: 'SIMILAR' },
    { ...base, evidenceId: 'sample-2', itemId: 'J1', platform: 'KARROT', priceType: 'ASK', amount: 120000, currency: 'KRW', matchLevel: 'SIMILAR' },
    { ...base, evidenceId: 'sample-3', itemId: 'J1', platform: 'POSHMARK', priceType: 'ASK', amount: 68, currency: 'USD', matchLevel: 'UNVERIFIED' },
    { ...base, evidenceId: 'sample-4', itemId: 'J2', platform: 'KARROT', priceType: 'ASK', amount: 60000, currency: 'KRW', matchLevel: 'SIMILAR' },
  ];
}
