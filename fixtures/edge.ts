// FX-E1 … FX-E8 — plan v2 §4-5. Inputs only; expected values live in tests/ (hand-written, §4-4).
import type { HardRule, OffenderWhy } from '../shared/wardrobe.ts';

export const FX_E = {
  E1: {
    plan: 'After option A is locked, B2 → LAUNDRY → bottom candidates {B1, B3}; B1 breaks the direction → B3. Result J1+T1+B3+S1.',
    lockOption: 'A',
    availability: [{ itemId: 'B2', state: 'LAUNDRY' }],
  },
  E2: {
    plan: 'B2 and B3 in LAUNDRY → no bottom keeps the direction → NO_VALID_COMBO + "Keep B1 (more formal) or skip?".',
    // Reading used (docs/status.md): starts from E1's locked option A (bottom B2); B3 is already in
    // laundry, then B2 goes to laundry. Re-plan touches only the bottom slot.
    lockOption: 'A',
    preAvailability: [{ itemId: 'B3', state: 'LAUNDRY' }],
    availability: [{ itemId: 'B2', state: 'LAUNDRY' }],
  },
  E3: {
    archived: true,
    plan: 'Archived (sentence-change path is v1.1): "Dinner is now a client meeting" → more_formal, re-check every slot.',
  },
  E4: {
    plan: 'T2 formality unknown and it changes the result → exactly one question.',
    unknownFormality: ['T2'],
    // Fixture details [가정]: offenders {T1} so the top slot is open; S2 formality is also unknown
    // but cannot change this result → no question for it.
    nonDecisiveUnknownFormality: ['S2'],
    offenders: [{ itemId: 'T1', why: 'too_formal' as OffenderWhy }],
  },
  E5: {
    plan: 'Record yesterday (D-1) B2 wear today; B2 is in LAUNDRY now.',
    itemIds: ['B2'],
    dayOffset: -1,
    availability: [{ itemId: 'B2', state: 'LAUNDRY' }],
  },
  E6: {
    plan: 'Same eventId, different itemIds.',
    eventId: 'fx-e6-wear',
    first: ['B2'],
    second: ['B3'],
  },
  E7: { plan: 'Spark 2 request, then cancel, then the response arrives.' },
  E8: {
    plan: 'Rain 80% + owner hard rule "rain → waterproof outer" + pin J1 (not waterproof).',
    weather: { rainPct: 80 },
    // Rain threshold 50% comes from the earlier plan draft [가정].
    hardRules: [{ kind: 'waterproof_outer_if_rain', minRainPct: 50 }] as HardRule[],
  },
} as const;
