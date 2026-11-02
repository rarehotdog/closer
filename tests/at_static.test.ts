// AT-17 / AT-18 static checks — repo scope (preliminary). The plan judges both at RC2, when the
// script, subtitles, form draft and edited video exist; those inputs are not checked here.
import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from './helpers.ts';
import { runAt17, runAt18, namesChecked } from '../scripts/static_check.ts';

test('AT-17 [static, repo scope] labels and banned words — no PASS/LIVE/ALL_GREEN outside result objects, banned words 0, on-screen score 0', () => {
  const f = runAt17(ROOT);
  assert.deepEqual(f, []);
});

test('AT-18 [static, repo scope] privacy and secrets — key formats 0, company commit e-mail 0, EXIF 0, photo bytes 0, person names 0', () => {
  const f = runAt18(ROOT);
  assert.deepEqual(f, []);
  // The person-name part needs the untracked local list; without it this is not a pass for names.
  if (namesChecked() === 0) console.log('AT-18 note: person-name check not run (no .closer/deny-names.json on this machine)');
});
