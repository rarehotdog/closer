# Demo script v7 — 2:55, one take per scene, every scene in a fresh window

Bottom line of the video: **Model proposes · Code checks · You decide.** Every number spoken is a number on screen at that moment; every label quoted below must be re-read from the screen at the submitted sha before recording (some labels were reworded on Nov 4 night; if a quote here and the screen differ, the screen wins and this file is corrected).

## Rules that keep the recording honest

- One fresh database per take: `CLOSER_MODE=real CLOSER_VISITOR_DAY_USD=3 CLOSER_DB_PATH=.data/take-$(date +%H%M).db npm run live:ui` (mock rehearsal: `CLOSER_DB_PATH=.data/take-$(date +%H%M).db npm run ui`). A re-take never re-registers garments into a wardrobe that is already on camera.
- Scenes 2, 5 and 6 each start in a NEW private window. The sample closet lives in the browser, so a wear recorded in scene 2 would change the counts in scenes 5 and 6 if they shared a window.
- Live or mock is said on screen, never implied: the chip next to the result reads `LIVE · <model> · <ms> ms · 200` or `MOCK · <model>`. If no key is available, scene 3 is cut and the end card carries the mock line (case B). Nothing is faked.
- No key, token or admin screen ever appears. Sign in to the owner wardrobe before recording starts.
- Subtitles quote the screen; narration says what changed for the person first, then what the model and the code did.

## Scenes

| # | Time | Screen | What happens on screen | Narration (outcome first) |
|---|---|---|---|---|
| 1 | 0:00–0:08 | A real jacket on a desk (camera) | — | "I love this jacket and hardly wear it: the outfit around it always feels too dressed-up." |
| 2 | 0:08–0:38 | `/today` (new private window) | Tap the English sentence chip "Keep the navy jacket, make the rest more relaxed." → the "Understood" chip names the navy jacket and the direction → the model chip (`LIVE · muse-spark-1.3 · … · 200` or `MOCK · muse-spark-1.3`) → two outfits with J1 locked → "Wear this" → "Saved · checked against the server · not worn yet" → "I wore this" → "Wear recorded · checked against the server" | "Same jacket, two outfits from clothes I already own, nothing bought. Spark reads my sentence; code checks every piece and every rule, and the jacket stays locked. Picking is not wearing: nothing counts until I confirm." |
| 3 | 0:38–1:05 | `/app`, owner wardrobe, signed in beforehand | Jacket photo → sentence "Keep this jacket. The rest feels too dressed-up." → "Find the pieces" → boxes labelled keep / feels off → masks sweep in → `LIVE · sam-3.1 · … · 200` under "Model calls · N" → cards "Model says: navy · Mask pixels say: navy" → confirm the cards → "Suggest changes" → "Wear this" | "Muse Spark finds each garment; SAM 3.1 cuts it out; code re-measures the colour from the mask pixels and asks me only when they disagree. Nothing is saved until I confirm." (Case B, no key: cut this scene and say on screen "Model calls are mocked in this recording.") |
| 4 | 1:05–1:25 | `/closet/3d?ws=owner` | The jacket card shows the real photo cut out by its mask → exploded-view slider 0 → 100% → tap the jacket → "Add to outfit" for the knit and the chinos → the rest fade → "Wear these today" | "My closet by layer. The jacket hangs as its own cut-out. Same pieces, counts and prices as My closet; the 3D view computes nothing else." |
| 5 | 1:25–2:05 | `/closet` (new private window), window 60 days | J2 beige coat: "No confirmed wear in the last 60 days (wears recorded on N of 60 days)" → "Keep or let go?" → the question with its date → left side: 0 confirmed wears, recorded days vs unknown days, "Wear outlook: not computed" → name one upcoming use → right side: Karrot, the price slider on the sample price (Sample chip visible), the cost line blank → "I would receive: unknown" → type 0 on the cost line → an amount → "Keep" → the saved label with the position id → the history line "Open: 0 confirmed wears since the decision, 0 of 90 days passed" | "One coat, one question with a date, counted facts on both sides, and my position saved. Days without a record stay unknown; a net stays unknown until I checked every cost. There is no probability anywhere, because there is nothing counted to base one on." |
| 5b (if time) | +0:10 | same window | "Prepare to sell" → "Draft a Karrot listing" → "I checked it" → the refusal "Fill every [check] / [확인] part first" | "Closer drafts; I post. It refuses to call a draft reviewed while a placeholder is still in it." |
| 6 | 2:05–2:35 | `/discover` (new private window) | Two target looks → "6 of 8 pieces · 75% · 0 of 2 target looks complete" with the counting line under it → a gap card "adds N complete outfits" → "Wear it with mine (J1 + …)" → `/today` opens with those pieces locked | "Two looks I want; my closet already covers 6 of their 8 pieces, counted piece by piece. The formula is printed next to the number." |
| 7 | 2:35–2:55 | `/version` for 3 s, then the end card | sha and mode on screen → end card | (silent, 20 s) |

Replace every N above with the value the recorded take shows. The 45-of-60 and 6-of-8 numbers come from a fresh sample closet; a closet that already has a wear from scene 2 shows different counts, which is why the windows are separate.

## End card (1920×1080, background #f6f3ee, seven lines)

1. Closer · Keep the piece you love. Change only what feels off, with clothes you already own.
2. Model proposes · Code checks · You decide
3. Built Oct 27–Nov 4 ET by one developer · github.com/rarehotdog/closer · release `<sha7>` (same as /version)
4. Meta Model API: muse-spark-1.3 (Responses API · JSON schema · one function-tool turn) · sam-3.1 (box prompts · official @meta-sam/parser)
5. Case A: "Live model calls in this recording: N · verified Nov 4" — Case B: "This recording runs in mock mode: 0 live calls · adapters unverified"
6. Only counted numbers on screen. Closer never posts a listing, pays, or books a pickup.
7. Track: Indie Developer · Theme: Build for Your World

## Before upload

- README "Current state": replace the recorded-run line with the video link, or delete it.
- Check that `/version` on the deployed link (if any) shows the same sha as the end card.
- Run `node scripts/static_check.ts` after editing this file.
