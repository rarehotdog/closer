# Closer · Rail Studio

This is the port-3200 interface imported from `rarehotdog/closerdesign`, branch
`meta-live-v2`, commit `7dec1d08409befd162651800b8815222a9ac4b01`.
The import preserves that app's behavior and adds small wordmark and hang-tag
refinements: a gentler tag angle, a 44px minimum target, selected-state styling
and a visible keyboard focus ring. This directory is a post-submission addition.

It runs independently from the original Closer app at the repository root.
Confirmed photo-scan pieces and their decisions stay in this browser's localStorage;
changes to the sample closet reset on reload. Root-app
accounts, SQLite records, and the other development branches are not integrated
here. A live Meta scan from this interface has not been verified.

One photo of your outfit (or your closet) becomes garments you can count and act on. The face is a 3D boutique rail of real photo cut-outs; the work happens in one inspector; the numbers come from records you can see. Built for the Meta Global AI Developer Hackathon; the submitted engine lives in [rarehotdog/closer](https://github.com/rarehotdog/closer), and this app reuses its photo pipeline.

## What it does

- **Photo → cards → rail.** `Upload Photo & Hang` (or `?scan=1`) sends one JPEG to this app's own server, which calls **muse-spark-1.3** (one box per garment, the piece to keep, the direction, the pieces that feel off) and **sam-3.1** (one mask per box) through the Meta Model API, checks both answers in code, measures each colour from the mask pixels and returns cut-out cards. You confirm; the pieces hang on the rail and stay in this browser. Closet mode reads up to 16 garments from one photo of a rail or closet and can scan the rest in two overlapping parts.
- **The face.** The full-bleed 3D rail with real cut-outs and the Walk-In Vault, one known-range line on the plaque ("₩X · N of M pieces"), hang tags whose shape says what is known (solid with a price seen · dashed "No price seen" · hollow dot for "No wear log" · "0 wears · 60d").
- **The inspector.** Pick a piece anywhere and the same panel opens: photo, status chips, purchase info, wear record, prices seen, net if sold (only with every cost line ticked), and the decision pinned at the bottom (Keep · Prepare to sell · Decide later). Phone: a bottom sheet.
- **Review (wide).** Candidates (Sell and Undecided) side by side with the price-over-time chart and a per-currency sum of net-if-sold for the rows whose fees are checked.
- **Grid.** Every piece as a flat card with the same facts; it takes the stage when WebGL is unavailable, and it is one tap away otherwise.

## What it never does

No probability, estimate or recommendation: counted numbers with their denominators, or "not computed". Currencies are never mixed or converted; Sample is never added to owner totals; a net appears only when every cost line is ticked; a model's name appears only where a call happens (the local test fake is labelled "Test fake · no Meta call"). Nothing is posted, paid or sent. The Meta key stays on the server.

## Run

```
npm ci                 # from this directory; Node.js 22.18 or newer
PORT=3200 npm run dev   # Express + Vite; choose an unused port
npm run build && npm start   # production (dist/ + server.js)
npm test               # scan pipeline, routes, tiles, ledger logic
npm run lint           # tsc --noEmit
```

The production server defaults to port 3000; `PORT=3202 npm start` overrides it.
Keep `src/assets/` alongside `dist/` and `server.js`, since the server also serves
the eight bundled garment photographs. For local review with model calls disabled,
use `CLOSER_KILL=1`. Never expose a key-enabled development server publicly.

The optional browser smoke script needs a separately installed Playwright and
Chromium: `BASE=http://localhost:3200 node scripts/browser_check.cjs`.
It writes screenshots under `.data/shots`; these are not committed.

Server modes (`GET /api/scan/status`): `live` with a key (`MODEL_API_KEY` or `META_API_KEY` in the server environment; in AI Studio, Settings → Secrets), `fake` only with `CLOSER_SCAN_FAKE=1` and no key (a local stand-in for development, labelled on screen), `no_key`, `off` with `CLOSER_KILL=1`. Spend cap per process `CLOSER_SCAN_BUDGET_USD` (default 2). One real scan to check a key: `MODEL_API_KEY=… npm run live:scan` (prints statuses, timings and counts only; never the key or model text). Details: [server/README.md](server/README.md).

## Status (2026-11-05)

Verified in this repository: the scan pipeline and routes with the test fake (tests, type check, build), the screens at 1440×900 and 390×844 with 0 console errors and 0 horizontal overflow. **Not yet verified here: a live Meta call from this app** (no key in the build environment); the engine repository's own live run on Nov 5 is recorded in its `docs/live/live_check.json`. The design (commit `ea9f3b8`) is by the project's designer; the sample closet and its prices are sample data, labelled Sample.

## Layout of the code

- `server.ts` — Express app: static files, `POST /api/scan`, `GET /api/scan/status`, guards.
- `server/scan.ts`, `server/closetSpark.ts` — photo → cards (outfit and closet modes); `server/closer/` is the trimmed copy of the engine's adapters and checks; `server/fakeMeta.ts` the test fake.
- `src/App.tsx` — the face (rail / vault / grid), the inspector, the modals, the scan flow.
- `src/components/` — `BoutiqueRail3D` (three.js), `ClosetGrid`, `GarmentInspectDrawer`, `ScanPhotoModal`, `ReviewMode`, `KalshiPriceChart`, `ModalsAndViews`.
- `src/utils/` — `ledgerLogic` (counts, net, sums), `tiles` (closet photo in parts), `review`.

Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (`@meta-sam/parser` under the SAM License).
