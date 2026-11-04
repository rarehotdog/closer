# Closer

Closer keeps the piece you want to wear, changes only what feels off or what changed, using clothes you already own, and counts only the wears you confirm.

Track: Indie Developer · Theme: Build for Your World — built for one closet first, in Seoul: Korean and English sentences, Korean resale platforms first and then the international ones, each in its own currency.

- Built Oct 27–Nov 4 ET. Models: `muse-spark-1.3` and `sam-3.1` through the Meta Model API (Responses API), called directly from `adapters/`; `muse-wonder-1.0` reachable through the same adapter layer for the owner's own prompts ([docs/wonder.md](docs/wonder.md)).
- Where things stand (live link, recording, live calls): see [Current state](#current-state).

| Built during the hackathon | Third-party | Pre-existing |
|---|---|---|
| All code and docs in this repository. The first commit is the scaffold only. | Two runtime dependencies: `@meta-sam/parser` 0.1.0 (Meta, SAM License), the official decoder for SAM 3.1 mask payloads, and `three` 0.170.0 (MIT) for the 3D closet view. Dev tools are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). | 0 |

License: [MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Run it (2 minutes)

Needs Node.js 22.18 or newer (built-in TypeScript type stripping and `node:sqlite`); check with `node --version`.

```
npm install
npm run ui        # http://localhost:8787 · mock mode: no key, no network
npm test
```

Then open `/today`, `/closet`, `/closet/3d` and `/discover`; the photo loop is on the Try page (`/try`).

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

Step 6 in detail: Spark 2 chooses among candidates that code built (step 5) and sees mask cut-outs of them; each option shows how many cut-outs it was sent and which IDs it named as a visual match. With `spark2Mode: 'code'` the app runs without it (options from the code solver, labelled "Reason by code"). In the recorded run its choice differed from the code solver's first option in — of — proposals (filled in from the real call ledger once a live run is recorded; blank until then).

You decide at four places: the cards (step 4), the option and the wear (step 7), whether a piece stays or goes (the keep-or-let-go question on My closet), and anything that leaves the app, such as posting a listing or handing a piece over. Closer drafts; you post.

## What it does

- **Today.** The loop above. A laundry, repair or storage button re-plans only that slot, with zero model calls.
- **My closet.** Items registered from the decision photos. The 60-day review lists a piece as "no confirmed wear in N days" only when tracking is complete and at least half of the days have a record; you choose keep, later or exempt. "Look at selling" shows the per-platform prices you entered, never an average, for Korean platforms (KREAM, Karrot, Bunjang, Musinsa Used) and international ones (Poshmark, eBay, Grailed, Depop, StockX, Vinted), each in its own currency; when a cost line is unknown, or no cost line has been checked at all, the net is shown as unknown. Hand-over drafts move DRAFT → REVIEWED → OWNER_REPORTED_DONE and never invent a link.
- **Your closet at a glance.** The top of My closet and the landing page carry the closet ledger: one number per currency — the latest price seen for each piece, added up within that currency — with the pieces it covers next to it ("₩178,000 · latest price seen on 2 of 12 pieces"). Pieces without a price are not counted as zero; sample prices carry a Sample mark and are never added to yours; a net appears only for positions whose cost lines were all checked; wear counts for the last 60 days sit under it. `GET /api/ws/:id/ledger`, `engine/ledger.ts`, tests L-01…L-09.
- **Keep or let go?** One question per piece, written the way an event market writes a contract: "Will I wear J2 (beige coat) in the next 90 days, by 2027-02-02?" Two sides, side by side. *If I keep it*: confirmed wears in the same window, the days that had any record and the days that did not, the last confirmed wear, and the upcoming uses you can name. *If I prepare to sell*: a platform, an asking price you test on a slider (assumed, not offered), the prices seen on that platform with sample rows marked, each cost line as blank, 0 or a value, and the net under those conditions. No probability appears on either side: there is no counted basis for one, so the wear outlook says "not computed", and 0 wears is shown as a count, not a chance. Above both sides, a market-style chart of the prices seen over time: one line per platform in that platform's currency, the latest price large with its change since the first one shown, 30d · 90d · All, traded prices filled and asking prices hollow, sample rows dashed; tapping a point puts its amount into the asking price. You take a position (Keep, Try wearing it once, Prepare to sell, Decide later); it is saved as a snapshot of the screen, read back, saved once per tap, marked "Facts moved" when new wears or prices arrive, and resolved later by counted wear records ("Open: 2 confirmed wears since the decision, 10 of 30 days passed"). Also reachable from any piece in the 3D closet.
- **Discover.** Sample looks by occasion, rebuilt with what you own first; only the pieces you lack become optional cards, with "N more complete outfits" counted on this closet. Pick looks as **style targets**: Closer counts, piece by piece, how much of them your closet already covers ("6 of 8 pieces · 75%") and shows an item box of every piece they ask for (have it / similar / missing). The formula is printed next to the number, and the count moves only when the closet does.
- **Closet in 3D.** `/closet/3d` draws the same pieces by layer in three.js as a white walk-in closet — white lacquer cabinetry, brass rails and hangers, glass towers, lit shelves, a marble island: outerwear rail, tops, bottoms, shoes. Drag to turn it, slide for an exploded view, tap a piece for its confirmed wears, review status and per-platform price evidence. Pick any pieces into an outfit, one per layer; the rest fade back, and "Wear these today" opens Today with them locked. A piece registered from a photo shows that photo cut out by its mask; the owner's wardrobe opens at `/closet/3d?ws=owner`. It shows the same pieces and counts as My closet; the boutique price tags and the asset numbers over its top-left are the closet ledger's, the same ones My closet shows, and the 3D view computes nothing else. Without WebGL it falls back to the same list.

## What Closer does differently

| Closer does | Closer does not |
|---|---|
| Starts from the piece you chose and edits only what feels off | Generate a whole outfit from scratch |
| Counts only wears you confirmed, with the recorded days next to the count | Call a piece unused because records are missing |
| Shows prices per platform in that platform's currency | Average or convert them |
| Shows a net only after you checked every cost line | Count an unknown fee as zero |
| Asks one question per piece with a date, and saves your position as a snapshot | Put a probability or a value on a piece it cannot count |
| Drafts listings and donation checklists | Post, pay, book, or mark anything sold |

## Verify it yourself

1. Open `/w/demo-rc1` and `/version` in a private window and compare the stateHash and sha.
2. Compare `git rev-parse HEAD` of the code you have with the sha on `/version`: they must be the same release.
3. Turn K1 on in `/admin` and check that a button re-plan still works while model calls are off.
4. `/version` shows the mode and the number of live model calls recorded on this server (live calls answered 2xx, counted from the call ledger). On `/app` and `/today`, every live call shows as a chip next to its result; in mock mode the same place shows a grey mock chip.

## Current state

This repository runs in **mock mode** by default: no Meta model is called and no key exists anywhere in the repository. The Meta adapters are written from the documentation examples and stay marked unverified until a live run is recorded in `.data/` on the owner's machine. Status, test results and next steps: [docs/status.md](docs/status.md) · [docs/at_results.md](docs/at_results.md) · [docs/features_1102.md](docs/features_1102.md).

- Live URL: not deployed yet (the kit is in [deploy/](deploy/README.md)).
- Demo video: not recorded yet; the script is [docs/demo_script.md](docs/demo_script.md). `/w/demo-rc1` shows the read-only sample run with its state hash.
- Live model calls recorded in this repository: 0.

| Command | What it does |
|---|---|
| `npm test` | Runs the keyless acceptance tests, unit tests and static checks; writes `docs/at_results.json` and `docs/at_results.md`. |
| `npm run ui` | Starts the local server on http://localhost:8787 (mock mode). Screens: `/` landing, `/try` Try (three sample photos), `/today`, `/closet`, `/closet/3d`, `/discover`, `/w/demo-rc1`, `/admin`, `/version`. |
| `npm run live:check` | Owner's machine only, key read from the Keychain: the model list, one Spark intent call, one Spark 2 call and, with `--image`, one Spark photo call and one SAM call. Every answer goes through the code checks; writes `.data/live_check.json` (statuses, timings, code checks; no text). Never runs inside tests. |
| `npm run screens` | Captures the screens into `docs/screens/` with Playwright Chromium (Playwright is not a project dependency). |
| `npm run typecheck` | `tsc` type check. TypeScript and the Node type definitions are devDependencies, so `npm install` is enough. |
| `npm run wonder -- --prompt "…" [--search] [--image x.jpg]` | Owner's machine only, key read from the Keychain: one direct Muse Wonder call (or Spark with `--model muse-spark-1.3`). `node scripts/wonder.ts --prompt "…"` without the script is a dry run that prints the request and sends nothing. Records statuses, timings, usage and cost in `.data/wonder_calls.jsonl`, never the prompt or the answer. [docs/wonder.md](docs/wonder.md). |

Requires Node.js 22.18 or newer (built-in TypeScript type stripping and `node:sqlite`). Run `npm install` once for the two runtime dependencies and the two type-check tools.

CI: `.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm test` and the static check (`scripts/static_check.ts`) on every push and pull request, on Node 22.18.

Measurement table: `Photos: {n} ({real or AI-generated}), ground truth written before any call` — not measured yet.

## Meta models: where and how

| Step | Model | API feature used | Request builder | Code check before anything is saved |
|---|---|---|---|---|
| Photo + sentence → garment boxes, the kept piece, the pieces that feel off | `muse-spark-1.3` | Responses API, `input_image` as a data URL, `text.format` json_schema strict | `adapters/spark1.ts` | `engine/validate.ts` `validateSpark1` |
| Sentence → locks, direction, rain | `muse-spark-1.3` | json_schema whose `keep` enum is the wardrobe's own item IDs | `adapters/intent.ts` | `engine/intent.ts` `checkIntent` |
| Garment boxes → masks | `sam-3.1` | box prompts (at most 16) built with the official parser's prompt builder, non-streamed; masks decoded by `@meta-sam/parser` | `adapters/sam.ts`, `engine/coords.ts`, `adapters/samDecoder.ts` | `validateSam` (frame, ids, a small mask tolerance) and `engine/color.ts` `maskColor` re-measuring the colour from the mask pixels |
| Candidates → at most two edits | `muse-spark-1.3` | function tools `propose_edit` / `ask_owner`, strict, `parallel_tool_calls: false`, `tool_choice` omitted, up to 8 PNG cut-outs | `adapters/spark2.ts` | `validateSpark2` (IDs, slots, rules; the locked piece never moves) |
| The owner's own prompt, optional | `muse-wonder-1.0` (or `muse-spark-1.3` by flag) | text, images, json_schema, function tools, `web_search` grounding with `url_citation` annotations, `previous_response_id` | `adapters/wonder.ts` · `scripts/wonder.ts` · `POST /api/ws/:id/wonder` | caps and the kill switch in `CloserService.askWonder`; `engine/links.ts` sorts cited links by platform and reads no price from any page |

Muse Wonder is in preview and, per dev.meta.ai/docs/models (read 2026-11-04), not available in South Korea on the Model API; every Wonder request runs unchanged on Spark with the model flag. Live calls recorded in this repository: 0 (the line above is updated from `.data/live_check.json` when the owner runs `npm run live:check`).

## Known limits

- The demo closet is a sample closet with code-drawn sample photos, marked as such on screen. One real-photo path exists for the owner workspace and needs the owner token in real mode.
- Prices, fees and shop links are what you entered. Closer checks no stock, fills no cart and pays nothing.
- "No confirmed wear" needs records. Without enough of them the review says so instead of guessing.
- The keep-or-let-go screen shows no probability and no expected value. A position is resolved only by wear records you confirm afterwards; days with no record stay unknown, so a closed question reads "1 confirmed wear in the 30 days after the decision", never "you did not wear it".
- Spend caps: $20 for the whole app (`CLOSER_APP_TOTAL_USD` raises it), $0.25 per visitor copy (each Try fork and each sample closet, counted across restarts from the call rows), one per-day cap for all visitor copies together (0 unless `CLOSER_VISITOR_DAY_USD` is set; `npm run live:ui` and the deploy kit set 3; $0 from 2026-11-19 KST whatever is set), and the K1 kill switch. The owner's own wardrobe counts toward the app total only.
- AT-28's pin-rule mutant is caught on the next-plan path (a second outer seeded: J1 is swapped without the rule, kept with it) and by AT-21, not by the pre-registered AT-03/06/19: in FX-H the kept piece J1 sits outside the offender slots, so the offender-scope rule alone keeps it there and those three cannot tell the two rules apart. The test says so in its name rather than hiding it.

## Data

- **Stored, on your server only.** One SQLite file (`CLOSER_DB_PATH`, default `.data/closer.db`; the deploy kit uses `/var/lib/closer/closer.db`) holds the workspaces, events, items, availability, plans, wear rows, run records, the call ledger (model, HTTP status, latency, token counts and cost per call; never a photo or a sentence), the flags, and the side tables for review choices, exemptions, price evidence, hand-over drafts, style targets and keep-or-let-go positions. Uploaded photos sit next to it in `photos/`: the JPEG copy that goes to the models, a smaller PNG for pixel work, and one JSON line of size and date. The browser re-encodes a photo through a canvas before upload, and the server strips the APP1 (Exif, XMP), APP13 (IPTC) and comment segments again before writing (`store/photos.ts`). The owner token lives in the browser tab's sessionStorage only. No account, no analytics, no third-party script: the page loads only files from this server, including the vendored three.js.
- **What leaves the server.** In real mode, a photo reading sends the photo and your sentence to the Meta Model API: the photo once to `muse-spark-1.3` and once to `sam-3.1`, and mask cut-outs of it (long side ≤ 256 px) once to the edit step on `muse-spark-1.3`; a sentence on Today sends the sentence and your item list. Every one of these requests carries `store: false` (`adapters/spark1.ts`, `adapters/sam.ts`, `adapters/spark2.ts`, `adapters/intent.ts`). A request answered 429, 500 or 503 is sent again at most twice with the same content. Nothing else is sent anywhere. In mock mode nothing leaves the machine.
- **Deleting.** Each uploaded photo has a "Delete this photo" button on My wardrobe; it removes the JPEG, the PNG and the metadata line at once. Try workspaces (kind `visitor`) are removed 24 hours after creation, with every row keyed by them, at startup and hourly; their call-ledger rows stay because the spend caps count them. The sample-closet copy that `/closet` makes per browser, the recorded run and the owner wardrobe are not removed by code: delete their rows by hand in the SQLite file (`workspace_id` in every table) and their files in `photos/`.

## What comes next (not built)

- Import your order history as a file you export yourself, so each piece carries what you paid and when.
- What each piece would leave in your hand on each platform, in the closet ledger itself (today the ledger shows a net only for positions you saved with every cost line checked).
- Resale evidence from official platform APIs where they exist; otherwise a screenshot you paste. Never averaged across platforms.
- Donation points near you from a public directory, using your location only when you allow it.
- A 3D model per garment from a photo, with SAM 3D Objects, only for pieces whose front is visible in the photo. Hidden pieces stay as cards.

## FAQ

- **How is this different from a closet catalog?** It edits only the pieces that feel off in the outfit you photographed to decide, the decision photo is also how items get registered, and a selection or wear counts only after it is read back.
- **Does it buy anything or contact shops?** No. Next: a read-only check a shopping client could call before checkout. Not built.
- **What does the model decide, and what does code decide?** Models read the photo and sentence, draw masks, and choose among candidates code passed. Code issues IDs, enforces every rule and state transition, and writes to the ledger.
