# Acceptance test results

Generated from `docs/at_results.json` by `scripts/at_report.ts` (run by `npm test`). Mock mode only; zero real calls.

- Active AT ids present: 34 of 34 (AT-05 and AT-24 archived, numbers kept).
- AT test cases (variants counted separately): PASS 31 · FAIL 1 · SKIP 7 · total 39.
- Other tests (unit, fixture answer): PASS 14 · FAIL 0 · SKIP 0 · total 14.

| Test | Result | Note |
|---|---|---|
| AT-01 [mock] photo registration — 4 cards, SAM ids {1,2,3,4}, ledger +0 before confirm, +4 and read-back match after | PASS |  |
| AT-01 [real] photo registration on the deployed build | SKIP | needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–) |
| AT-02 [mock] unknown question 1 — only the unknown that changes the result is asked (FX-E4) | PASS |  |
| AT-03 [mock] exclusion ledger — LAUNDRY/REPAIR/STORED: 0 candidates, ≥1 reason code each | PASS |  |
| AT-04 [mock] proposal and state are separate — PROPOSED ≤ 2, availability unchanged | PASS |  |
| AT-05 bottleneck badge | SKIP | archived (보관, number kept) — plan §4-4/§7 |
| AT-06 [mock] slot re-plan (FX-E1) — bottom only B3, J1/T1/S1 same, Spark calls 0 | PASS |  |
| AT-07 [mock] nothing saved before confirmation — LOCKED 0, ledger +0 right after proposal | PASS |  |
| AT-08 [mock] model output check — unknown itemId, LAUNDRY item, J1 swap → INVALID_MODEL_OUTPUT, ledger +0, HOLD after one correction | PASS |  |
| AT-09 [mock] failure honesty — 503 + Retry-After 60: wait, ≤ 2 retries, then HOLD META_API_UNAVAILABLE; 400: no retry; no LIVE on screen | PASS |  |
| AT-10 [mock] caps and kill switch — K1 on: new photo → META_DISABLED, button re-plan and read-back still work; session $0.25 → CALL_CAP_REACHED; TTL 10 min → off | PASS |  |
| AT-11 [mock] selection save then wear, each shown only after a matching fresh read | PASS |  |
| AT-11 [real] selection save and wear on the deployed build | SKIP | needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–) |
| AT-12 [mock] idempotency — same eventId twice → one record, second response = first | PASS |  |
| AT-13 [mock] wear undo — one correctsEventId event, count −1, original event kept | PASS |  |
| AT-14 [mock] save result unknown — SAVE_UNCONFIRMED → look up eventId → found: success / missing: resend same eventId; new eventId 0 | PASS |  |
| AT-15 [deploy] new-session persistence of /w/demo-rc1 | SKIP | deploy-only, judged at RC2 (plan §4-4) |
| AT-16 [real] real Meta path on the deployed hero | SKIP | needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–) |
| AT-17 [static, repo scope] labels and banned words — no PASS/LIVE/ALL_GREEN outside result objects, banned words 0, on-screen score 0 | PASS |  |
| AT-18 [static, repo scope] privacy and secrets — key formats 0, company commit e-mail 0, EXIF 0, photo bytes 0, person names 0 | PASS |  |
| AT-19 [mock] intent kept (FX-H) — J1 kept, changes ⊆ {bottom, shoes}, A = 1, B ≤ 2, sums < O0 | PASS |  |
| AT-19 [real] intent kept on the deployed build | SKIP | needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–) |
| AT-20 [mock] zero-change trap — unchanged O0 from the model → NO_CHANGE; "keep as is" saves via its own button | PASS |  |
| AT-21 [mock] pin vs hard rule (FX-E8) — 0 proposals, 1 question PIN_CONFLICT, J1 never swapped | PASS |  |
| AT-22 [mock] same id, different content (FX-E6) — EVENT_CONFLICT, ledger hash unchanged | PASS |  |
| AT-23 [mock] late response (FX-E7) — cancel during Spark 2 → STALE_RESPONSE, 0 candidates | PASS |  |
| AT-24 whole-condition change | SKIP | archived (보관, number kept) — sentence-change path is v1.1 |
| AT-25 [mock] past wear (FX-E5) — recorded; availability stays LAUNDRY | PASS |  |
| AT-26 [mock] item with no record — "no confirmed wear yet", rank bonus 0 | PASS |  |
| AT-27 [mock] actor check — demo_script confirm/lock/wear → INVALID_TRANSITION in real·demo·visitor, hash unchanged | PASS |  |
| AT-28 [mock] mutation — availability-rule mutant is caught by AT-03/06/19 | PASS |  |
| AT-28 [mock] mutation — pin-rule mutant is caught by AT-03/06/19 | FAIL | pin mutant survived AT-03, AT-06 and AT-19 (in FX-H the pin item J1 is outside the offender slots, so OUTSIDE_OFFENDERS already blocks a J1 change) |
| AT-29 [mock] ambiguous reference "그거 말고 다른 거" — AMBIGUOUS_REFERENCE, 1 question, 0 guesses | PASS |  |
| AT-30 [mock] unrequested relaxation — option breaking an owner hard rule → UNREQUESTED_RELAXATION | PASS |  |
| AT-31 [real] instruction text inside a photo | SKIP | needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–); real-only (실제 1회) |
| AT-32 [mock] NEEDS_REPLAN — locked plan B2 → LAUNDRY: plan NEEDS_REPLAN, new option PROPOSED, LOCKED 0 before the tap | PASS |  |
| AT-33 [mock] record → next suggestion — yesterday T1 WORN: T1 ranks lower (not excluded), reason "T1 worn {MM/DD} · your record" | PASS |  |
| AT-34 [mock] no substitute (FX-E2) — NO_VALID_COMBO + 1 relaxation question, no silent relaxation | PASS |  |
| AT-35 [mock] no change outside offenders — offenders {B1, S1}, option changing T1 → OUTSIDE_OFFENDERS, ledger +0 | PASS |  |
| AT-36 [mock] mask color cross-check — Spark black vs mask navy → ATTR_UNKNOWN for that item only, registration +0 before confirm | PASS |  |
| AT-36 [real] mask color cross-check on real photos | SKIP | needs MODEL_API_KEY on the deployed server; runs after the key window (plan §6-1, 10/31 19:50–) |

## Other tests

| Test | Result | Note |
|---|---|---|
| canonical JSON: key order and NFC do not change the hash; non-integers rejected | PASS |  |
| caps: visitor cap is $0 from 2026-11-19 00:00 KST; kill TTL; free mock calls pass a $0 cap | PASS |  |
| every adapters/ file carries the unverified header | PASS |  |
| fixture colors map to their declared color family (12 named colors) | PASS |  |
| FX-H pre-registered answer (§4-5) — A = B1→B2, B = B1→B2 + S1→S2, E1 → J1+T1+B3+S1 | PASS |  |
| live chip only for live + callId + 2xx | PASS |  |
| mode: mock is the default; real refuses without MODEL_API_KEY and in test processes; fetch is blocked here | PASS |  |
| read-only workspace (/w/demo-rc1): every write → SCOPE_DENIED | PASS |  |
| reason codes: 30 verbatim (13 + 10 + 7), unique, removed codes absent | PASS |  |
| SAM box prompt matches the doc example token; Spark 0–1000 → pixels uses floor and stays inside | PASS |  |
| SAM output parser reads the doc example records (box, frame size, mask H,W,encoding) | PASS |  |
| stale expectedRevision → STALE_STATE; item IDs use the lowest free number per slot | PASS |  |
| states (§4-1) | PASS |  |
| transition table rows 1–13 and illegal transitions are rejected with the right code | PASS |  |
