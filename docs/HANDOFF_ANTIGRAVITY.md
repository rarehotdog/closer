# Handoff to Antigravity (main code owner from 11/2)

From 11/2 Antigravity writes the main code. Claude, Sol, Instinct and Leo edit the plan, review and verify. Their jobs are listed at the end of this file.

## Base

- **Repository.** This one, with zero runtime dependencies. It needs Node ≥ 22.18, because it uses the built-in SQLite and test runner.
- **Antigravity's earlier v1.3 code.** It stays as a reference only, and is not merged. Port an idea from it only if it fits the rules below.
- **Commands.** `npm test` runs 88 tests: 78 pass, 1 fails (AT-28, a plan gap) and 9 are skipped because they need keys or a deploy. `npm run ui` serves http://localhost:8787 with the screens /today, /closet, /discover, /, /app, /admin and /version.
- **Commit identity.** Use a no-reply identity. Do not commit personal e-mails, home paths (`/Users/...`) or keys.

## Map

| Folder | What lives there |
|---|---|
| `shared/` | Contracts: states (§4-1), transitions (§4-2), the 30 reason codes (§4-3), the ledger contract (§3-6), wardrobe vocabulary |
| `engine/` | Rules decided by code |
| `store/` | `ledger.ts`: the SQLite wardrobe ledger. Every write goes through eventId, then expectedRevision, then transition checks, then commit, then a read-back. `extras.ts`: review choices, price evidence and drafts, kept outside stateHash |
| `adapters/` | Meta Model API: `spark1`, `sam`, `spark2`, `intent`, `transport`, and `mock/` |
| `web/` | `server.ts` holds the API and auth guards. `public/` holds the screens, with no framework |
| `fixtures/` | FX-H roles, edge cases, sample photos, and the sample closet with its 75-day synthetic history |
| `scripts/` | `live_check.ts` (first live run), `intent_ablation.ts` (rules vs model), `static_check.ts` (AT-17/18) |

The files in `engine/` are:
- `anchor.ts`: "Keep this today" planning (feature 1).
- `intent.ts`: sentence → locks, with a code check and a keyword baseline.
- `review.ts`: the 60-day review (feature 2).
- `market.ts`: price cards, net amount and hand-off drafts.
- `looks.ts`: looks rebuilt from your own wardrobe (feature 3).
- `features.ts`: the service for features 2 and 3.
- `service.ts`: the photo, Spark and SAM decision flow, plus `startAnchor` and `startAnchorFromSentence`.

Read `docs/features_1102.md` first, then `docs/status.md`.

## Rules the tests enforce. Keep them green.

1. **Locked pieces.** A piece the owner locked is never swapped. If there is a conflict, ask.
2. **Model output.** Model output is only a proposal. Code checks IDs, ownership, availability, slots and rules before anything is shown, and every save is read back.
3. **Wear records.** "No confirmed wear in N days" is shown only if the item was tracked for N days and at least half of those days have records. Otherwise the screen says "too few records". No screen says an item went unused.
4. **Prices.**
   - KREAM, Karrot and Poshmark each get their own card.
   - Asking and traded prices are labelled.
   - Prices are never averaged and currencies are never converted.
   - A fee with an unknown value makes the net unknown.
5. **Drafts.**
   - Sale and donation texts are drafts only. There is no SOLD or DONATED state; the owner reports "I posted it" or "I handed it over" themselves.
   - No automatic posting, messaging, pickup booking or cart.
6. **Looks.** Looks are drawn for the demo, or shared by people who opted in. No product link or price is invented. "Outfits added" is a count on the real wardrobe.
7. **Owner access.** In real mode the owner's wardrobe needs `CLOSER_ADMIN_TOKEN`. Public sample closets use the visitor cap and accept only the fixed sentences.
8. **Banned words.** AT-17 checks the plan's banned words, including the words that would claim an item went unused.

**Claims we do not make.**
- A wear-ledger hash is not proof of condition to buyers.
- No tax-deduction estimates.
- No invented numbers, such as "+8 outfits" or "40% saved", without a count.
- No "only" or "first" claims.

## Work order for Antigravity

| # | Task | Done when |
|---|---|---|
| P0-1 | Run `scripts/live_check.ts --live` on the Mac with the key, then fix the adapters to match the real responses (model IDs, `output` shape, `usage` field names) | `.data/live_check.json` all OK; tests still green |
| P0-2 | Host with a persistent disk (SQLite). Set environment variables on the host only: `CLOSER_MODE=real`, `MODEL_API_KEY`, `CLOSER_ADMIN_TOKEN`, `CLOSER_DB_PATH` | Public URL; /version sha = the repo HEAD |
| P0-3 | Real photo path. Built 11/2, live run pending: official SAM decoder (`@meta-sam/parser`), browser upload (JPEG for the models plus a PNG copy for pixels, EXIF dropped), mask colour re-measure on the PNG copy, 256 px mask cut-outs sent to Spark 2. What remains is one live run with a real photo | One real outfit photo goes through to cards, then a plan, then a saved wear, in real mode |
| P1-4 | Owner sign-in in the UI. Built 11/2: a token field on /app and /admin sends `x-admin-token`, and /app shows a private notice when signed out | Done in mock and real mode with a fake key; check again on the deployed URL |
| P1-5 | Visual polish on phones (CSS and assets) | 390 px screenshots; no overflow |
| P1-6 | `scripts/intent_ablation.ts --live` results in the README (rules vs Spark on 12 sentences) | Table with both columns |
| P2-7 | Earlier review notes: keep focus after a re-render; build the "Checked by code" chip from the checks that actually ran; the README verify step compares HEAD, not the first commit; AT-28 target list (owner decision) | Each fix has a test or a screenshot |

## Working agreement

- **Branches.** One branch per task, merged through a pull request. Claude reviews each diff as the non-author. Sol re-runs the tests and the honesty checklist on the URL before a release is called done.
- **Pit cards.** Every pit stop at 12:00, 18:00 and 22:00, each contributor adds a card at the bottom of its own tab in the Meta doc. Leo compiles the board.
- **Keys and live output.** Keys never go in chat, docs, commits or screenshots. Live results come back as `.data/*.json` files.

## Everyone else

| Who | Role |
|---|---|
| Claude | Plan editor (v3 of the plan doc, acceptance criteria, the demo script), code reviewer of Antigravity's PRs, keeper of the honesty rules and tests |
| Sol | Independent verification on the deployed URL. English submission text written from verified facts only |
| Instinct | Re-checks official pages: deadline, judging weights, submission form, credits, Meta model docs, platform terms |
| Leo | Crew chief: pit board, decision log, sole writer of the shared tab |
| Owner | Key, billing and hosting; real clothing photos (no faces or home backgrounds); 2–3 decisions per pit stop; recording the demo; the final submission |
