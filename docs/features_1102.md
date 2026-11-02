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

## Run

```
npm test          # 79 tests: 69 pass, 1 fail (AT-28, plan gap), 9 skipped (need keys or a deploy)
npm run ui        # http://localhost:8787/today · /closet · /discover
```

Each visitor gets a private copy of the sample closet: 12 sample items and a synthetic 75-day wear history.

## Changed for safety on 11/2

- **Owner access.** In real mode the owner's wardrobe (`real` workspace) needs the owner token (`CLOSER_ADMIN_TOKEN`) for reads and writes. The public Try page reads a visitor banner, not the owner's ledger.
- **Demo clock.** It moves only in local mock mode or with the admin token.
- **Missing usage.** A model response with no usage is charged at the estimate, not zero, so the caps cannot fail open.
- **Person-name list.** It is no longer stored in the repository, not even as hashes. Each machine keeps an untracked `.closer/deny-names.json`. Without it, the AT-18 name check prints a note that it did not run.
- **History cleanup.** The earlier local history was rewritten to drop the hashes and two lines about owner-side approvals. The repository has never been pushed.
