# Three features added 11/2

Built on top of the 10/30 scaffold. Mock mode, sample data, no external calls.

## The loop

One wardrobe and one ledger serve three screens. The tab bar shows on phones.

| Screen | Owner's words | What code does | What the owner decides |
|---|---|---|---|
| **Today** `/today` | "I want to wear this jacket today" | Locks the tapped pieces and completes the other slots from owned, available items. Shows at most two options: fewest changes, and closest to the stated direction. A laundry change re-plans only the other slots. | What to keep, which option to wear, and whether it was actually worn |
| **My closet** `/closet` | "Find what I haven't worn in 60 days, show KREAM / Karrot / Poshmark prices, and connect me to selling or donating" | Lists pieces with no confirmed wear in the window, and shows how many days have any record at all. Shows one price card per platform. Writes listing and donation drafts. | Wear it again, keep it, check repair, look at selling, or look at donating. Posting and handing over are done by the owner, outside the app |
| **Discover** `/discover` | "Browse wedding-guest and workout looks and buy the same" | Rebuilds a look from owned pieces first. Each missing piece shows how many more complete outfits the closet gets if it is added. | Use my own piece, skip, later, or open a link. Buying the whole look is a separate list |

**Links between screens**
- The 60-day review's *Wear it again* opens Today with that piece locked.
- A look's *Wear it with mine* opens Today with the rebuilt pieces locked.
- When Today has no item for a slot, it points to Discover.

**Sample closet walk-through**
1. J1, a navy jacket, has no confirmed wear in 60 days. Wear was recorded on 45 of those 60 days.
2. The wedding-guest look rebuilds 3 of 4 pieces from the closet, J1 among them.
3. Tapping *Wear it with mine* locks J1, T1 and B1 on Today, and the owner picks shoes.

## Honesty rules (each one is a test in `tests/features.test.ts`)

**Wear records**
- "No confirmed wear in N days" is reported only when both hold:
  - the item has been tracked for the whole window;
  - at least half of the window's days have some wear record.
- Otherwise the item is shown as *too few records*. No line says the item went unused.

**Prices**
- Each platform has its own card.
- Asking and traded prices are labelled.
- Prices are never averaged and currencies are never converted.
- Sample rows carry a *Sample* chip.
- A fee with an unknown value makes the net *unknown*; it is never counted as zero.

**Drafts**
- A listing draft keeps `[check]` / `[확인]` placeholders.
- It cannot be marked *reviewed* until every placeholder is filled.
- There is no SOLD or DONATED state. The owner can only report "I posted it" or "I handed it over" themselves.
- Donation text states that Closer does not confirm acceptance, pickup, receipts or tax benefits.

**Looks**
- Looks are drawn for the demo; no scraped photos and no real people.
- No product link or price is invented. Links stay empty until someone has checked a real page.
- *Outfits added* is a count on this closet (top, bottom and shoes, outer optional, formality within one step), not an estimate.

**Locks**
- A locked piece that breaks a rule (rain with a non-waterproof jacket) or is unavailable becomes a question. It is never silently swapped.

## Web or app

**Answer: phone-first web, used from a link.** Sol, Leo, Instinct and Antigravity reached the same conclusion on 11/1.

- **Judges can open it.** Judges open a link and a video. They do not install apps, and app-store review timing does not fit the 11/5 deadline.
- **It fits the work.** Every flow here is tapping, cards and short text, which the web covers. The owner can add it to the home screen later; the demo must work without that step.
- **Keys stay safe.** Model keys stay on the server.
- **When to go native.** Only if repeated real use shows a measured web limit, such as camera capture, share-sheet import or reminders. Glasses capture (Wearables toolkit) needs a native companion app, so it is out of this submission.

## Where the Meta model fits (real mode, after the key window)

- **Spark 1:** turns a free sentence ("this jacket, something relaxed, it may rain") into locks, direction and rain. Today the owner taps instead.
- **Spark 2:** writes the reason lines for options that code has already checked.
- **SAM:** cuts each garment out of a photo for registration, as in the existing photo flow.
- **Not the model's job:** prices, wear history, availability, the 60-day count, and anything outside the app.

## Sentence path on Today (added 11/2 afternoon)

The owner can type a sentence, for example "오늘 이 네이비 재킷 입을 건데 좀 편하게" or "Keep the navy jacket, more relaxed".

**How a sentence is handled**
1. **Spark reads it.** It returns `keep` (item IDs), `direction` and `rain`, using structured output. The schema only allows item IDs that code sent.
2. **Code checks the answer.** It rejects any ID not in the wardrobe. If one phrase could match two items, it asks which one instead of guessing.
3. **The same planner runs** as for tapped pieces.

**Limits**
- Mock mode reads the sentence with keyword rules and labels it "(mock)".
- In real mode, public sample closets accept only the four example sentences. They are charged against the visitor cap.

**Two options when there is no previous plan:**
- "A gentler step": the smallest move in the asked direction.
- "Closer to what you said": the strongest move.

Pieces that are likely out of season rank lower.

**Rules vs model.** `node scripts/intent_ablation.ts` runs 12 hand-checked sentences.
- The keyword rules alone get 9 of 12. They misread "트랙 재킷이랑 반바지", miss "너무 꾸민 느낌은 싫어", and pick a jacket for "the jacket" instead of asking.
- With `--live` and a key, the Spark arm runs on the same sentences.

## First live run (owner's machine, owner's key)

```
node scripts/live_check.ts                    # dry run: shows the plan, sends nothing
read -s MODEL_API_KEY && export MODEL_API_KEY # the key stays out of shell history
node scripts/live_check.ts --live             # GET /models + one Spark intent call (≈ $0.004)
node scripts/live_check.ts --live --image ./outfit.jpg   # also Spark photo + SAM (≈ $0.04, long side ≤ 1600 px)
node scripts/intent_ablation.ts --live        # 12 Spark calls (≈ $0.05)
```

**What the scripts save.** Each one writes `.data/live_check.json` or `.data/intent_ablation.json`. These files hold only statuses, timings, counts and code-check results; there is no key and no raw model text. Share those files, not the terminal.

## Run

```
npm test          # 88 tests: 78 pass, 1 fail (AT-28, plan gap), 9 skipped (need keys or a deploy)
npm run ui        # http://localhost:8787/today · /closet · /discover
```

Each visitor gets a private copy of the sample closet: 12 sample items and a synthetic 75-day wear history.

## Changed for safety on 11/2

- **Owner access.** In real mode the owner's wardrobe (`real` workspace) needs the owner token (`CLOSER_ADMIN_TOKEN`) for reads and writes. The public Try page reads a visitor banner, not the owner's ledger.
- **Demo clock.** It moves only in local mock mode or with the admin token.
- **Missing usage.** A model response with no usage is charged at the estimate, not zero, so the caps cannot fail open.
- **Person-name list.** It is no longer stored in the repository, not even as hashes. Each machine keeps an untracked `.closer/deny-names.json`. Without it, the AT-18 name check prints a note that it did not run.
- **History cleanup.** The earlier local history was rewritten to drop the hashes and two lines about owner-side approvals. The repository has never been pushed.

## Real photo path (added 11/2 evening)

- **Upload (owner only).** The upload button on /app opens the camera or the photo library. The browser draws the photo on a canvas and sends two copies: a JPEG with a long side of at most 1600 px, which goes to Spark and SAM, and a PNG of at most 800 px, which is used for pixel work. Re-encoding drops EXIF and location data.
- **Storage.** The server keeps both copies next to the database (`photos/`). They never go in the repository. An uploaded photo can be used only in the wardrobe it was uploaded to, and the owner can delete it.
- **SAM masks.** Masks are decoded with Meta's official client library (`@meta-sam/parser`). A test decodes the docs' own example mask. The SAM request asks for `one_bit` masks.
- **Spark 2 cut-outs.** Spark 2 receives up to 8 mask cut-outs (long side 256 px, transparent outside the mask) for items registered from a photo, so the model sees the garment, not the room.
- **Own sentence.** The owner can write their own sentence for a photo. Visitors still pick fixed sentences.
- **Owner sign-in.** /app and /admin have a token field. The token stays in that browser tab and is sent as a header.
- **Banner wording.** The banner says "about N photo runs left in the cap" instead of "calls left today", because the cap is a total, not a daily limit.
- **Checked.** 95 tests run: 85 pass, 1 fails (AT-28) and 9 are skipped. A real-mode server with a fake key returned 403 without the token and 200 with it, and refused visitor uploads. A synthetic photo uploaded at 1500×2000 was stored at 1200×1600, with no key in the logs.
- **Not checked.** A live Spark and SAM run on a real photo, which needs the key.

## Net amount calculator (My closet → Look at selling)

- **Inputs.** The owner picks a platform and a price. They can type the price or tap a price they saw, which carries its asking, traded or sample label. They then fill in the fees from the platform's own page. Each fee is either a percentage of the price or a fixed amount.
- **Unknown fees.** A blank fee means it has not been checked, and the result says "unknown". A fee counts as zero only if the owner typed 0.
- **Fee names to start from.** The calculator offers fee names such as KREAM's sales fee and inspection, or Poshmark's platform fee and shipping. It never fills in their values.
- **Result.** It shows the price, each deduction, the fees not yet checked, and the amount the owner would receive. The line "Not a guarantee" stays on.
- **Use in drafts.** Once the net is known, a draft for the same platform uses that price.
- **Checks.** The server rejects a missing name, a negative value, a rate above 100%, more than 10 lines and unknown platforms (tests F2-16 and F2-17).
