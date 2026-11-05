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

/** Sample price rows for the demo, spread over the last four weeks so the price chart has a shape. Shown with the Sample chip; not real market data. */
export function sampleEvidence(today: IsoDate): Evidence[] {
  const base = { url: null, size: 'M', condition: 'good', source: 'sample' as const };
  return [
    { ...base, evidenceId: 'sample-1', itemId: 'J1', platform: 'KARROT', priceType: 'ASK', amount: 85000, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: addDays(today, -21) },
    { ...base, evidenceId: 'sample-2', itemId: 'J1', platform: 'KARROT', priceType: 'ASK', amount: 120000, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: addDays(today, -3) },
    { ...base, evidenceId: 'sample-3', itemId: 'J1', platform: 'POSHMARK', priceType: 'ASK', amount: 68, currency: 'USD', matchLevel: 'UNVERIFIED', retrievedAt: addDays(today, -9) },
    { ...base, evidenceId: 'sample-4', itemId: 'J2', platform: 'KARROT', priceType: 'ASK', amount: 60000, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: addDays(today, -12) },
    { ...base, evidenceId: 'sample-5', itemId: 'J1', platform: 'KARROT', priceType: 'TRADE', amount: 90000, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: addDays(today, -10) },
    { ...base, evidenceId: 'sample-6', itemId: 'J2', platform: 'KARROT', priceType: 'ASK', amount: 55000, currency: 'KRW', matchLevel: 'SIMILAR', retrievedAt: addDays(today, -26) },
    { ...base, evidenceId: 'sample-7', itemId: 'J2', platform: 'BUNJANG', priceType: 'ASK', amount: 58000, currency: 'KRW', matchLevel: 'UNVERIFIED', retrievedAt: addDays(today, -6) },
  ];
}

/**
 * Extended multi-date, multi-platform sample observations for the interactive 3D sample closet UI.
 * Every row is strictly marked `source: 'sample'` and kept separate from owner-entered totals.
 */
export function showcaseSampleEvidence(today: IsoDate): Evidence[] {
  const base = { url: null, size: 'M', condition: 'good', source: 'sample' as const };
  const extraRows: Array<[string, string, Evidence['platform'], Evidence['priceType'], number, Evidence['currency'], Evidence['matchLevel'], number]> = [
    ['sample-8', 'J1', 'KARROT', 'TRADE', 78000, 'KRW', 'SIMILAR', -48],
    ['sample-9', 'J1', 'KREAM', 'TRADE', 112000, 'KRW', 'SAME_ITEM', -34],
    ['sample-10', 'J1', 'KREAM', 'TRADE', 124000, 'KRW', 'SAME_ITEM', -16],
    ['sample-11', 'J1', 'KREAM', 'ASK', 135000, 'KRW', 'SAME_ITEM', -2],
    ['sample-12', 'J1', 'BUNJANG', 'ASK', 115000, 'KRW', 'SIMILAR', -7],
    ['sample-13', 'J1', 'GRAILED', 'ASK', 86, 'USD', 'SIMILAR', -4],

    ['sample-14', 'J2', 'KREAM', 'TRADE', 158000, 'KRW', 'SAME_ITEM', -52],
    ['sample-15', 'J2', 'KREAM', 'TRADE', 172000, 'KRW', 'SAME_ITEM', -29],
    ['sample-16', 'J2', 'KREAM', 'TRADE', 186000, 'KRW', 'SAME_ITEM', -11],
    ['sample-17', 'J2', 'KREAM', 'ASK', 198000, 'KRW', 'SAME_ITEM', -2],
    ['sample-18', 'J2', 'MUSINSA_USED', 'ASK', 182000, 'KRW', 'SIMILAR', -8],

    ['sample-19', 'J3', 'KREAM', 'TRADE', 84000, 'KRW', 'SAME_ITEM', -44],
    ['sample-20', 'J3', 'KREAM', 'ASK', 92000, 'KRW', 'SAME_ITEM', -21],
    ['sample-21', 'J3', 'KREAM', 'TRADE', 99000, 'KRW', 'SAME_ITEM', -4],
    ['sample-22', 'J3', 'BUNJANG', 'ASK', 94000, 'KRW', 'SIMILAR', -9],

    ['sample-23', 'T1', 'MUSINSA_USED', 'ASK', 41000, 'KRW', 'SAME_ITEM', -41],
    ['sample-24', 'T1', 'MUSINSA_USED', 'TRADE', 45000, 'KRW', 'SAME_ITEM', -19],
    ['sample-25', 'T1', 'MUSINSA_USED', 'ASK', 48000, 'KRW', 'SAME_ITEM', -4],
    ['sample-26', 'T1', 'KARROT', 'ASK', 43000, 'KRW', 'SIMILAR', -10],

    ['sample-27', 'T2', 'KREAM', 'TRADE', 68000, 'KRW', 'SAME_ITEM', -46],
    ['sample-28', 'T2', 'KREAM', 'TRADE', 75000, 'KRW', 'SAME_ITEM', -22],
    ['sample-29', 'T2', 'KREAM', 'ASK', 82000, 'KRW', 'SAME_ITEM', -5],
    ['sample-30', 'T2', 'KARROT', 'ASK', 72000, 'KRW', 'SIMILAR', -13],

    ['sample-31', 'T3', 'KARROT', 'ASK', 27000, 'KRW', 'SIMILAR', -36],
    ['sample-32', 'T3', 'KARROT', 'TRADE', 30000, 'KRW', 'SIMILAR', -15],
    ['sample-33', 'T3', 'KARROT', 'ASK', 33000, 'KRW', 'SIMILAR', -3],
    ['sample-34', 'T3', 'BUNJANG', 'ASK', 29000, 'KRW', 'SIMILAR', -8],

    ['sample-35', 'B1', 'MUSINSA_USED', 'TRADE', 66000, 'KRW', 'SAME_ITEM', -42],
    ['sample-36', 'B1', 'MUSINSA_USED', 'ASK', 73000, 'KRW', 'SAME_ITEM', -20],
    ['sample-37', 'B1', 'MUSINSA_USED', 'TRADE', 79000, 'KRW', 'SAME_ITEM', -4],
    ['sample-38', 'B1', 'KARROT', 'ASK', 70000, 'KRW', 'SIMILAR', -11],

    ['sample-39', 'B2', 'KREAM', 'TRADE', 90000, 'KRW', 'SAME_ITEM', -49],
    ['sample-40', 'B2', 'KREAM', 'TRADE', 98000, 'KRW', 'SAME_ITEM', -25],
    ['sample-41', 'B2', 'KREAM', 'ASK', 108000, 'KRW', 'SAME_ITEM', -5],
    ['sample-42', 'B2', 'GRAILED', 'ASK', 78, 'USD', 'SIMILAR', -9],

    ['sample-43', 'B3', 'KARROT', 'ASK', 45000, 'KRW', 'SIMILAR', -39],
    ['sample-44', 'B3', 'KARROT', 'TRADE', 49000, 'KRW', 'SIMILAR', -18],
    ['sample-45', 'B3', 'KARROT', 'ASK', 54000, 'KRW', 'SIMILAR', -3],
    ['sample-46', 'B3', 'BUNJANG', 'ASK', 50000, 'KRW', 'SIMILAR', -12],

    ['sample-47', 'B4', 'BUNJANG', 'TRADE', 39000, 'KRW', 'SIMILAR', -45],
    ['sample-48', 'B4', 'BUNJANG', 'ASK', 37000, 'KRW', 'SIMILAR', -21],
    ['sample-49', 'B4', 'BUNJANG', 'ASK', 35000, 'KRW', 'SIMILAR', -5],

    ['sample-50', 'S1', 'KREAM', 'TRADE', 142000, 'KRW', 'SAME_ITEM', -50],
    ['sample-51', 'S1', 'KREAM', 'TRADE', 152000, 'KRW', 'SAME_ITEM', -26],
    ['sample-52', 'S1', 'KREAM', 'ASK', 164000, 'KRW', 'SAME_ITEM', -4],
    ['sample-53', 'S1', 'GRAILED', 'ASK', 118, 'USD', 'SIMILAR', -12],

    ['sample-54', 'S2', 'KREAM', 'TRADE', 110000, 'KRW', 'SAME_ITEM', -44],
    ['sample-55', 'S2', 'KREAM', 'TRADE', 118000, 'KRW', 'SAME_ITEM', -23],
    ['sample-56', 'S2', 'KREAM', 'TRADE', 126000, 'KRW', 'SAME_ITEM', -2],
    ['sample-57', 'S2', 'STOCKX', 'ASK', 94, 'USD', 'SAME_ITEM', -7],
  ];
  return [
    ...sampleEvidence(today),
    ...extraRows.map(([evidenceId, itemId, platform, priceType, amount, currency, matchLevel, offset]) => ({
      ...base,
      evidenceId,
      itemId,
      platform,
      priceType,
      amount,
      currency,
      matchLevel,
      retrievedAt: addDays(today, offset),
    })),
  ];
}
