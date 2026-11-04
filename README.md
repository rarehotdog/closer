# Closer

Closer keeps the piece you want to wear, changes only what feels off or what changed, using clothes you already own, and counts only the wears you confirm.

- Live URL: not deployed yet.
- Watch the recorded run: `/w/demo-rc1` (read-only, same state hash as the recorded run). Not recorded yet.
- Built Oct 27–Nov 4 ET. Models: `muse-spark-1.3` and `sam-3.1` through the Meta Model API (Responses API), called directly from `adapters/`.

| Built during the hackathon | Third-party | Pre-existing |
|---|---|---|
| All code and docs in this repository. The first commit is the scaffold only. | Two runtime dependencies: `@meta-sam/parser` 0.1.0 (Meta, SAM License), the official decoder for SAM 3.1 mask payloads, and `three` 0.170.0 (MIT) for the 3D closet view. Dev tools are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). | 0 |

License: [MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## The loop

Every screen runs the same loop: the model proposes, code checks, you decide.

| Step | Who | What happens | Check |
|---|---|---|---|
| 1 | You | One outfit photo and one sentence ("keep the navy jacket, make the rest more relaxed"). | — |
| 2 | Model `muse-spark-1.3` | Reads the words: the piece to keep, the direction, the pieces that feel off. | Code re-checks every item ID and slot against your closet. |
| 3 | Model `sam-3.1` | Returns one mask per garment box prompt. | Code re-measures each garment's colour from the mask pixels and asks only when it disagrees. |
| 4 | You | Confirm the garment cards. | Nothing is saved before this. |
| 5 | Code | Builds candidates per slot: owned, available, your rules, the kept piece locked. | Rules in `engine/rules.ts`, tested without a key. |
| 6 | Model `muse-spark-1.3` | Picks at most two edits through one function-tool turn. | Code re-checks every item, slot and rule. The locked piece is never swapped. |
| 7 | You | Pick an option, confirm the wear. | Shown as saved only after a fresh read from the server matches the screen. |

You decide at four places: the cards (step 4), the option and the wear (step 7), whether a piece stays or goes (the keep-or-let-go question on My closet), and anything that leaves the app, such as posting a listing or handing a piece over. Closer drafts; you post.

## What it does

- **Today.** The loop above. A laundry, repair or storage button re-plans only that slot, with zero model calls.
- **My closet.** Items registered from the decision photos. The 60-day review lists a piece as "no confirmed wear in N days" only when tracking is complete and at least half of the days have a record; you choose keep, later or exempt. "Look at selling" shows the per-platform prices you entered, never an average, for Korean platforms (KREAM, Karrot, Bunjang) and international ones (Poshmark, eBay, Grailed, Depop, Vinted), each in its own currency; when a cost line is unknown, or no cost line has been checked at all, the net is shown as unknown. Hand-over drafts move DRAFT → REVIEWED → OWNER_REPORTED_DONE and never invent a link.
- **Keep or let go?** One question per piece, written the way an event market writes a contract: "Will I wear J2 (beige coat) in the next 90 days, by 2027-02-02?" Two sides, side by side. *If I keep it*: confirmed wears in the same window, the days that had any record and the days that did not, the last confirmed wear, and the upcoming uses you can name. *If I prepare to sell*: a platform, an asking price you test on a slider (assumed, not offered), the prices seen on that platform with sample rows marked, each cost line as blank, 0 or a value, and the net under those conditions. No probability appears on either side: there is no counted basis for one, so the wear outlook says "not computed", and 0 wears is shown as a count, not a chance. You take a position (Keep, Try wearing it once, Prepare to sell, Decide later); it is saved as a snapshot of the screen, read back, and resolved later by counted wear records ("Open: 2 confirmed wears since the decision, 10 of 30 days passed"). Also reachable from any piece in the 3D closet.
- **Discover.** Sample looks by occasion, rebuilt with what you own first; only the pieces you lack become optional cards, with "N more complete outfits" counted on this closet. Pick looks as **style targets**: Closer counts, piece by piece, how much of them your closet already covers ("6 of 8 pieces · 75%") and shows an item box of every piece they ask for (have it / similar / missing). The formula is printed next to the number, and the count moves only when the closet does.
- **Closet in 3D.** `/closet/3d` draws the same pieces by layer in three.js: outerwear rail, tops, bottoms, shoes. Drag to turn it, slide for an exploded view, tap a piece for its confirmed wears, review status and per-platform price evidence. Pick any pieces into an outfit, one per layer; the rest fade back, and "Wear these today" opens Today with them locked. A piece registered from a photo shows that photo cut out by its mask; the owner's wardrobe opens at `/closet/3d?ws=owner`. It shows the same pieces and counts as My closet and adds no numbers of its own; without WebGL it falls back to the same list.

## Verify it yourself

1. Open `/w/demo-rc1` and `/version` in a private window and compare the stateHash and sha.
2. Compare `git rev-parse HEAD` of the code you have with the sha on `/version`: they must be the same release.
3. Turn K1 on in `/admin` and check that a button re-plan still works while model calls are off.

## Current state

This repository runs in **mock mode** by default: no Meta model is called and no key exists anywhere in the repository. The Meta adapters are written from the documentation examples and stay marked unverified until a live run is recorded in `.data/` on the owner's machine. Status, test results and next steps: [docs/status.md](docs/status.md) · [docs/at_results.md](docs/at_results.md) · [docs/features_1102.md](docs/features_1102.md).

| Command | What it does |
|---|---|
| `npm test` | Runs the keyless acceptance tests, unit tests and static checks; writes `docs/at_results.json` and `docs/at_results.md`. |
| `npm run ui` | Starts the local server on http://localhost:8787 (mock mode). Screens: `/` Try, `/today`, `/closet`, `/closet/3d`, `/discover`, `/w/demo-rc1`, `/admin`, `/version`. |
| `npm run live:check` | Owner's machine only: one real call per model with the key read from the Keychain; writes `.data/live_check.json`. Never runs inside tests. |
| `npm run screens` | Captures the screens into `docs/screens/` with Playwright Chromium (Playwright is not a project dependency). |
| `npm run typecheck` | Optional `tsc` check (needs TypeScript and Node type definitions installed locally). |

Requires Node.js 22.18 or newer (built-in TypeScript type stripping and `node:sqlite`). Run `npm install` once for the two runtime dependencies.

Measurement table: `Photos: {n} ({real or AI-generated}), ground truth written before any call` — not measured yet.

## Known limits

- The demo closet is a sample closet with code-drawn sample photos, marked as such on screen. One real-photo path exists for the owner workspace and needs the owner token in real mode.
- Prices, fees and shop links are what you entered. Closer checks no stock, fills no cart and pays nothing.
- "No confirmed wear" needs records. Without enough of them the review says so instead of guessing.
- The keep-or-let-go screen shows no probability and no expected value. A position is resolved only by wear records you confirm afterwards; days with no record stay unknown, so a closed question reads "1 confirmed wear in the 30 days after the decision", never "you did not wear it".
- Spend caps: $20 for the whole app (`CLOSER_APP_TOTAL_USD` raises it), $0.25 per visitor copy (each Try fork and each sample closet, counted across restarts from the call rows), one per-day cap for all visitor copies together (0 unless `CLOSER_VISITOR_DAY_USD` is set; `npm run live:ui` and the deploy kit set 3; $0 from 2026-11-19 KST whatever is set), and the K1 kill switch. The owner's own wardrobe counts toward the app total only.
- One acceptance test, AT-28, fails on purpose-built grounds: its planted pin-rule mutant is masked by another rule in the fixture, so the test cannot tell them apart. The pin rule itself is covered by the F1 tests. Listed here rather than hidden.

## What comes next (not built)

- Import your order history as a file you export yourself, so each piece carries what you paid and when.
- A closet ledger with its denominator on screen: pieces with a price on record out of all pieces, and what each would leave in your hand, per platform.
- Resale evidence from official platform APIs where they exist; otherwise a screenshot you paste. Never averaged across platforms.
- Donation points near you from a public directory, using your location only when you allow it.
- A 3D model per garment from a photo, with SAM 3D Objects, only for pieces whose front is visible in the photo. Hidden pieces stay as cards.

## FAQ

- **How is this different from a closet catalog?** It edits only the pieces that feel off in the outfit you photographed to decide, the decision photo is also how items get registered, and a selection or wear counts only after it is read back.
- **Does it buy anything or contact shops?** No. Next: a read-only check a shopping client could call before checkout. Not built.
- **What does the model decide, and what does code decide?** Models read the photo and sentence, draw masks, and choose among candidates code passed. Code issues IDs, enforces every rule and state transition, and writes to the ledger.
