# Closer — build status (mock mode)

## 0. Update 2026-11-04 23:30 KST

- main = the sha shown by `git log -1`; GitHub `rarehotdog/closer` (public) tracks it. Tests (11/4 run): 123 run · 114 pass · 0 fail · 9 skip (the real-mode cases, without a key). Static AT-17/18: 0 findings at repo scope. `npm run typecheck` passes (TypeScript and `@types/node` are devDependencies now). CI: `.github/workflows/ci.yml` runs `npm ci`, the type check, the tests and the static check on every push and pull request.
- AT-28 is green since 11/4: the pin-rule mutant is checked on the next-plan path (second outer seeded) and by AT-21 instead of AT-03/06/19, which cannot see it in FX-H (§2). The availability mutant keeps its pre-registered AT-03/06/19 target set; no expected value was changed.
- 11/4 night: Closet in 3D (layers, exploded view, outfit picking, photo cut-outs), eight resale platforms in their own currencies, and the **keep-or-let-go** screen on My closet: one question per piece with a date, two sides of counted facts, a position saved as a read-back snapshot and resolved by later wear records. No probability anywhere. The `money` initialisation error on My closet → "Look at selling" (reported on cc09bfe) is fixed and re-checked in a browser at 390 px; an empty list of cost lines now leaves the net unknown instead of equal to the price.
- Features since this file was first written: Today sentence path (Spark reads the words, code checks them), real-photo path with the official SAM decoder, 60-day review with exemptions and choices, per-platform price evidence and net calculator, hand-over drafts, Discover looks rebuilt from the closet, style targets with a counted match and an item box (11/3 night). Details: [features_1102.md](features_1102.md).
- Caps: visitor-per-day and app-total caps can be raised by the host through `CLOSER_VISITOR_DAY_USD` and `CLOSER_APP_TOTAL_USD` (ceilings 10 and 200). The deploy kit under `deploy/` writes 3 and 20 on first install.
- Abuse controls and retention (11/4 night): per-address rate limits on the workspace-creating and model-call-starting POSTs (429 with Retry-After), constant-time token checks, application/json-only POST bodies answered 400/415 without parser text, a Content-Security-Policy and the other response headers on every answer, and a sweep of Try forks (kind `visitor`) 24 h after creation, at startup and hourly; their call rows stay so the caps keep counting. Known limits, listed rather than hidden: (a) the spend-cap check reads spend before a model call and records its cost after it, so N requests started in the same instant near an exhausted cap can all pass; the per-address rate limit bounds how many such requests one client can start, and the app-total cap is still applied to every later call. (b) Sample-closet copies made by `/closet` (kind `rehearsal`, one per visitor browser) are not swept; the rate limit bounds their creation. (c) The rate-limit buckets live in memory and empty on restart.
- Still true: real calls 0 in this repository; the Meta adapters follow the documentation examples and stay marked unverified until `.data/live_check.json` is recorded on the owner's machine. Deploy: not done; Live URL: none yet.
- The rest of this file is the 10/30 snapshot, kept as written.

- Written: 2026-10-30 (KST evening), AI build window "10/30 12:30–10/31 08:30" of plan v2 §6-1 (L313). The §9 decision card had no answer, so this build runs under **provisional freeze (잠정 동결)**: the plan's no-answer defaults below.
- Scope covered: §6-1 rows L313 (scaffold, shared, engine, store mock DB, Spark·SAM adapters marked unverified, AT mock, local repo) and L315 (UI five screens, Try on mock, K1, caps, banner). The L314 row (10/31 08:30–15:30) has no keyless work beyond "UI·docs·mock only".
- Real calls: 0. Keys or tokens: 0. Deploy, push, remote, paid calls, account actions: 0. Repository is local only (`git init`, no remote).
- Status line (§6-1 L340 format): last commit = see `git log -1`; **AT mock 29/29 PASS** (28/29 until 11/4: AT-28's pin case, reason and the new target set below); static AT-17/18 PASS at repo scope; blocked: nothing for mock work; owner action needed: answer '예' or '중단' in the first minute of the 10/31 19:00 window, then the key window steps below.

## 1. What exists

| Path | What it is | Plan section |
|---|---|---|
| `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`, `.env.example`, `.gitignore` | First commit = scaffold only. README has the 3-column table (Built during the hackathon / Third-party / Pre-existing = 0), 'Verify it yourself' 3 lines, roadmap sentence, FAQ 3. `.env.example` has names only. `.gitignore` excludes `.env` and `.data/`. | §3-7 L160–162, v1 §4-2 L362 |
| `shared/` | `states.ts` (4-1), `transitions.ts` (4-2 rows 1–13), `reasons.ts` (4-3: 30 codes verbatim, 13/10/7; removed codes listed), `ledger.ts` (3-6 tables, event kinds, write check order), `canonical.ts` (integer-only NFC canonical JSON + SHA-256), `labels.ts` (English surface strings; LIVE chip only for live + callId + 2xx), `client.ts` (save → fresh read → compare → label; SAVE_UNCONFIRMED → lookup → resend same eventId). | §4-1–4-3, §3-6, §5 note |
| `engine/` | `stateMachine.ts` (table + actor rule; illegal pair → INVALID_TRANSITION, WORN→WORN → ALREADY_WORN), `rules.ts` (availability, owner hard rules, pin, offender scope, direction by formality sums, NO_CHANGE), `solver.ts` (per-slot candidates, soft ranking, code solver ≤2 options), `unknowns.ts` (decisive-unknown check), `validate.ts` (Spark 1 / SAM / Spark 2 re-checks), `coords.ts` (0–1000 → pixels with floor and clamp, SAM box-prompt grammar, output parser), `color.ts` (mask median Lab → 12 named colors), `caps.ts` (K1 TTL 10 min, caps, 11/19 00:00 KST visitor $0 rule), `retry.ts` (429/500/503 only, Retry-After, ≤2 retries), `service.ts` (the loop of §3-2; model calls outside DB transactions; clock injected). | §3-2–3-5, §4-2 |
| `store/ledger.ts` | Mock server DB: SQLite file via `node:sqlite`. Write path ① eventId+payloadHash ② expectedRevision ③ transition conditions in the transaction ④ commit; ⑤ read-back on a second connection in a new read transaction. stateHash covers events/items/availability/plans/wear_rows only. | §3-6 L140–153 |
| `adapters/` | Every file starts with `// 미검증 — 문서 예시 기반, 실호출 0`. `spark1.ts`, `sam.ts`, `spark2.ts` build Responses-API bodies from the doc examples (store:false, reasoning.effort low, max_output_tokens 4000, text.format json_schema, function tools with parallel_tool_calls:false and no tool_choice). `transport.ts`: mock is default; real refuses without `MODEL_API_KEY` and always refuses in test processes. `mock/transport.ts` returns doc-shaped JSON so the same builders/parsers run. | §3-3, §3-4 |
| `fixtures/` | `fxh.ts` (FX-H 9 roles, O0, intent), `edge.ts` (FX-E1…E8, E3 archived), `photos.ts` (3 code-drawn sample photos holding the 9 roles 4·3·2, each flagged 'Sample photo · code-drawn placeholder' / 'Sample item'; ground truth written in the file before any call). | §4-5 L260–274 |
| `tests/` | Keyless ATs (mock), static AT-17/18 (repo scope), unit tests, reporter → `docs/at_results.json` → `docs/at_results.md`. Tests block `fetch` and set `CLOSER_FORBID_REAL=1`. | §4-4 |
| `web/` | `server.ts` (`node:http`, mock by default) + `public/` vanilla JS UI: `/` landing, `/try` Try, `/app`, `/w/demo-rc1`, `/admin`, `/version`, `/today`, `/closet`, `/closet/3d`, `/discover`. | §3-7 L157 |
| `scripts/` | `static_check.ts` (AT-17/18 scanner), `at_report.ts`, `screenshots.cjs` (Playwright). | — |
| `docs/screens/` | 13 PNGs (see §7). | — |

Stack: the plan v2 does not name one; plan v1 §4-2 L362 says "TypeScript 하나 [가정]" with these module folders, so this build is TypeScript on Node.js ≥ 22.18 (built-in type stripping), `node:sqlite`, `node:test`, and a no-framework browser UI. Runtime dependencies: 0.

How to run: `npm test` (tests + report) · `npm run ui` (http://localhost:8787) · `npm run screens` · `npm run typecheck` (TypeScript and Node types are devDependencies since 11/4; run clean on 11/4).

## 2. Acceptance tests (run in this session, mock mode)

Totals from `docs/at_results.md` (11/4 run): AT cases PASS 33 · FAIL 0 · SKIP 7 (40 active-AT cases; variants counted separately) · other tests PASS 27 / 27. Per AT id (34 active):

| AT | Result | Note |
|---|---|---|
| 01 | PASS (mock) · SKIP (real) | real needs key + deploy |
| 02, 03, 04, 06, 07, 08, 09, 10, 12, 13, 14, 20, 21, 22, 23, 25, 26, 27, 29, 30, 32, 33, 34, 35 | PASS (mock) | |
| 11 | PASS (mock) · SKIP (real) | |
| 15 | SKIP | deploy-only, RC2 |
| 16 | SKIP | real-only |
| 17 | PASS (static, repo scope) | RC2 verdict still open: script, subtitles, form draft, video OCR do not exist yet |
| 18 | PASS (static, repo scope) | same; names checked by hashed deny-list so no name is stored in the repo |
| 19 | PASS (mock) · SKIP (real) | |
| 28 | PASS (mock, since 11/4) | availability mutant caught by AT-03/06/19; pin mutant caught on the next-plan path (second outer seeded) and by AT-21, not by AT-03/06/19 (note below) |
| 31 | SKIP | real-only (실제 1회) |
| 36 | PASS (mock) · SKIP (real) | |
| 05, 24 | SKIP | archived, numbers kept (not counted in the 34) |

- AT mock count in the plan's format (§6-1 L313 "AT mock n/29"): **29/29** (28/29 until 11/4).
- Also passing: the §4-5 pre-registered FX-H answer (A = B1→B2, B = B1→B2 + S1→S2, E1 → J1+T1+B3+S1).

**AT-28, one line (updated 11/4):** under the frozen FX-H the pinned item J1 is never in an offender slot (an overlap is already PIN_CONFLICT), so the offender-scope rule alone keeps J1 and a build without the pin rule still passes AT-03, AT-06 and AT-19. Since 11/4 the pin mutant is checked where the outer slot may change: the next plan without a photo with a second outer seeded (J1 kept with the rule, swapped to J2 without it) and AT-21 (pin vs rain rule); both catch it, measured by running each check against the mutant. The availability mutant keeps its pre-registered AT-03/06/19 target set, and no expected value of AT-03/06/19/21 was changed.

## 3. Mock vs real

| Part | This build | Real when |
|---|---|---|
| Spark 1, SAM, Spark 2 | Mock transport, doc-shaped responses; request builders and parsers are the real ones | key window + SP-A1–A3 |
| SAM response parsing and mask decoding | Live text goes through the official `@meta-sam/parser` (fields read by name, masks decoded by the library, parser diagnostics on the call line); the mock transport keeps its positional records and `R` masks. Mask-in-box tolerance = max(8 px, 5 % of the prompted box side) or `CLOSER_MASK_TOLERANCE_PX`; an overshoot within it is clamped and noted ("mask N overshoot X px"), not held. `metadata.mask_encoding` is sent only with `CLOSER_SAM_METADATA=1` | first live run: write the measured overshoot here as a number (live_check prints it per record) |
| Mask color re-measure | Works on the code-drawn sample photos (analytic pixels). Real JPEG/PNG photos need an image decoder (none included) | after key window |
| Sample photos | 3 code-drawn color-block placeholders (plan's fallback) | muse-image-1.0 at SP-A4 |
| Spark 2 thumbnails (256 px mask cuts) | Not produced; Spark 2 gets fact IDs only (= G3 cut #1 state) | later, if kept |
| Ledger | SQLite file (`.data/closer.db`, gitignored) | managed persistent DB on the host (a non-SQLite store adapter is not written) |
| Costs | Mock calls cost $0; panel shows "est. live" from §3-4 estimates | live usage → cost |
| Hosting, deploy, /w/demo-rc1 recorded run | None; `/w/demo-rc1` is read-only with the sample wardrobe and no recorded run | rc1 / take |

## 4. Provisional-freeze defaults applied (§9, no answer)

| # | Question | Default applied | Plan line |
|---|---|---|---|
| 1 | Contract v2 first freeze + scope + 6-4 table | Provisional freeze: §4 and §6-4 as written; engine/mock code started in a local repo (no private repo available → local); external effects 0, Meta calls 0. In the first minute of 10/31 19:00 the owner answers only '예' or '중단'; '중단' = discard code, keep documents. | v2 L441; start-time note L3 |
| 2 | Key/hosting/credit time; may AI create hosting | Key window 10/31 19:00–19:50 (fix window 11/1 12:00–12:25, then '키 11/1' branch). Hosting is created by the owner in the key window: this build created none and did not touch hosting or DB connectors. | L442 |
| 3 | App money caps | Spike + dev + recording total **$20**, visitor live calls **0** ('Replay & ledger mode'). Encoded as `PROVISIONAL_CAPS` (total $20, visitor/day $0). The session cap is not covered by the default, so the candidate $0.25 is kept (AT-10 uses it). The 11/19 00:00 KST visitor-$0 date rule is in code. | L443 (candidates L21) |
| 4 | Owner-side approvals | Kept outside this repository (owner's private notes). Credits on hold by default. No code effect. | L444 |
| 5 | Real clothes photos / voice | Both 'no': F2 sample photos (here code-drawn placeholders until SP-A4), English TTS + 'Narration: AI voice', English subtitles later. | L445 |
| 6 | Scene card | 'Demo scenario' chip on every screen; Impact penalty accepted. | L446 |
| 7 | Track / Official Rules | Indie [가정]; accept on the spot. No code effect. | L447 |
| — | Pre-filled defaults | Paint mixing archived (no code), at most 2 options (enforced), Wonder excluded (no code), Ring 1 = this document's scope. | L449 |

## 5. Readings and deviations (most conservative reading where the plan is ambiguous)

1. **AT-08 vs §3-3 conflict.** AT-08 (L226) says HOLD after one correction; §3-3 Spark 2 row (L118) says fall back to code solver + 'Reason by code'. Built: AT-08 (HOLD). The code-solver path exists as a configuration (`spark2Mode: 'code'`, G3 cut #5), not as an automatic per-request fallback.
2. **AT-28 reading:** each mutant separately (stricter). Result above.
3. **FX-E2 reading:** starts from E1's locked option A (bottom B2), B3 already in laundry, then B2 → laundry; re-plan touches only the bottom. Reason: as a first proposal, a shoes-only edit would still be valid, so "하의 0 → NO_VALID_COMBO" only holds in the re-plan reading.
4. **FX-E4 fixture details [가정]:** offenders {T1} (so the top slot is open) and S2 formality also unknown as the non-deciding unknown.
5. **Test-local items:** AT-08 needs a second outer to express "J1 swap" (FX-H has one outer) → sample item J2; AT-26 needs a new item → sample item T4. FX-H roles themselves are unchanged.
6. **Actor rule** applied to every human row (4, 8, 9, 10, 11, 12, 13 and registration), stricter than the note's list (5, 8, 9, 12 + registration).
7. **Pre-lock decision state** (DRAFT / PROPOSED / HOLD) lives in the run record (`operations`, outside stateHash); the `plans` row is created at the first PLAN_LOCKED. This is how "proposal = +0" (§3-2 step 3, AT-07) is kept.
8. **One bad option rejects the whole Spark 2 output** (then one correction, then HOLD).
9. **HOLD reasons** = row 3 list plus model/call codes (§3-3 says INVALID_MODEL_OUTPUT → HOLD). A final 400 holds with META_REQUEST_REJECTED (AT-09 names no code).
10. **warmer / cooler** cannot be checked by code with the frozen roles (no warmth attribute) → treated as unmet → NO_VALID_COMBO.
11. **Ranking:** current item first, then direction fit (less_formal: lower formality first), then itemId; worn within 1 day moves one step down; no record = no bonus. Chosen because it reproduces the §4-5 answers; "laundry re-plan picks B3" follows.
12. **Mask-in-box check tolerance = 0.** The SAM doc example returns a box 1–4 px outside its prompt box, so SP-B2 may need a tolerance; that is a second-freeze decision.
13. **Owner formality answers** stay in the run record (§3-2 has no item-update event).
14. Rain threshold 50% from the earlier plan draft [가정]; 진청 jeans mapped to color family 'blue' (no indigo in the 12 colors) [가정].
15. Extensions to the §3-6 columns: `calls.source` adds `mock`; `items` adds origin, waterproof, sample; `plans.context` adds the baseline outfit.
16. Item IDs: slot prefix (J/T/B/S) + lowest free number, which reproduces the FX-H IDs.
17. Not built: owner hard-rule screen (tests pass rules in), visitor-fork cleanup after 24 h, Spark 2 thumbnails, managed-DB store, sentence-change path (v1.1).
18. Admin is open only in local mock mode; real mode requires `CLOSER_ADMIN_TOKEN`.
19. Git: plain commit messages with no attribution trailers; synthetic author `Closer Build <build@closer.invalid>` (no personal or company e-mail). Before publishing, the owner may want a personal GitHub no-reply identity. Rewriting history changes the first-commit sha used in 'Verify it yourself'.
20. LICENSE: v2 does not say; v1 says "MIT 또는 Apache-2.0" (L362) → MIT. Flag for the owner.
21. Mock Spark 2 echoes the code solver, so the mock next plan picks the tee (T3); the script's "knit instead of the shirt" is a real Spark 2 choice.
22. 'Next plan · Demo clock +1 day' moves a server-wide demo clock (local mock only).

## 6. Next steps — key window 10/31 19:00–19:50 (names only, no values anywhere)

1. First minute: owner answers '예' or '중단' to the provisional freeze (§9 Q1).
2. Defect triage, subtract only (10 min).
3. Model API: account + valid payment method; create one key; it is shown once. Put it **only** in the hosting server environment as `MODEL_API_KEY`. Not in chat, docs, commits or screenshots.
4. Hosting + managed persistent DB (no sleep, ≥ 60 s requests, server env vars). Server environment variable names: `CLOSER_MODE` (= real), `MODEL_API_KEY`, `CLOSER_ADMIN_TOKEN`, `CLOSER_DB_PATH` (only while the SQLite store is used), `CLOSER_PORT` if the host needs it, `META_API_BASE_URL` only if the documented base changes. Leave `CLOSER_TODAY` unset in production.
5. Credit form only after the owner's own approvals are settled (Team ID needed).
6. After the window (AI, 19:50–): first deploy (SP-C1) → SP-A1 (`/v1/models` lists both IDs, Spark 'OK' 200) → A2 (SAM, 6 drawn squares, IDs 1–6) → A3 (text.format 3/3; fallback Chat Completions response_format) → plug in the official SAM mask decoder and an image decoder → A4 sample photos with muse-image-1.0 (tools off) + manifest before any call → B1/B2/B4 → B3/B5 → G2 → rerun the skipped real variants (AT-01, 11, 16, 19, 31, 36). Apply §6-4 results without changing expected values.
7. Owner decisions waiting: LICENSE choice, git author identity before the repo goes public, managed DB choice (needs a store adapter for the same contract). AT-28's target set was settled on 11/4 (next-plan path + AT-21, §2).

## 7. Screenshots (`docs/screens/`, Playwright Chromium, mock mode)

`01-try-pick.png` · `02-try-masks-cards.png` · `03-try-options.png` · `04-try-laundry-replan.png` · `05-try-wear-recorded.png` · `06-try-next-plan.png` · `07-app.png` · `08-recorded-run-readonly.png` · `09-admin.png` · `10-admin-k1-on.png` · `11-try-k1-held.png` · `12-version.png` · `13-try-phone.png` (390 px wide; horizontal overflow measured 0 px).
