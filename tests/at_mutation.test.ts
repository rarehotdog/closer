// AT-28 mutation check (plan v2 §4-4): a build without the availability rule, or without the pin
// rule, must make at least one targeted acceptance check fail. Reading used: each mutant separately
// (the stricter reading of "가용 규칙 또는 pin 규칙을 뺀 빌드").
//
// Target sets. The availability mutant runs against AT-03 · AT-06 · AT-19 as pre-registered. Those
// three cannot tell the pin rule from the offender-scope rule: in FX-H the kept piece J1 sits
// outside the offender slots, so OUTSIDE_OFFENDERS alone keeps it there and a build without the
// pin rule still passes them. The pin mutant is therefore checked where the outer slot may change:
// the next plan without a photo (no offenders) with a second outer seeded, and AT-21 (FX-E8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAT03, checkAT06, checkAT19, checkAT21, nextPlanOuters } from './at_checks.ts';
import type { RuleSet } from '../engine/rules.ts';

const AVAILABILITY_MUTANT: RuleSet = { availability: false, pin: true };
const PIN_MUTANT: RuleSet = { availability: true, pin: false };

async function failures(rules: RuleSet): Promise<string[]> {
  const out: string[] = [];
  for (const [name, fn] of [['AT-03', checkAT03], ['AT-06', checkAT06], ['AT-19', checkAT19]] as const) {
    try {
      await fn(rules);
    } catch {
      out.push(name);
    }
  }
  return out;
}

test('AT-28 [mock] mutation — availability-rule mutant is caught by AT-03/06/19', async () => {
  const f = await failures(AVAILABILITY_MUTANT);
  assert.ok(f.length >= 1, 'availability mutant survived AT-03, AT-06 and AT-19');
});

test('AT-28 [mock] mutation — pin-rule mutant is caught on the next-plan path (second outer seeded): J1 kept with the rule, swapped without it', async () => {
  const withRule = await nextPlanOuters({ availability: true, pin: true });
  assert.ok(withRule.every((o) => o === 'J1'), `with the pin rule an option drops J1: ${withRule.join(', ')}`);
  const mutant = await nextPlanOuters(PIN_MUTANT);
  assert.ok(mutant.some((o) => o !== 'J1'), `pin mutant survived the next-plan path: every option kept J1 (${mutant.join(', ')})`);
});

test('AT-28 [mock] mutation — pin-rule mutant is caught by AT-21 (FX-E8)', async () => {
  await checkAT21(); // passes with every rule on
  await assert.rejects(checkAT21(PIN_MUTANT), 'pin mutant survived AT-21');
});
