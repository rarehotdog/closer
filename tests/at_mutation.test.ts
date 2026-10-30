// AT-28 mutation check (plan v2 §4-4): a build without the availability rule, or without the pin
// rule, must make at least one of AT-03 · AT-06 · AT-19 fail. Reading used: each mutant separately
// (the stricter reading of "가용 규칙 또는 pin 규칙을 뺀 빌드").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAT03, checkAT06, checkAT19 } from './at_checks.ts';
import type { RuleSet } from '../engine/rules.ts';

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
  const f = await failures({ availability: false, pin: true });
  assert.ok(f.length >= 1, 'availability mutant survived AT-03, AT-06 and AT-19');
});

test('AT-28 [mock] mutation — pin-rule mutant is caught by AT-03/06/19', async () => {
  const f = await failures({ availability: true, pin: false });
  assert.ok(f.length >= 1, 'pin mutant survived AT-03, AT-06 and AT-19 (in FX-H the pin item J1 is outside the offender slots, so OUTSIDE_OFFENDERS already blocks a J1 change)');
});
